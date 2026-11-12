// The monitor store's outbox layer (store.ts): claiming and recording sends, provider status callbacks, final failures
// (contact health, failover, early escalation, channel-health notices), notices that belong to no incident, the
// email-only alert's emails (email-alert.ts), paging health and the next wake-up.
import type { Contact, EscalationPolicy } from "./config.ts";
import {
  contactProblemFor, FAILED_STATUSES, isContactFailure, isEmailChannelProblem, isFinalStatus, isSmsChannelProblem, UNKNOWN_AFTER_MS,
} from "./delivery-health.ts";
import type { EmailAlertKind } from "./email-alert.ts";
import { isEmailAlertKind } from "./email-alert.ts";
import { pageStepId, stepEscalation } from "./escalation.ts";
import type { ContactProblem } from "./notify/messages.ts";
import { nullableNum, nullableText, num, text } from "./schema.ts";
import type { Claimed, OutboxRow, PagingHealth } from "./store-rows.ts";
import {
  ACTION_KINDS, ACTION_KINDS_SQL, backoffMs, CHANNEL_NOTICE_EVERY_MS, channelsOf, CLAIM_MS, contactIn, HOUR, MAX_ATTEMPTS, NON_INCIDENT_KINDS, outboxFrom,
  PENDING_STATUSES_SQL, REPLY_LIMIT, REPLY_WINDOW_MS,
} from "./store-rows.ts";
import { StoreRecords } from "./store-records.ts";

export class OutboxStore extends StoreRecords {
  /** Queues one email per contact for an email-only incident (email-alert.ts); a key per incident, kind and contact. */
  protected queueEmailAlert(incidentId: string, kind: EmailAlertKind, contacts: readonly Contact[], now: number): void {
    const recipients = contacts.filter((contact) => contact.email !== null);
    if (recipients.length === 0) {
      this.event(incidentId, now, "notify", `${kind}: no email contact in the first tier`, { code: "email_alert_no_recipient" });
      return;
    }
    for (const contact of recipients) {
      this.rows(
        `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
         attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 'email', ?, NULL, 0, '{}', 'pending', 0, ?, ?)`,
        `${incidentId}:${kind}:${contact.id}:email`, incidentId, kind, contact.id, contact.name, contact.email ?? "", now, now,
      );
    }
    this.event(incidentId, now, "notify", `${kind}: ${String(recipients.length)} email`);
  }

  /**
   * An email-only incident resolved: an opening email not yet sent (and not in flight) is cancelled, since nobody needs
   * to hear it went down now that it is up; everyone the opening email went (or is going) to gets one resolved email,
   * at their current address. A contact since removed from the policy, or left without an email, gets nothing.
   */
  protected resolveEmailAlert(incidentId: string, policy: EscalationPolicy, now: number): void {
    this.rows(
      `UPDATE outbox SET status = 'cancelled', claim_until = NULL WHERE incident_id = ? AND kind = 'email_alert' AND status = 'pending'
       AND (claim_until IS NULL OR claim_until <= ?)`, incidentId, now,
    );
    const told = this.rows("SELECT contact_id FROM outbox WHERE incident_id = ? AND kind = 'email_alert' AND status IN ('sent', 'pending') ORDER BY key",
      incidentId);
    const contacts = told.flatMap((row) => {
      const contact = contactIn(policy, text(row, "contact_id"));
      return contact === null || contact.email === null ? [] : [contact];
    });
    if (contacts.length > 0) this.queueEmailAlert(incidentId, "email_alert_resolved", contacts, now);
  }

