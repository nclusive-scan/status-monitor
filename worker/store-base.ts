// The monitor store's base layer (store.ts): SQL access, meta values, component state, incident reads, the incident
// timeline, escalation transitions with the outbox rows they queue, group lookups and per-contact delivery health.
// MonitorStore builds on it through StoreRecords and OutboxStore; members a later layer uses are protected.
import type { EscalationPolicy } from "./config.ts";
import type { RandomSource } from "./crypto.ts";
import type { ComponentState } from "./engine.ts";
import { initialComponentState } from "./engine.ts";
import type { Transition } from "./escalation.ts";
import type { SqlRow, StorageLike } from "./schema.ts";
import { migrate, nullableNum, nullableText, num, text } from "./schema.ts";
import { isStatus } from "./types.ts";
import type { ContactHealthRow, ContactHealthState, EventFields, IncidentRow } from "./store-rows.ts";
import { ACTION_KINDS_SQL, CONTACT_HEALTH_STATES, incidentFrom } from "./store-rows.ts";

/** Hand-overs followed when resolving an incident's carrier (each flip away from page adds at most one). */
const MAX_HANDOVER_HOPS = 16;

export class StoreBase {
  protected readonly storage: StorageLike;
  protected readonly random: RandomSource;

  constructor(storage: StorageLike, random: RandomSource) {
    this.storage = storage;
    this.random = random;
    this.storage.transactionSync(() => migrate(this.storage.sql));
  }

  protected rows(query: string, ...bindings: (string | number | null)[]): SqlRow[] {
    return this.storage.sql.exec(query, ...bindings).toArray();
  }

  getMeta(key: string): string | null {
    return nullableText(this.rows("SELECT value FROM meta WHERE key = ?", key)[0], "value");
  }

