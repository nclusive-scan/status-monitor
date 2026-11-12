// Persistent state of the monitor (one SQLite-backed Durable Object): run history, component state, incidents with
// their escalation state, and the notification outbox. Every state change and the outbox rows it produces are written
// in one synchronous transaction, so an alarm retried after a crash replays against the committed state and the
// outbox key (INSERT OR IGNORE) keeps each send at most once. Delivery itself happens outside, in the object.
//
// Incidents that open while another is still paging unacknowledged (within GROUP_WINDOW_MS of it) join its group: one
// escalation, one ACK code and one set of messages for a fleet-wide outage instead of one per component. The group's
// carrier pages; members show on the status page and close quietly. When the carrier recovers first, the oldest open
// member takes over its escalation state, so paging continues where it was and the code people hold still works.
// Only paging incidents group: an incident of a component with alert "email" or "none" is always its own group, so an
// email-only incident never starts, joins or carries a page (email-alert.ts). When a component's alert setting
// changes while its incident is open, the incident follows the new setting at the next run (changeAlertMode).
//
// It also keeps the last-known-good platform configuration (platform_config, one row) and the pull's status (meta).
// A config-change notice is an outbox row of kind "config_change" with no incident behind it (incident_id
// "cfg_r<revision>"), so it is retried, logged and pruned like every other send. An accepted revision also re-points
// the incident sends still waiting in the outbox at the new contacts (reconcileRecipients).
//
// It also holds: the weekly drill (an incident row with drill = 1 that pages one contact and never escalates),
// maintenance suppression (failures counted, no incident opened), acknowledgement attribution by contact id and
// channel, structured timeline events for the platform's incident archive, per-contact delivery health
// (contact_health), the report bookkeeping (report_due_seq, exported_at) and retention that keeps unexported incidents.
//
// Delivery hardening: a send that fails for good (synchronously, or later in a Twilio status callback)
// updates the contact's health, fails over to the contact's other channel while the incident still needs someone, and
// when every channel of every contact in the tier being paged has failed for a reason about the contact, escalates to
// the next tier at once (never all the way to "exhausted": that last step waits for the tier's deadline). An
// account-level email failure alerts the first tier by SMS (unless the failed email was an email-only alert, which never
// leads to an SMS), an account-level SMS failure alerts it by email (each hourly at most per code). SMS replies are rate
// limited per contact. A Twilio status callback that arrives before the send's message SID is recorded (it can: the
// callback may beat the end of the API response) is kept in early_status and applied when markSent records that SID.
//
// The class is layered to keep each file readable: store-rows.ts (constants, row types and readers), store-base.ts
// (SQL, meta, component state, transitions), store-records.ts (platform config, report, retention, read views),
// store-outbox.ts (sends and their failures), and this file (incident lifecycle: runs, grouping, acks, drills).
import type { AlertMode, ComponentConfig, EscalationPolicy, TargetsConfig } from "./config.ts";
import { randomCode, randomHex } from "./crypto.ts";
import { drillPolicy, dueDrillSlot, nextDrillContact } from "./drill.ts";
import { firstTierEmailContacts, UNPAGED_PHASE } from "./email-alert.ts";
import type { MaintenanceWindow } from "./maintenance.ts";
import { activeWindow } from "./maintenance.ts";
import { isFailing, stepComponent } from "./engine.ts";
import type { EscalationState } from "./escalation.ts";
import { nextAlarmAt, startEscalation, stepEscalation } from "./escalation.ts";
import { num, text } from "./schema.ts";
import type { CheckResult, Status } from "./types.ts";
import type { AckBy, AckOutcome, EscalateOutcome, IncidentRow } from "./store-rows.ts";
import { ACTION_KINDS_SQL, channelOf, GROUP_WINDOW_MS, HOUR, incidentFrom } from "./store-rows.ts";
import { OutboxStore } from "./store-outbox.ts";