  /**
   * The provider's delivery status for the send it accepted under this provider id (Twilio's status callback).
   * Callbacks can arrive out of order, so the first final status (delivered, failed, undelivered, canceled) wins and
   * later ones are ignored; an "unknown" (no final status in time) is replaced only by a final one. A delivered SMS
   * clears an opted_out or undeliverable state on that channel. A failed one marks the row failed and runs
   * failFinally: contact health, failover to the contact's other channel, and early escalation (with `policy`).
   * Returns the row as recorded, or null when no send has this provider id.
   */
  recordProviderStatus(providerId: string, status: string, code: string | null, now: number, policy: EscalationPolicy | null = null): OutboxRow | null {
    return this.storage.transactionSync(() => {
      const raw = this.rows("SELECT * FROM outbox WHERE provider_id = ? LIMIT 1", providerId)[0];
      if (raw === undefined) {
        // The callback beat markSent (a Durable Object takes other calls while a send awaits Twilio's response body), and
        // Twilio does not post it again. A final status is kept (the first one wins) and applied when markSent records
        // this SID; one nobody claims is pruned after an hour.
        if (isFinalStatus(status)) {
          this.rows("INSERT OR IGNORE INTO early_status (provider_id, status, code, at) VALUES (?, ?, ?, ?)", providerId.slice(0, 80), status.slice(0, 32),
            code?.slice(0, 64) ?? null, now);
        }
        return null;
      }
      return this.applyProviderStatus(outboxFrom(raw), status, code, now, policy);
    });
  }

  /** recordProviderStatus for a known row, inside the caller's transaction. */
  private applyProviderStatus(row: OutboxRow, status: string, code: string | null, now: number, policy: EscalationPolicy | null): OutboxRow {
    const current = row.deliveryStatus;
    if (current !== null && isFinalStatus(current)) return row;
    if (!isFinalStatus(status) && (current === status || current === "unknown")) return row;
    this.rows("UPDATE outbox SET delivery_status = ?, delivery_code = ?, delivery_at = ? WHERE key = ?", status.slice(0, 32), code?.slice(0, 64) ?? null,
      now, row.key);
    const failed = FAILED_STATUSES.includes(status);
    const type = status === "delivered" ? "delivered" : failed ? "failed" : null;
    if (type !== null && !NON_INCIDENT_KINDS.includes(row.kind)) {
      this.event(row.incidentId, now, type, `${row.kind} ${status}`, { tierId: row.tierId, contactId: row.contactId, channel: row.channel, code });
    }
    const recorded: OutboxRow = { ...row, deliveryStatus: status, deliveryCode: code };
    if (status === "delivered") {
      const health = this.contactHealthState(row.contactId, row.channel);
      if (health === "opted_out" || health === "undeliverable") this.setContactHealth(row.contactId, row.channel, "ok", "delivered", now);
      // An SMS arrived: alert SMS works again.
      if (row.channel === "sms" && this.rows("DELETE FROM meta WHERE key LIKE 'sms_channel_problem:%' RETURNING key").length > 0) this.markReportDue();
    }
    if (failed) {
      const failCode = code ?? `twilio_${status}`;
      this.rows("UPDATE outbox SET status = 'failed', last_error = ? WHERE key = ? AND status = 'sent'", failCode.slice(0, 64), row.key);
      this.failFinally({ ...recorded, status: "failed", lastError: failCode }, failCode, now, policy);
    }
    return recorded;
  }

  /**
   * Sends accepted by Twilio more than UNKNOWN_AFTER_MS ago that still have no final status are marked "unknown"
   * (shown in the private view and as the sms_delivery_unknown warning). No failover: the page may well have arrived.
   */
  markUnknownDeliveries(now: number): number {
    return this.storage.transactionSync(() => {
      const marked = this.rows(
        `UPDATE outbox SET delivery_status = 'unknown', delivery_code = 'twilio_no_final_status', delivery_at = ?
         WHERE status = 'sent' AND channel = 'sms' AND sent_at <= ? AND provider_id NOT LIKE 'log:%'
         AND (delivery_status IS NULL OR delivery_status IN (${PENDING_STATUSES_SQL})) RETURNING incident_id, kind, tier_id, contact_id`,
        now, now - UNKNOWN_AFTER_MS,
      );
      for (const row of marked) {
        if (NON_INCIDENT_KINDS.some((kind) => kind === text(row, "kind"))) continue;
        this.event(text(row, "incident_id"), now, "delivery_unknown", `${text(row, "kind")} sms: no final status`, {
          tierId: nullableText(row, "tier_id"), contactId: nullableText(row, "contact_id"), channel: "sms", code: "twilio_no_final_status",
        });
      }
      return marked.length;
    });
  }