  setMeta(key: string, value: string): void {
    this.rows("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  component(id: string): ComponentState {
    const row = this.rows("SELECT * FROM components WHERE id = ?", id)[0];
    if (row === undefined) return initialComponentState(id);
    const status = text(row, "status");
    return {
      id, status: isStatus(status) ? status : "unknown", consecutiveFailures: num(row, "consecutive_failures"),
      consecutivePasses: num(row, "consecutive_passes"), openIncidentId: nullableText(row, "open_incident_id"), since: nullableNum(row, "since"),
      lastObservedAt: nullableNum(row, "last_observed_at"), recent: text(row, "recent"),
    };
  }

  components(): ComponentState[] {
    return this.rows("SELECT id FROM components ORDER BY id").map((row) => this.component(text(row, "id")));
  }

  protected saveComponent(state: ComponentState): void {
    this.rows(
      `INSERT INTO components (id, status, consecutive_failures, consecutive_passes, open_incident_id, since, last_observed_at, recent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status,
       consecutive_failures = excluded.consecutive_failures, consecutive_passes = excluded.consecutive_passes,
       open_incident_id = excluded.open_incident_id, since = excluded.since, last_observed_at = excluded.last_observed_at,
       recent = excluded.recent`,
      state.id, state.status, state.consecutiveFailures, state.consecutivePasses, state.openIncidentId, state.since, state.lastObservedAt,
      state.recent,
    );
  }

  incident(id: string): IncidentRow | null {
    const row = this.rows("SELECT * FROM incidents WHERE id = ?", id)[0];
    return row === undefined ? null : incidentFrom(row);
  }

  openIncidentByCode(code: string): IncidentRow | null {
    const row = this.rows("SELECT * FROM incidents WHERE ack_code = ? AND resolved_at IS NULL ORDER BY opened_at DESC LIMIT 1", code)[0];
    return row === undefined ? null : incidentFrom(row);
  }

  protected event(incidentId: string, at: number, type: string, detail: string, fields: EventFields = {}): void {
    this.rows(
      "INSERT INTO incident_events (incident_id, at, type, detail, tier_id, contact_id, channel, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      incidentId, at, type, detail.slice(0, 200), fields.tierId ?? null, fields.contactId ?? null, fields.channel ?? null, fields.code?.slice(0, 64) ?? null,
    );
  }

  /**
   * Asks for a report at the next run (an applied revision, contact health or a resolved incident changed). A counter,
   * not a flag: a change made while a report is in flight (the platform POST runs between prepareReport and reportSent)
   * bumps it past the value that report was built at, so the report's success does not swallow the change.
   */
  markReportDue(): void {
    this.setMeta("report_due_seq", String(this.reportSeq() + 1));
  }

  /** The report-due counter now: prepareReport hands it out with the body, and recordReportSent records it as sent. */
  reportSeq(): number {
    return Number(this.getMeta("report_due_seq") ?? "0");
  }

  /**
   * Persists a transition and queues its sends. Recipients are resolved from the policy now, for an accurate log.
   * `reason` replaces the archived "escalated" entry's code when a step was taken early (esc_requested,
   * all_channels_failed) rather than at the tier's deadline.
   */
  protected applyTransition(
    incidentId: string,
    transition: Transition,
    policy: EscalationPolicy,
    now: number,
    previousSteps: readonly string[] = [],
    reason: string | null = null,
  ): void {
    const state = transition.state;
    this.rows(
      `UPDATE incidents SET phase = ?, acknowledged_at = ?, acknowledged_by = ?, resolved_at = ?, next_alarm_at = ?, escalation = ? WHERE id = ?`,
      state.phase, state.acknowledgedAt, state.acknowledgedBy, state.resolvedAt, transition.nextAlarmAt, JSON.stringify(state), incidentId,
    );
    const contacts = new Map(policy.tiers.flatMap((tier) => tier.contacts.map((contact) => [contact.id, contact] as const)));
    for (const send of transition.sends) {
      const contact = contacts.get(send.contactId);
      const recipient = send.channel === "sms" ? contact?.sms : contact?.email;
      if (contact === undefined || recipient === null || recipient === undefined) continue;
      this.rows(
        `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
         attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        send.key, incidentId, send.kind, contact.id, contact.name, send.channel, recipient, send.tierId, send.cycle,
        JSON.stringify({ target: send.target, acknowledgedBy: send.acknowledgedBy }), now, now,
      );
    }
    const steps = new Set(transition.sends.map((send) => `${send.kind}:${send.tierId ?? "-"}:c${String(send.cycle)}`));
    for (const step of steps) this.event(incidentId, now, "notify", step);
    // The archived timeline: a later tier (or cycle) paged, paging exhausted, a reminder.
    const before = new Set(previousSteps);
    for (const step of transition.state.steps.filter((id) => !before.has(id))) {
      const page = /^page-c(\d+)-t(\d+)$/.exec(step);
      if (page !== null && !(page[1] === "1" && page[2] === "0")) {
        const tier = policy.tiers[Number(page[2])];
        this.event(incidentId, now, "escalated", step, { tierId: tier?.id ?? null, code: reason ?? `cycle_${page[1] ?? "1"}` });
      } else if (step === "exhausted") {
        this.event(incidentId, now, "escalated", reason === null ? "paging stopped" : `paging stopped (${reason})`, { code: "exhausted" });
      }
      else if (step.startsWith("reminder-")) this.event(incidentId, now, "reminded", step);
    }
  }

  /** The open incident that carries a group's escalation (members have phase "grouped"), or null when none is open. */
  groupCarrier(groupId: string): IncidentRow | null {
    const row = this.rows(
      "SELECT * FROM incidents WHERE group_id = ? AND resolved_at IS NULL AND phase != 'grouped' ORDER BY opened_at, id LIMIT 1", groupId,
    )[0];
    return row === undefined ? null : incidentFrom(row);
  }

  /**
   * The carrier for this incident's pages: its own group's, or, once its component stopped paging and it handed its
   * escalation to a group member (changeAlertMode), that member's group's. Its earlier pages (ack links already
   * delivered, sent and failed outbox rows) keep its id, and must still reach whoever carries the group now.
   */
  carrierFor(incident: IncidentRow): IncidentRow | null {
    let current = incident;
    for (let hop = 0; hop < MAX_HANDOVER_HOPS && current.alertMode !== "page" && current.handedOverTo !== null; hop += 1) {
      const next = this.incident(current.handedOverTo);
      if (next === null) break;
      current = next;
    }
    return this.groupCarrier(current.groupId);
  }

  /** Component ids of the other open incidents in the incident's group. */
  alsoAffected(incident: IncidentRow): string[] {
    return this.rows(
      "SELECT component_id FROM incidents WHERE group_id = ? AND id != ? AND resolved_at IS NULL ORDER BY opened_at, id", incident.groupId, incident.id,
    ).map((row) => text(row, "component_id"));
  }

  protected cancelPendingActions(scope: { readonly incidentId: string } | { readonly groupId: string }, at: number, eventIncidentId: string): void {
    const cancelled = "incidentId" in scope
      ? this.rows(
        `UPDATE outbox SET status = 'cancelled', claim_until = NULL WHERE status = 'pending' AND kind IN (${ACTION_KINDS_SQL}) AND incident_id = ?
         RETURNING key`, scope.incidentId,
      )
      : this.rows(
        `UPDATE outbox SET status = 'cancelled', claim_until = NULL WHERE status = 'pending' AND kind IN (${ACTION_KINDS_SQL})
         AND incident_id IN (SELECT id FROM incidents WHERE group_id = ?) RETURNING key`, scope.groupId,
      );
    if (cancelled.length > 0) this.event(eventIncidentId, at, "notify", `cancelled ${String(cancelled.length)} pending`);
  }

  /** Sets one contact channel's delivery health; a change of state asks for a report. True when the state changed. */
  setContactHealth(contactId: string, channel: "sms" | "email", state: ContactHealthState, code: string | null, now: number): boolean {
    const current = this.rows("SELECT state FROM contact_health WHERE contact_id = ? AND channel = ?", contactId, channel)[0];
    if (current !== undefined && text(current, "state") === state) {
      this.rows("UPDATE contact_health SET code = ?, updated_at = ? WHERE contact_id = ? AND channel = ?", code, now, contactId, channel);
      return false;
    }
    // A channel that never had a problem has no row; "ok" for it changes nothing.
    if (current === undefined && state === "ok") return false;
    this.rows(
      `INSERT INTO contact_health (contact_id, channel, state, code, since, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (contact_id, channel) DO UPDATE SET state = excluded.state, code = excluded.code, since = excluded.since,
       updated_at = excluded.updated_at`,
      contactId, channel, state, code, now, now,
    );
    this.markReportDue();
    return true;
  }

  /** One contact channel's health state ("ok" when it never had a problem). */
  contactHealthState(contactId: string, channel: "sms" | "email"): ContactHealthState {
    const state = nullableText(this.rows("SELECT state FROM contact_health WHERE contact_id = ? AND channel = ?", contactId, channel)[0], "state");
    return CONTACT_HEALTH_STATES.find((item) => item === state) ?? "ok";
  }

  /** Every recorded contact channel (a contact with no row has never had a problem). */
  contactHealth(): ContactHealthRow[] {
    return this.rows("SELECT * FROM contact_health ORDER BY contact_id, channel").map((row) => {
      const state = text(row, "state");
      return {
        contactId: text(row, "contact_id"), channel: text(row, "channel") === "email" ? "email" : "sms",
        state: CONTACT_HEALTH_STATES.find((item) => item === state) ?? "ok", code: nullableText(row, "code"), since: num(row, "since"),
      };
    });
  }
}