export class MonitorStore extends OutboxStore {
  private openIncident(component: Pick<ComponentConfig, "id" | "name" | "alert">, status: Status, detail: string, policy: EscalationPolicy,
    now: number): string {
    const componentId = component.id;
    const id = `inc_${now.toString(36)}_${randomHex(this.random, 4)}`;
    // The title is public: the component's public name and the severity only. The detail code stays in the event log.
    const title = `${component.name} ${status === "down" ? "is down" : "is degraded"}`.slice(0, 120);
    if (component.alert !== "page") {
      // Its own group, no escalation state and no ACK code (none is sent, and an empty code never matches a reply).
      this.rows(
        `INSERT INTO incidents (id, component_id, title, opened_at, ack_code, phase, escalation, group_id, peak_status, alert_mode)
         VALUES (?, ?, ?, ?, '', ?, '{}', ?, ?, ?)`,
        id, componentId, title, now, UNPAGED_PHASE[component.alert], id, status, component.alert,
      );
      this.event(id, now, "opened", detail, { code: detail });
      if (component.alert === "email") this.queueEmailAlert(id, "email_alert", firstTierEmailContacts(policy), now);
      return id;
    }
    const carrierRow = this.rows(
      `SELECT * FROM incidents WHERE resolved_at IS NULL AND phase = 'paging' AND acknowledged_at IS NULL AND drill = 0 AND alert_mode = 'page'
       AND opened_at >= ? ORDER BY opened_at, id LIMIT 1`, now - GROUP_WINDOW_MS,
    )[0];
    if (carrierRow !== undefined) {
      const carrier = incidentFrom(carrierRow);
      this.rows(
        `INSERT INTO incidents (id, component_id, title, opened_at, ack_code, phase, escalation, group_id, peak_status)
         VALUES (?, ?, ?, ?, ?, 'grouped', '{}', ?, ?)`,
        id, componentId, title, now, carrier.ackCode, carrier.groupId, status,
      );
      this.event(id, now, "opened", detail, { code: detail });
      this.event(id, now, "grouped", `escalates with ${carrier.id}`);
      return id;
    }
    const ackCode = randomCode(this.random, 6);
    this.rows(
      `INSERT INTO incidents (id, component_id, title, opened_at, ack_code, phase, escalation, group_id, peak_status)
       VALUES (?, ?, ?, ?, ?, 'paging', '{}', ?, ?)`,
      id, componentId, title, now, ackCode, id, status,
    );
    this.event(id, now, "opened", detail, { code: detail });
    this.applyTransition(id, startEscalation(policy, id, now), policy, now);
    return id;
  }

  private resolveIncident(id: string, policy: EscalationPolicy, now: number, reason: "recovered" | "component_removed"): void {
    const incident = this.incident(id);
    if (incident === null || incident.resolvedAt !== null) return;
    this.event(id, now, "resolved", reason, { code: reason });
    this.rows("UPDATE incidents SET close_reason = ? WHERE id = ?", reason, id);
    this.markReportDue();
    if (incident.alertMode === "email") this.resolveEmailAlert(id, policy, now);
    if (incident.phase === "grouped" || incident.escalation === null) {
      // A group member (the carrier pages and notifies for the group) or a row without escalation state: close quietly.
      this.rows("UPDATE incidents SET resolved_at = ?, phase = 'resolved', next_alarm_at = NULL WHERE id = ? AND resolved_at IS NULL", now, id);
      return;
    }
    this.handOverOrCancel(incident, incident.escalation, policy, now);
    this.applyTransition(id, stepEscalation(policy, incident.escalation, { type: "resolve" }, now), policy, now, incident.escalation.steps);
  }

  /**
   * A carrier stops carrying its group's escalation (it recovered, or its component stopped paging). When the group is
   * still affected, the oldest open member carries on from exactly where this escalation was; otherwise the pages and
   * notices still waiting are cancelled.
   */
  private handOverOrCancel(incident: IncidentRow, escalation: EscalationState, policy: EscalationPolicy, now: number): string | null {
    const id = incident.id;
    const successorRow = this.rows(
      "SELECT * FROM incidents WHERE group_id = ? AND id != ? AND resolved_at IS NULL AND phase = 'grouped' ORDER BY opened_at, id LIMIT 1",
      incident.groupId, id,
    )[0];
    if (successorRow === undefined) {
      this.cancelPendingActions({ incidentId: id }, now, id);
      return null;
    }
    const successor = incidentFrom(successorRow);
    const state: EscalationState = { ...escalation, incidentId: successor.id };
    this.rows(
      "UPDATE incidents SET phase = ?, acknowledged_at = ?, acknowledged_by = ?, next_alarm_at = ?, escalation = ? WHERE id = ?",
      state.phase, state.acknowledgedAt, state.acknowledgedBy, nextAlarmAt(policy, state), JSON.stringify(state), successor.id,
    );
    this.event(successor.id, now, "carrier", `took over escalation from ${id}`);
    // Pages still waiting (a retry in backoff, or not yet claimed) go with the escalation: the successor counts this
    // tier as paged, so cancelling them would leave those contacts unpaged while the group is still down. Their keys
    // stay as they are, so a send is still made at most once.
    const moved = this.rows(
      `UPDATE outbox SET incident_id = ? WHERE incident_id = ? AND status = 'pending' AND kind IN (${ACTION_KINDS_SQL}) RETURNING key`, successor.id, id,
    );
    if (moved.length > 0) this.event(successor.id, now, "notify", `took over ${String(moved.length)} pending from ${id}`);
    return successor.id;
  }