  /** SMS sends that ended "unknown" within the last day (the sms_delivery_unknown warning). */
  unknownDeliveries(now: number): number {
    return num(this.rows("SELECT COUNT(*) AS n FROM outbox WHERE delivery_status = 'unknown' AND delivery_at >= ?", now - 24 * HOUR)[0], "n");
  }

  /**
   * After a send failed for good (row already marked failed): contact health, an account-level email problem, failover
   * to the contact's other channel and early escalation. Without a policy only the contact health is recorded.
   */
  private failFinally(row: OutboxRow, code: string, now: number, policy: EscalationPolicy | null): void {
    const problem = contactProblemFor(row.channel, code);
    if (problem !== null && this.setContactHealth(row.contactId, row.channel, problem, code, now) && policy !== null) {
      this.queueContactNotice(row.contactId, problem, policy, now);
    }
    // An email-only alert never leads to an SMS (email-alert.ts): the problem is recorded and warned about, but the
    // first tier is not texted about it.
    if (row.channel === "email" && isEmailChannelProblem(code)) this.noteEmailChannelProblem(code, isEmailAlertKind(row.kind) ? null : policy, now);
    if (row.channel === "sms" && isSmsChannelProblem(code)) this.noteSmsChannelProblem(code, policy, now);
    if (policy === null || NON_INCIDENT_KINDS.includes(row.kind)) return;
    this.failover(row, policy, now);
    this.escalateIfTierFailed(row, policy, now);
  }

  /** The other channel of the same send (same step, same contact), queued while the incident still needs someone. */
  private failover(row: OutboxRow, policy: EscalationPolicy, now: number): void {
    if (!ACTION_KINDS.some((kind) => kind === row.kind)) return;
    const parts = row.key.split(":");
    if (parts.length !== 4 || parts[3] !== row.channel) return;
    // Judged by the group's carrier, not the row's own incident: when the carrier recovered and an open member took
    // over its escalation, the group still needs this contact. The failover belongs to whoever carries it now.
    const incident = this.incident(row.incidentId);
    if (incident === null) return;
    const carrier = this.carrierFor(incident);
    // A page still in flight when its component stopped paging (changeAlertMode) has nobody left to fail over for.
    if (carrier === null || carrier.acknowledgedAt !== null || carrier.alertMode !== "page") return;
    const other = row.channel === "sms" ? "email" : "sms";
    const contact = contactIn(policy, row.contactId);
    const address = contact === null ? null : other === "sms" ? contact.sms : contact.email;
    if (contact === null || address === null) return;
    const payload = text(this.rows("SELECT payload FROM outbox WHERE key = ?", row.key)[0], "payload");
    const inserted = this.rows(
      `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
       attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?) RETURNING key`,
      [parts[0], parts[1], parts[2], other].join(":"), carrier.id, row.kind, contact.id, contact.name, other, address, row.tierId, row.cycle,
      payload === "" ? "{}" : payload, now, now,
    );
    if (inserted.length > 0) {
      this.event(carrier.id, now, "notify", `failover ${row.kind} ${row.channel} -> ${other}`, { contactId: contact.id, channel: other });
    }
  }