  /**
   * The component's alert setting changed while its incident is open: the incident takes the new mode now, instead of
   * keeping the one it opened with for the rest of the outage.
   *   Leaving "page": its escalation stops. As a group's carrier it hands the escalation to the group's oldest open member
   *   (which goes on paging for the rest of the group), or cancels the pages and notices still waiting; as a member it
   *   simply leaves the group. Its ACK code is cleared.
   *   Becoming "page": it starts its own escalation at the first tier with a new ACK code, like an incident opening now
   *   (an earlier acknowledgement does not carry over: nobody has acknowledged this page). It does not join a group.
   *   Leaving "email": an opening email not yet sent (and not in flight) is cancelled.
   *   Becoming "email": the first tier's email contacts get the opening email (at most once each per incident).
   * Every change is its own group, so modes never mix in a group (an email-only incident never carries a page).
   */
  private changeAlertMode(incident: IncidentRow, mode: AlertMode, policy: EscalationPolicy, now: number): void {
    const id = incident.id;
    this.event(id, now, "alert_mode", `alert ${incident.alertMode} -> ${mode}`, { code: `alert_${mode}` });
    if (incident.alertMode === "email") {
      this.rows(
        `UPDATE outbox SET status = 'cancelled', claim_until = NULL WHERE incident_id = ? AND kind = 'email_alert' AND status = 'pending'
         AND (claim_until IS NULL OR claim_until <= ?)`, id, now,
      );
    }
    if (incident.alertMode === "page" && incident.phase !== "grouped" && incident.escalation !== null) {
      const successor = this.handOverOrCancel(incident, incident.escalation, policy, now);
      // The group id is often this incident's own id: the rest of the group takes the successor's, so this one can leave.
      if (successor !== null) {
        this.rows("UPDATE incidents SET group_id = ? WHERE group_id = ? AND id != ?", successor, incident.groupId, id);
        // Its earlier pages keep its id: they follow this pointer to the group that carries them now (carrierFor).
        this.rows("UPDATE incidents SET handed_over_to = ? WHERE id = ?", successor, id);
      }
    }
    if (mode === "page") {
      this.rows(
        `UPDATE incidents SET alert_mode = 'page', phase = 'paging', ack_code = ?, group_id = id, handed_over_to = NULL, escalation = '{}',
         next_alarm_at = NULL,
         acknowledged_at = NULL, acknowledged_by = NULL, acknowledged_contact = NULL, acknowledged_via = NULL WHERE id = ?`,
        randomCode(this.random, 6), id,
      );
      // Its send keys get their own prefix: an incident that paged before (page, then email, then page again) already
      // holds keys for the first steps, and the outbox would silently drop the new pages as repeats.
      this.applyTransition(id, startEscalation(policy, `${id}.m${now.toString(36)}`, now), policy, now);
      return;
    }
    this.rows(
      "UPDATE incidents SET alert_mode = ?, phase = ?, ack_code = '', group_id = id, escalation = '{}', next_alarm_at = NULL WHERE id = ?",
      mode, UNPAGED_PHASE[mode], id,
    );
    if (mode === "email") {
      // An opening email cancelled by an earlier change away from email goes out after all: queueEmailAlert's
      // INSERT OR IGNORE would otherwise skip it (same key), and nobody would hear of this incident at all.
      this.rows(
        `UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ?, claim_until = NULL, last_error = NULL
         WHERE incident_id = ? AND kind = 'email_alert' AND status = 'cancelled'`, now, id,
      );
      this.queueEmailAlert(id, "email_alert", firstTierEmailContacts(policy), now);
    }
  }