  /**
   * When a page of the tier being paged now failed and so has every channel of every contact in that tier, each for a
   * reason about the contact (isContactFailure), the next step is taken at once instead of at the tier's deadline.
   * A provider- or account-level failure (bad credentials, an unregistered sender, Email Service suspended) would fail
   * every tier alike, so it never escalates early. An early escalation stays inside the current cycle: from the last
   * tier, the next cycle (the same first-tier contacts whose channels just failed) or "exhausted" waits for the tier's
   * deadline, so a burst of failures (a carrier outage returning 30003 for everyone) cannot run through every cycle in
   * minutes and end paging before the people are reachable again. Drills never escalate. Judged by the group's carrier,
   * so a page handed over to a successor still counts.
   */
  private escalateIfTierFailed(row: OutboxRow, policy: EscalationPolicy, now: number): void {
    if (row.kind !== "page") return;
    const incident = this.incident(row.incidentId);
    if (incident === null || incident.drill) return;
    const carrier = this.carrierFor(incident);
    const state = carrier?.escalation ?? null;
    if (carrier === null || state === null || carrier.acknowledgedAt !== null || state.phase !== "paging") return;
    const stepId = pageStepId(state.cycle, state.tierIndex);
    const [prefix, step] = row.key.split(":");
    if (step !== stepId || prefix === undefined) return;
    const tier = policy.tiers[Math.min(Math.max(state.tierIndex, 0), policy.tiers.length - 1)];
    if (tier === undefined) return;
    for (const contact of tier.contacts) {
      for (const channel of channelsOf(contact)) {
        const key = `${prefix}:${stepId}:${contact.id}:${channel}`;
        const sent = this.rows("SELECT status, delivery_status, delivery_code, last_error FROM outbox WHERE key = ?", key)[0];
        if (sent === undefined) return;
        const callbackFailed = FAILED_STATUSES.includes(text(sent, "delivery_status"));
        if (!callbackFailed && text(sent, "status") !== "failed") return;
        const code = (callbackFailed ? nullableText(sent, "delivery_code") : null) ?? nullableText(sent, "last_error") ?? "";
        if (!isContactFailure(channel, code)) return;
      }
    }
    const transition = stepEscalation(policy, state, { type: "escalate" }, now);
    if (transition.state.phase !== "paging" || transition.state.cycle !== state.cycle) {
      this.event(carrier.id, now, "notify", `every channel of tier ${tier.id} failed: the next cycle or the end of paging waits for the tier's deadline`, {
        tierId: tier.id, code: "all_channels_failed",
      });
      return;
    }
    this.event(carrier.id, now, "notify", `every channel of tier ${tier.id} failed: escalating now`, { tierId: tier.id, code: "all_channels_failed" });
    this.applyTransition(carrier.id, transition, policy, now, state.steps, "all_channels_failed");
  }

  /**
   * Tells the first tier's email contacts (by email, never a page) that a contact's channel stopped working; for an
   * opt-out the contact's own email address gets a copy saying how to undo it. Not to an address that is itself
   * suppressed.
   */
  queueContactNotice(contactId: string, problem: ContactProblem, policy: EscalationPolicy, now: number): number {
    const contact = contactIn(policy, contactId);
    const name = contact?.name ?? contactId;
    const incidentId = `ctc_${contactId}_${now.toString(36)}`;
    const recipients = new Map<string, { contact: Contact; self: boolean }>();
    for (const member of policy.tiers[0]?.contacts ?? []) {
      if (member.email === null || (problem === "suppressed" && member.id === contactId)) continue;
      recipients.set(member.id, { contact: member, self: member.id === contactId });
    }
    if (problem === "opted_out" && contact !== null && contact.email !== null) recipients.set(contact.id, { contact, self: true });
    let queued = 0;
    for (const { contact: recipient, self } of recipients.values()) {
      queued += this.rows(
        `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
         attempts, next_attempt_at, created_at) VALUES (?, ?, 'contact_notice', ?, ?, 'email', ?, NULL, 0, ?, 'pending', 0, ?, ?) RETURNING key`,
        `${incidentId}:contact_notice:${recipient.id}:email`, incidentId, recipient.id, recipient.name, recipient.email ?? "",
        JSON.stringify({ detail: self ? `${problem}:self` : problem, about: name }), now, now,
      ).length;
    }
    return queued;
  }

  /**
   * Alert email is failing account-wide: remembered for the email_channel_failing warning until an email goes out
   * again, and the first tier's SMS contacts hear of it, at most once per CHANNEL_NOTICE_EVERY_MS per code.
   */
  private noteEmailChannelProblem(code: string, policy: EscalationPolicy | null, now: number): void {
    if (this.getMeta(`channel_problem:${code}`) === null) this.markReportDue();
    this.setMeta(`channel_problem:${code}`, String(now));
    if (policy === null) return;
    const last = Number(this.getMeta(`channel_notice_at:${code}`) ?? "0");
    if (last > 0 && now - last < CHANNEL_NOTICE_EVERY_MS) return;
    this.setMeta(`channel_notice_at:${code}`, String(now));
    const incidentId = `chn_${code}_${now.toString(36)}`.slice(0, 64);
    for (const contact of policy.tiers[0]?.contacts ?? []) {
      if (contact.sms === null) continue;
      this.rows(
        `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
         attempts, next_attempt_at, created_at) VALUES (?, ?, 'channel_notice', ?, ?, 'sms', ?, NULL, 0, ?, 'pending', 0, ?, ?)`,
        `${incidentId}:channel_notice:${contact.id}:sms`, incidentId, contact.id, contact.name, contact.sms, JSON.stringify({ detail: code }), now, now,
      );
    }
  }

  /** Account-level email failure codes seen since the last email that went out. */
  emailChannelProblems(): string[] {
    return this.rows("SELECT key FROM meta WHERE key LIKE 'channel_problem:%' ORDER BY key").map((row) => text(row, "key").slice("channel_problem:".length));
  }

  /**
   * Alert SMS is failing account-wide: remembered for the sms_channel_failing warning until an SMS is confirmed
   * delivered, and the first tier's email contacts hear of it, at most once per CHANNEL_NOTICE_EVERY_MS per code.
   */
  private noteSmsChannelProblem(code: string, policy: EscalationPolicy | null, now: number): void {
    if (this.getMeta(`sms_channel_problem:${code}`) === null) this.markReportDue();
    this.setMeta(`sms_channel_problem:${code}`, String(now));
    if (policy === null) return;
    const last = Number(this.getMeta(`sms_channel_notice_at:${code}`) ?? "0");
    if (last > 0 && now - last < CHANNEL_NOTICE_EVERY_MS) return;
    this.setMeta(`sms_channel_notice_at:${code}`, String(now));
    const incidentId = `chn_${code}_${now.toString(36)}`.slice(0, 64);
    for (const contact of policy.tiers[0]?.contacts ?? []) {
      if (contact.email === null) continue;
      this.rows(
        `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
         attempts, next_attempt_at, created_at) VALUES (?, ?, 'channel_notice', ?, ?, 'email', ?, NULL, 0, ?, 'pending', 0, ?, ?)`,
        `${incidentId}:channel_notice:${contact.id}:email`, incidentId, contact.id, contact.name, contact.email, JSON.stringify({ detail: code }), now, now,
      );
    }
  }

  /** Account-level SMS failure codes seen since the last SMS confirmed delivered. */
  smsChannelProblems(): string[] {
    return this.rows("SELECT key FROM meta WHERE key LIKE 'sms_channel_problem:%' ORDER BY key")
      .map((row) => text(row, "key").slice("sms_channel_problem:".length));
  }