  /**
   * Folds one run into history, component state and incidents; then advances any escalation that is due. A run at or
   * before the last folded run (a repeated cron delivery or a manual re-trigger of the same tick) is kept as history
   * but never counted again, so one bad minute can never become two consecutive failures.
   */
  recordRun(
    results: readonly CheckResult[],
    targets: TargetsConfig,
    policy: EscalationPolicy,
    now: number,
    options: { readonly maintenance?: readonly MaintenanceWindow[] } = {},
  ): { opened: string[]; resolved: string[] } {
    const maintenance = options.maintenance ?? [];
    return this.storage.transactionSync(() => {
      const runId = num(this.rows("INSERT INTO runs (started_at, results) VALUES (?, ?) RETURNING id", now, results.length)[0], "id");
      for (const result of results) {
        const values = [result.checkId, result.componentId, result.type, result.status, result.inconclusive ? 1 : 0, result.latencyMs, result.detail,
          result.observedAt] as const;
        this.rows(
          `INSERT INTO check_results (run_id, check_id, component_id, type, status, inconclusive, latency_ms, detail, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, runId, ...values,
        );
        this.rows(
          `INSERT INTO check_latest (check_id, component_id, type, status, inconclusive, latency_ms, detail, observed_at, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (check_id) DO UPDATE SET component_id = excluded.component_id, type = excluded.type,
           status = excluded.status, inconclusive = excluded.inconclusive, latency_ms = excluded.latency_ms, detail = excluded.detail,
           observed_at = excluded.observed_at, data = excluded.data WHERE excluded.observed_at >= check_latest.observed_at`,
          ...values, result.data === null ? null : JSON.stringify(result.data).slice(0, 16_000),
        );
      }
      const opened: string[] = [], resolved: string[] = [];
      const lastRun = this.getMeta("last_run_at");
      if (lastRun !== null && now <= Number(lastRun)) {
        this.setMeta("last_repeated_run_at", String(now));
        return { opened, resolved };
      }
      this.recordDnsStreak(results, now);
      const rules = { openAfterFailures: targets.openAfterFailures, resolveAfterPasses: targets.resolveAfterPasses };
      for (const component of targets.components) {
        const before = this.component(component.id);
        // Under maintenance a failing run still counts (so a component still failing when the window ends opens at once)
        // but opens nothing; the window's id is remembered for the incident's timeline.
        const window = activeWindow(maintenance, component.id, now);
        const step = stepComponent(component, before, results, rules, now, { suppressOpen: window !== null });
        if (step.runStatus === null) continue;
        if (step.suppressed && window !== null) this.setMeta(`maintenance_suppressed:${component.id}`, window.id);
        this.rows(
          `INSERT INTO component_hourly (component_id, hour, total, up) VALUES (?, ?, 1, ?)
           ON CONFLICT (component_id, hour) DO UPDATE SET total = total + 1, up = up + excluded.up`,
          component.id, Math.floor(now / HOUR), step.runStatus === "down" ? 0 : 1,
        );
        let state = step.state;
        if (step.transition === "open") {
          const failing = results.find((result) => result.componentId === component.id && !result.inconclusive && result.status === step.runStatus);
          const id = this.openIncident(component, step.runStatus, failing?.detail ?? step.runStatus, policy, now);
          state = { ...state, openIncidentId: id };
          opened.push(id);
          const suppressedBy = this.getMeta(`maintenance_suppressed:${component.id}`);
          if (suppressedBy !== null && suppressedBy !== "") {
            this.event(id, now, "maintenance", `failing through maintenance window ${suppressedBy}`, { code: suppressedBy });
            this.setMeta(`maintenance_suppressed:${component.id}`, "");
          }
        }
        if (!isFailing(component, step.runStatus)) {
          this.setMeta(`maintenance_suppressed:${component.id}`, "");
        }
        if (step.transition === null && before.openIncidentId !== null && step.runStatus === "down") {
          this.rows("UPDATE incidents SET peak_status = 'down' WHERE id = ? AND resolved_at IS NULL", before.openIncidentId);
        }
        if (step.transition === "resolve" && before.openIncidentId !== null) {
          this.resolveIncident(before.openIncidentId, policy, now, "recovered");
          resolved.push(before.openIncidentId);
        }
        this.saveComponent(state);
      }
      // A component whose alert setting changed while its incident is open: the incident follows the new setting.
      for (const component of targets.components) {
        const openId = this.component(component.id).openIncidentId;
        const incident = openId === null ? null : this.incident(openId);
        if (incident !== null && incident.resolvedAt === null && !incident.drill && incident.alertMode !== component.alert) {
          this.changeAlertMode(incident, component.alert, policy, now);
        }
      }
      // A component removed from the targets can never recover, so its open incident is closed (with a notice to
      // everyone paged) instead of paging through every cycle. Members first, so no removed member inherits a carrier.
      const configured = new Set(targets.components.map((component) => component.id));
      const orphans = this.rows(
        "SELECT id, component_id FROM incidents WHERE resolved_at IS NULL AND drill = 0 ORDER BY phase = 'grouped' DESC, opened_at, id",
      )
        .filter((row) => !configured.has(text(row, "component_id")));
      for (const row of orphans) {
        this.resolveIncident(text(row, "id"), policy, now, "component_removed");
        this.rows("UPDATE components SET open_incident_id = NULL WHERE id = ?", text(row, "component_id"));
        resolved.push(text(row, "id"));
      }
      this.setMeta("last_run_at", String(now));
      this.setMeta("config_error", "");
      this.advanceDueInTransaction(policy, now);
      return { opened, resolved };
    });
  }

  private advanceDueInTransaction(policy: EscalationPolicy, now: number): number {
    const due = this.rows("SELECT * FROM incidents WHERE resolved_at IS NULL AND next_alarm_at IS NOT NULL AND next_alarm_at <= ?", now).map(incidentFrom);
    for (const incident of due) {
      if (incident.drill) {
        this.missDrill(incident, policy, now);
        continue;
      }
      if (incident.escalation === null) continue;
      const transition = stepEscalation(policy, incident.escalation, { type: "tick" }, now);
      this.applyTransition(incident.id, transition, policy, now, incident.escalation.steps);
    }
    return due.length;
  }

  /** Alarm entry point: takes every escalation step that is due. */
  advanceDue(policy: EscalationPolicy, now: number): number {
    return this.storage.transactionSync(() => this.advanceDueInTransaction(policy, now));
  }

  /**
   * Acknowledges the group the incident belongs to (whoever carries its escalation now), mirrors the acknowledgement
   * onto the group's open members, and cancels any page or notice still waiting in the outbox.
   */
  acknowledge(incidentId: string, by: AckBy, policy: EscalationPolicy, now: number): AckOutcome {
    return this.storage.transactionSync(() => {
      const incident = this.incident(incidentId);
      if (incident === null) return "not_found";
      if (incident.drill) return this.acknowledgeDrill(incident, by, now);
      const carrier = this.carrierFor(incident);
      if (carrier === null) return incident.resolvedAt !== null ? "resolved" : "not_found";
      if (carrier.escalation === null) return "not_found";
      if (carrier.acknowledgedAt !== null) return "already_acknowledged";
      const via = channelOf(by.via), contact = by.contactId ?? null;
      this.event(carrier.id, now, "acked", `${by.name} via ${by.via}`, { contactId: contact, channel: via });
      this.applyTransition(
        carrier.id, stepEscalation(policy, carrier.escalation, { type: "ack", by: by.name, via: by.via }, now), policy, now, carrier.escalation.steps,
      );
      this.rows(
        `UPDATE incidents SET acknowledged_at = ?, acknowledged_by = ?, acknowledged_contact = ?, acknowledged_via = ?
         WHERE group_id = ? AND (phase = 'grouped' OR id = ?) AND resolved_at IS NULL`,
        now, by.name, contact, via, carrier.groupId, carrier.id,
      );
      this.cancelPendingActions({ groupId: carrier.groupId }, now, carrier.id);
      return "acknowledged";
    });
  }

  /** A drill is acknowledged by its one contact and closes at once: the archive keeps who answered and how fast. */
  private acknowledgeDrill(incident: IncidentRow, by: AckBy, now: number): AckOutcome {
    if (incident.resolvedAt !== null) return incident.acknowledgedAt !== null ? "already_acknowledged" : "resolved";
    const via = channelOf(by.via), contact = by.contactId ?? null;
    this.rows(
      `UPDATE incidents SET acknowledged_at = ?, acknowledged_by = ?, acknowledged_contact = ?, acknowledged_via = ?, phase = 'resolved',
       resolved_at = ?, next_alarm_at = NULL, close_reason = 'drill_acknowledged' WHERE id = ?`,
      now, by.name, contact, via, now, incident.id,
    );
    this.event(incident.id, now, "acked", `${by.name} via ${by.via}`, { contactId: contact, channel: via });
    this.event(incident.id, now, "resolved", "drill_acknowledged", { code: "drill_acknowledged" });
    this.cancelPendingActions({ incidentId: incident.id }, now, incident.id);
    const drilled = incident.escalation?.paged[0] ?? contact;
    if (drilled !== null) {
      for (const row of this.contactHealth().filter((item) => item.contactId === drilled && item.state === "drill_missed")) {
        this.setContactHealth(row.contactId, row.channel, "ok", null, now);
      }
    }
    this.markReportDue();
    return "acknowledged";
  }

  /**
   * Starts this week's drill when its slot has come (policy.drill, in policy.timeZone): one contact, rotating in tier
   * order, gets a [TEST] page acknowledged like a real one within its tier's timeout. Returns the drill incident id.
   */
  startDueDrill(policy: EscalationPolicy, now: number): string | null {
    return this.storage.transactionSync(() => {
      const last = this.getMeta("drill_last_slot");
      const slot = dueDrillSlot(policy, last === null || last === "" ? null : Number(last), now);
      if (slot === null) return null;
      this.setMeta("drill_last_slot", String(slot));
      if (this.rows("SELECT id FROM incidents WHERE drill = 1 AND resolved_at IS NULL LIMIT 1").length > 0) return null;
      const next = nextDrillContact(policy, this.getMeta("drill_last_contact"));
      if (next === null) return null;
      this.setMeta("drill_last_contact", next.contact.id);
      const id = `drl_${now.toString(36)}_${randomHex(this.random, 4)}`;
      this.rows(
        `INSERT INTO incidents (id, component_id, title, opened_at, ack_code, phase, escalation, group_id, drill)
         VALUES (?, '', '[TEST] Weekly paging drill', ?, ?, 'paging', '{}', ?, 1)`,
        id, now, randomCode(this.random, 6), id,
      );
      this.event(id, now, "opened", `drill for ${next.contact.id}`, { tierId: next.tier.id, contactId: next.contact.id, code: "drill" });
      const single = drillPolicy(policy, next.tier, next.contact);
      this.applyTransition(id, startEscalation(single, id, now), single, now);
      return id;
    });
  }

  /** The drilled contact did not acknowledge in time: contact health drill_missed, and the first tier hears of it by email. */
  private missDrill(incident: IncidentRow, policy: EscalationPolicy, now: number): void {
    const contactId = incident.escalation?.paged[0] ?? null;
    this.rows(
      "UPDATE incidents SET phase = 'resolved', resolved_at = ?, next_alarm_at = NULL, close_reason = 'drill_missed' WHERE id = ? AND resolved_at IS NULL",
      now, incident.id,
    );
    this.event(incident.id, now, "resolved", "drill_missed", { contactId, code: "drill_missed" });
    this.cancelPendingActions({ incidentId: incident.id }, now, incident.id);
    const contacts = new Map(policy.tiers.flatMap((tier) => tier.contacts.map((contact) => [contact.id, contact] as const)));
    const missed = contactId === null ? undefined : contacts.get(contactId);
    if (missed !== undefined) {
      for (const channel of ["sms", "email"] as const) {
        // Only a channel with no known delivery problem: an opted_out, undeliverable or suppressed state says more (and
        // how to fix it), and acknowledging a later drill must not turn it back into "ok" while the problem remains.
        if ((channel === "sms" ? missed.sms : missed.email) === null || this.contactHealthState(missed.id, channel) !== "ok") continue;
        this.setContactHealth(missed.id, channel, "drill_missed", "drill_missed", now);
      }
    }
    for (const contact of policy.tiers[0]?.contacts ?? []) {
      if (contact.email === null) continue;
      this.rows(
        `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
         attempts, next_attempt_at, created_at) VALUES (?, ?, 'drill_missed', ?, ?, 'email', ?, ?, 0, ?, 'pending', 0, ?, ?)`,
        `${incident.id}:drill_missed:${contact.id}:email`, incident.id, contact.id, contact.name, contact.email, policy.tiers[0]?.id ?? null,
        JSON.stringify({ detail: missed?.name ?? contactId ?? "a contact" }), now, now,
      );
    }
    this.markReportDue();
  }

  /**
   * Open incidents (drills included) whose escalation has paged this contact, each the carrier of its group: what a
   * bare "ACK" could mean.
   */
  openGroupsPagedTo(contactId: string): IncidentRow[] {
    return this.rows("SELECT * FROM incidents WHERE resolved_at IS NULL AND phase != 'grouped' ORDER BY opened_at, id")
      .map(incidentFrom)
      .filter((incident) => incident.escalation?.paged.includes(contactId) === true);
  }

  /**
   * A responder asked to escalate now (SMS "ESC <code>" or the button on the acknowledgement page): the group's
   * escalation takes its next step at once. Only while it is paging and unacknowledged; never for a drill.
   */
  escalateNow(incidentId: string, by: AckBy, policy: EscalationPolicy, now: number): EscalateOutcome {
    return this.storage.transactionSync((): EscalateOutcome => {
      const incident = this.incident(incidentId);
      if (incident === null) return { outcome: "not_found", tierName: null };
      if (incident.drill) return { outcome: "drill", tierName: null };
      const carrier = this.carrierFor(incident);
      if (carrier === null) return { outcome: incident.resolvedAt !== null ? "resolved" : "not_found", tierName: null };
      if (carrier.acknowledgedAt !== null) return { outcome: "already_acknowledged", tierName: null };
      const state = carrier.escalation;
      if (state === null) return { outcome: "not_found", tierName: null };
      if (state.phase === "exhausted") return { outcome: "exhausted", tierName: null };
      if (state.phase !== "paging") return { outcome: "not_found", tierName: null };
      const transition = stepEscalation(policy, state, { type: "escalate" }, now);
      this.event(carrier.id, now, "notify", `escalation requested by ${by.name} via ${by.via}`, {
        contactId: by.contactId ?? null, channel: channelOf(by.via), code: "esc_requested",
      });
      this.applyTransition(carrier.id, transition, policy, now, state.steps, "esc_requested");
      const next = transition.state;
      return { outcome: "escalated", tierName: next.phase === "paging" ? (policy.tiers[next.tierIndex]?.name ?? null) : null };
    });
  }

  /**
   * Monitor-health streak for DNS: a run whose DNS results are all inconclusive (the resolver itself failing) extends
   * it; any conclusive DNS result ends it, and so does a run with no DNS result at all (every run carries a result for
   * every configured check, so that means no DNS check is configured any more). After DNS_INCONCLUSIVE_NOTICE_MS a
   * one-time email goes to the first tier.
   */
  private recordDnsStreak(results: readonly CheckResult[], now: number): void {
    const dns = results.filter((result) => result.type === "dns");
    if (dns.length === 0 || dns.some((result) => !result.inconclusive)) {
      this.setMeta("dns_inconclusive_since", "");
      return;
    }
    const since = this.getMeta("dns_inconclusive_since");
    if (since === null || since === "") this.setMeta("dns_inconclusive_since", String(now));
  }

  /** Since when every DNS result has been inconclusive, or null. */
  dnsInconclusiveSince(): number | null {
    const since = this.getMeta("dns_inconclusive_since");
    return since === null || since === "" ? null : Number(since);
  }
}

export type {
  AcceptEffects, AcceptOutcome, AckBy, AckOutcome, CheckLatest, Claimed, ConfigChange, ConfigFetchStatus, ConfigNotices, ContactHealthRow,
  ContactHealthState, EscalateOutcome, EventFields, IncidentEvent, IncidentRow, OutboxKind, OutboxRow, PagingHealth, StoredPlatformConfig,
  TimelineType, Uptime,
} from "./store-rows.ts";
export {
  backoffMs, CHANNEL_NOTICE_EVERY_MS, CLAIM_BATCH, CLAIM_MS, CONTACT_HEALTH_STATES, DELIVERY_CONCURRENCY, GROUP_WINDOW_MS, REPLY_LIMIT,
  REPLY_WINDOW_MS, REPORT_INCIDENTS, RETENTION_MS, TIMELINE_TYPES, UNEXPORTED_RETENTION_MS, WORST_SEND_MS,
} from "./store-rows.ts";