  /**
   * Claims due outbox rows (so an overlapping alarm does not send them too) and returns them with their incident and
   * the components of the rest of its open group. A page or notice whose group is acknowledged, or whose incident has
   * closed, is cancelled instead: nobody is asked to act on something already handled.
   */
  claimDue(now: number, limit = 25): Claimed[] {
    return this.storage.transactionSync(() => {
      const rows = this.rows(
        `SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? AND (claim_until IS NULL OR claim_until <= ?)
         ORDER BY created_at, key LIMIT ?`, now, now, limit,
      );
      return rows.flatMap((raw): Claimed[] => {
        const row = outboxFrom(raw);
        if (NON_INCIDENT_KINDS.includes(row.kind)) {
          this.rows("UPDATE outbox SET claim_until = ? WHERE key = ?", now + CLAIM_MS, row.key);
          return [{ row, incident: null, alsoAffected: [] }];
        }
        const incident = this.incident(row.incidentId);
        if (incident === null) return [];
        if (ACTION_KINDS.some((kind) => kind === row.kind)) {
          // The group decides: an open, unacknowledged carrier (the row's own incident, or the member that took over).
          const carrier = this.carrierFor(incident);
          if (carrier === null || carrier.acknowledgedAt !== null || carrier.alertMode !== "page") {
            this.rows("UPDATE outbox SET status = 'cancelled', claim_until = NULL WHERE key = ?", row.key);
            return [];
          }
        }
        this.rows("UPDATE outbox SET claim_until = ? WHERE key = ?", now + CLAIM_MS, row.key);
        return [{ row, incident, alsoAffected: this.alsoAffected(incident) }];
      });
    });
  }

  /**
   * The provider accepted the send under `providerId`. A final status that arrived for that id before this call (early_status)
   * is applied now, with `policy` for its failover and early escalation.
   */
  markSent(key: string, providerId: string, now: number, policy: EscalationPolicy | null = null): void {
    this.storage.transactionSync(() => {
      const sent = this.rows(
        `UPDATE outbox SET status = 'sent', sent_at = ?, provider_id = ?, attempts = attempts + 1, claim_until = NULL, last_error = NULL WHERE key = ?
         RETURNING *`,
        now, providerId.slice(0, 80), key,
      )[0];
      const row = sent === undefined ? null : outboxFrom(sent);
      // The archived timeline: who was paged, when, on which channel.
      if (row?.kind === "page") this.event(row.incidentId, now, "paged", row.key, { tierId: row.tierId, contactId: row.contactId, channel: row.channel });
      // An email went out: alert email works again.
      if (row?.channel === "email" && !providerId.startsWith("log:")) {
        if (this.rows("DELETE FROM meta WHERE key LIKE 'channel_problem:%' RETURNING key").length > 0) this.markReportDue();
      }
      const early = this.rows("DELETE FROM early_status WHERE provider_id = ? RETURNING status, code", providerId.slice(0, 80))[0];
      if (row !== null && early !== undefined) this.applyProviderStatus(row, text(early, "status"), nullableText(early, "code"), now, policy);
    });
  }

  /**
   * A failed attempt: retried with backoff, or failed for good (not retryable, or MAX_ATTEMPTS). A final failure runs
   * failFinally: contact health, and with `policy` failover, early escalation and the email channel alert.
   */
  markFailed(key: string, code: string, retryable: boolean, now: number, policy: EscalationPolicy | null = null): void {
    this.storage.transactionSync(() => {
      // A row cancelled while its send was in flight stays cancelled.
      const current = this.rows("SELECT * FROM outbox WHERE key = ? AND status = 'pending'", key)[0];
      if (current === undefined) return;
      const row = outboxFrom(current);
      const attempts = row.attempts + 1;
      const final = !retryable || attempts >= MAX_ATTEMPTS;
      this.rows(
        "UPDATE outbox SET status = ?, attempts = ?, next_attempt_at = ?, claim_until = NULL, last_error = ? WHERE key = ?",
        final ? "failed" : "pending", attempts, final ? now : now + backoffMs(attempts), code.slice(0, 64), key,
      );
      if (final && !NON_INCIDENT_KINDS.includes(row.kind)) {
        this.event(row.incidentId, now, "failed", `${row.kind} failed`, { tierId: row.tierId, contactId: row.contactId, channel: row.channel, code });
      }
      if (final) this.failFinally({ ...row, status: "failed", attempts, lastError: code }, code, now, policy);
    });
  }

  /**
   * For the heartbeat: is paging failing (a final failure, or a send stuck pending), for incidents that still need
   * someone? Judged by the group, like failover: a page the old carrier sent keeps that carrier's incident id after the
   * hand-over, and its failure still counts while the group's open carrier is unacknowledged.
   */
  pagingHealth(now: number): PagingHealth {
    // Incidents in a live group, plus (recursively) any that handed their escalation to one when their component
    // stopped paging (carrierFor): their failed pages still belong to a group that needs someone.
    const failed = this.rows(
      `WITH RECURSIVE live(id) AS (
         SELECT i.id FROM incidents i WHERE COALESCE(i.group_id, i.id) IN (
           SELECT COALESCE(c.group_id, c.id) FROM incidents c WHERE c.resolved_at IS NULL AND c.acknowledged_at IS NULL AND c.phase != 'grouped'
           AND c.alert_mode = 'page')
         UNION SELECT p.id FROM incidents p JOIN live ON p.handed_over_to = live.id WHERE p.alert_mode != 'page')
       SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed' AND kind IN (${ACTION_KINDS_SQL}) AND incident_id IN (SELECT id FROM live)`,
    )[0];
    const pending = this.rows(`SELECT MIN(created_at) AS at FROM outbox WHERE status = 'pending' AND kind IN (${ACTION_KINDS_SQL})`)[0];
    const oldest = nullableNum(pending, "at");
    return { failedPages: num(failed, "n"), oldestPendingMs: oldest === null ? null : Math.max(0, now - oldest) };
  }

  /** The earliest moment anything needs the object: an escalation deadline, a retry, or an expired claim. */
  nextWakeAt(): number | null {
    const row = this.rows(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(next_alarm_at) AS at FROM incidents WHERE resolved_at IS NULL AND next_alarm_at IS NOT NULL
         UNION ALL SELECT MIN(MAX(next_attempt_at, COALESCE(claim_until, 0))) FROM outbox WHERE status = 'pending')`,
    )[0];
    return nullableNum(row, "at");
  }

  /**
   * Queues a one-time monitor-health email (not a page) to the first tier's email contacts: `code` names the notice
   * and `since` identifies its streak, so it is sent once per streak.
   */
  queueMonitorNotice(code: string, since: number, policy: EscalationPolicy, now: number): number {
    return this.storage.transactionSync(() => {
      const incidentId = `mon_${code}_${String(since)}`;
      let queued = 0;
      for (const contact of policy.tiers[0]?.contacts ?? []) {
        if (contact.email === null) continue;
        const inserted = this.rows(
          `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
           attempts, next_attempt_at, created_at) VALUES (?, ?, 'monitor_notice', ?, ?, 'email', ?, NULL, 0, ?, 'pending', 0, ?, ?) RETURNING key`,
          `${incidentId}:monitor_notice:${contact.id}:email`, incidentId, contact.id, contact.name, contact.email, JSON.stringify({ detail: code }), now, now,
        );
        queued += inserted.length;
      }
      return queued;
    });
  }

  /** True (and counted) when another SMS reply to this contact is allowed: at most REPLY_LIMIT per REPLY_WINDOW_MS. */
  allowReply(contactId: string, now: number): boolean {
    return this.storage.transactionSync(() => {
      const recent = num(this.rows("SELECT COUNT(*) AS n FROM sms_replies WHERE contact_id = ? AND at > ?", contactId, now - REPLY_WINDOW_MS)[0], "n");
      if (recent >= REPLY_LIMIT) return false;
      this.rows("INSERT INTO sms_replies (contact_id, at) VALUES (?, ?)", contactId, now);
      return true;
    });
  }
}
