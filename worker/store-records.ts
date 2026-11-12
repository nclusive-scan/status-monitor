// The monitor store's records layer (store.ts): the last-known-good platform configuration and its pull status, the
// report bookkeeping, retention, and the read views behind the status page, the private view and the report.
import type { EscalationPolicy } from "./config.ts";
import { nullableText, num, text } from "./schema.ts";
import type { Status } from "./types.ts";
import type {
  AcceptEffects, AcceptOutcome, CheckLatest, ConfigFetchStatus, IncidentEvent, IncidentRow, OutboxRow, StoredPlatformConfig, Uptime,
} from "./store-rows.ts";
import {
  ACTION_KINDS, eventFrom, FAILED_STATUSES_SQL, HOUR, incidentFrom, NON_INCIDENT_SQL, OPEN_INCIDENT_CAP, outboxFrom, REPLY_WINDOW_MS, REPORT_INCIDENTS,
  RETENTION_MS, statusOf, UNEXPORTED_RETENTION_MS,
} from "./store-rows.ts";
import { StoreBase } from "./store-base.ts";

export class StoreRecords extends StoreBase {
  platformConfig(): StoredPlatformConfig | null {
    const row = this.rows("SELECT * FROM platform_config WHERE id = 1")[0];
    if (row === undefined) return null;
    return {
      revision: num(row, "revision"), updatedAt: nullableText(row, "updated_at"), updatedBy: nullableText(row, "updated_by"), body: text(row, "body"),
      fetchedAt: num(row, "fetched_at"),
    };
  }

  /**
   * Offers a validated platform revision. Only a revision above the stored one is accepted (with its config-change
   * notices, in the same transaction); the same revision with the same body is a no-op; a lower revision, or the same
   * revision with a different body, is refused and recorded. Revision 0 ("nothing saved yet") is accepted only while
   * nothing is stored, and changes nothing.
   */
  acceptPlatformConfig(
    offered: { readonly revision: number; readonly updatedAt: string | null; readonly updatedBy: string | null; readonly body: string },
    now: number,
    effects: AcceptEffects = {},
  ): AcceptOutcome {
    return this.storage.transactionSync(() => {
      const current = this.platformConfig();
      const stored = current?.revision ?? 0;
      const refuse = (outcome: AcceptOutcome, code: string): AcceptOutcome => {
        this.setFetchError(code, `offered revision ${String(offered.revision)}, stored ${String(stored)}`, now, offered.revision);
        return outcome;
      };
      if (offered.revision < stored || (offered.revision === 0 && current !== null)) return refuse("refused_lower", "config_revision_lower");
      let outcome: AcceptOutcome;
      if (offered.revision === 0) outcome = "empty";
      else if (current !== null && offered.revision === stored) {
        if (offered.body !== current.body) return refuse("refused_conflict", "config_revision_conflict");
        this.rows("UPDATE platform_config SET fetched_at = ? WHERE id = 1", now);
        outcome = "unchanged";
      } else {
        const queued = effects.notices?.(current) ?? null;
        const revision = String(offered.revision);
        queued?.recipients.forEach((recipient, index) => {
          this.rows(
            `INSERT OR IGNORE INTO outbox (key, incident_id, kind, contact_id, contact_name, channel, recipient, tier_id, cycle, payload, status,
             attempts, next_attempt_at, created_at) VALUES (?, ?, 'config_change', ?, ?, 'email', ?, NULL, 0, ?, 'pending', 0, ?, ?)`,
            `cfg_r${revision}:config_change:${String(index)}:email`, `cfg_r${revision}`, recipient.contactId, recipient.contactName, recipient.email,
            JSON.stringify({ configChange: queued.change }), now, now,
          );
        });
        this.rows(
          `INSERT INTO platform_config (id, revision, updated_at, updated_by, body, fetched_at, accepted_at) VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
           body = excluded.body, fetched_at = excluded.fetched_at, accepted_at = excluded.accepted_at`,
          offered.revision, offered.updatedAt, offered.updatedBy, offered.body, now, now,
        );
        if (effects.policy !== undefined && effects.policy !== null) this.reconcileRecipients(effects.policy, offered.revision, now);
        this.markReportDue();
        outcome = "accepted";
      }
      this.setMeta("config_fetch_ok_at", String(now));
      this.setMeta("config_fetch_error", "");
      return outcome;
    });
  }

  /**
   * Outbox rows copy the recipient's address when they are queued, and a failed send retries for up to ~45 minutes. After
   * a revision changes the contacts, a pending page or notice for a contact who is gone (or lost that channel) is
   * cancelled, and any pending incident send to a contact whose number or address changed goes to the new one. Config-
   * change notices are left alone: telling the old contacts is their purpose.
   */
  private reconcileRecipients(policy: EscalationPolicy, revision: number, now: number): void {
    const contacts = new Map(policy.tiers.flatMap((tier) => tier.contacts.map((contact) => [contact.id, contact] as const)));
    const touched = new Map<string, { cancelled: number; retargeted: number }>();
    const pending = this.rows(
      `SELECT key, incident_id, kind, contact_id, channel, recipient FROM outbox WHERE status = 'pending' AND kind NOT IN (${NON_INCIDENT_SQL})`,
    );
    for (const row of pending) {
      const contact = contacts.get(text(row, "contact_id"));
      const address = contact === undefined ? null : text(row, "channel") === "email" ? contact.email : contact.sms;
      const counts = touched.get(text(row, "incident_id")) ?? { cancelled: 0, retargeted: 0 };
      if (address === null || contact === undefined) {
        if (!ACTION_KINDS.some((kind) => kind === text(row, "kind"))) continue;
        this.rows("UPDATE outbox SET status = 'cancelled', claim_until = NULL WHERE key = ?", text(row, "key"));
        counts.cancelled += 1;
      } else if (address !== text(row, "recipient")) {
        this.rows("UPDATE outbox SET recipient = ?, contact_name = ? WHERE key = ?", address, contact.name, text(row, "key"));
        counts.retargeted += 1;
      } else continue;
      touched.set(text(row, "incident_id"), counts);
    }
    for (const [incidentId, counts] of touched) {
      const detail = `revision ${String(revision)}: cancelled ${String(counts.cancelled)}, re-addressed ${String(counts.retargeted)} pending`;
      this.event(incidentId, now, "notify", detail);
    }
  }

  private setFetchError(code: string, detail: string, now: number, revision: number | null = null): void {
    const previous = this.getMeta("config_fetch_error"), previousRevision = this.getMeta("config_fetch_error_revision");
    this.setMeta("config_fetch_error", code.slice(0, 64));
    this.setMeta("config_fetch_error_detail", detail.slice(0, 500));
    this.setMeta("config_fetch_error_at", String(now));
    this.setMeta("config_fetch_error_revision", revision === null ? "" : String(revision));
    // A newly refused revision is news for the platform ("Monitor refused revision N").
    if (previous !== code.slice(0, 64) || previousRevision !== (revision === null ? "" : String(revision))) this.markReportDue();
  }

  /** A pull that failed (network, rejected, invalid document): the stored revision stays in force. */
  recordConfigFetchError(code: string, detail: string, now: number, revision: number | null = null): void {
    this.storage.transactionSync(() => {
      this.setFetchError(code, detail, now, revision);
    });
  }

  configFetchStatus(): ConfigFetchStatus {
    const at = (key: string): number | null => {
      const value = this.getMeta(key);
      return value === null || value === "" ? null : Number(value);
    };
    const code = this.getMeta("config_fetch_error");
    const hasError = code !== null && code !== "";
    return {
      lastSuccessAt: at("config_fetch_ok_at"),
      lastErrorCode: hasError ? code : null,
      lastErrorAt: hasError ? at("config_fetch_error_at") : null,
      lastErrorDetail: hasError ? this.getMeta("config_fetch_error_detail") : null,
      lastErrorRevision: hasError ? at("config_fetch_error_revision") : null,
    };
  }

  recordConfigError(code: string, now: number): void {
    this.storage.transactionSync(() => {
      this.setMeta("config_error", code.slice(0, 500));
      this.setMeta("config_error_at", String(now));
    });
  }

  /**
   * Hourly: drops history older than 35 days, and resolved incidents (with their outbox rows and log) once the platform
   * has archived them and they are 35 days old. An incident the platform never archived is kept for 180 days, then
   * pruned anyway with a recorded warning (incidents_pruned_unexported), so a long platform outage cannot fill storage.
   * With `archived: false` (standalone: no platform archives anything) every resolved incident goes at 35 days, with
   * no warning.
   */
  prune(now: number, options: { readonly archived?: boolean } = {}): void {
    const archived = options.archived ?? true;
    const cutoff = now - RETENTION_MS, hardCutoff = archived ? now - UNEXPORTED_RETENTION_MS : cutoff;
    this.storage.transactionSync(() => {
      this.rows("DELETE FROM check_results WHERE observed_at < ?", cutoff);
      this.rows("DELETE FROM runs WHERE started_at < ?", cutoff);
      this.rows("DELETE FROM component_hourly WHERE hour < ?", Math.floor(cutoff / HOUR));
      const unexported = num(this.rows(
        "SELECT COUNT(*) AS n FROM incidents WHERE resolved_at IS NOT NULL AND exported_at IS NULL AND resolved_at < ?", hardCutoff,
      )[0], "n");
      if (archived && unexported > 0) {
        this.setMeta("pruned_unexported_count", String(Number(this.getMeta("pruned_unexported_count") ?? "0") + unexported));
        this.setMeta("pruned_unexported_at", String(now));
      }
      const old = `SELECT id FROM incidents WHERE resolved_at IS NOT NULL AND
        ((exported_at IS NOT NULL AND resolved_at < ?) OR (exported_at IS NULL AND resolved_at < ?))`;
      this.rows(`DELETE FROM outbox WHERE incident_id IN (${old})`, cutoff, hardCutoff);
      this.rows(`DELETE FROM outbox WHERE kind IN (${NON_INCIDENT_SQL}) AND created_at < ?`, cutoff);
      this.rows(`DELETE FROM incident_events WHERE incident_id IN (${old})`, cutoff, hardCutoff);
      this.rows(`DELETE FROM incidents WHERE id IN (${old})`, cutoff, hardCutoff);
      this.rows("DELETE FROM sms_replies WHERE at < ?", now - REPLY_WINDOW_MS);
      this.rows("DELETE FROM early_status WHERE at < ?", now - HOUR);
      this.setMeta("last_prune_at", String(now));
    });
  }

  /** True when a report should go now: something changed since the last report the platform took, or `everyMs` has passed. */
  reportDue(now: number, everyMs: number): boolean {
    const last = Number(this.getMeta("report_last_ok_at") ?? "0");
    return this.reportSeq() > Number(this.getMeta("report_sent_seq") ?? "0") || now - last >= everyMs;
  }

  /**
   * The platform took the report built at report-due counter `reportedSeq` (reportSeq() when it was prepared): what it
   * archived (of what was sent) is marked exported, and changes up to that counter count as reported. A change marked
   * after the report was built keeps the next run's report due.
   */
  recordReportSent(sentIds: readonly string[], archived: readonly string[], now: number, reportedSeq: number): number {
    const sent = new Set(sentIds);
    const marked = this.markExported(archived.filter((id) => sent.has(id)), now);
    this.storage.transactionSync(() => {
      this.setMeta("report_sent_seq", String(Math.max(reportedSeq, Number(this.getMeta("report_sent_seq") ?? "0"))));
      this.setMeta("report_last_ok_at", String(now));
      this.setMeta("report_error", "");
      this.setMeta("report_incidents_refused", "");
    });
    return marked;
  }

  /**
   * The report failed; it is retried at the next run (nothing counts as reported). Refused as invalid (400) while it
   * carried incidents: the next report goes without them (reportIncidentsRefused), so one incident the platform will
   * not take cannot keep the monitor state from it; the one after tries the incidents again.
   */
  recordReportFailed(code: string, now: number, incidentCount = 0): void {
    this.storage.transactionSync(() => {
      this.setMeta("report_error", code.slice(0, 64));
      this.setMeta("report_error_at", String(now));
      if (code === "report_status_400" && incidentCount > 0) this.setMeta("report_incidents_refused", "1");
    });
  }

  /** True when the last report carrying incidents was refused as invalid and no report has been taken since. */
  reportIncidentsRefused(): boolean {
    return this.getMeta("report_incidents_refused") === "1";
  }

  reportStatus(): { readonly lastOkAt: number | null; readonly lastErrorCode: string | null; readonly lastErrorAt: number | null } {
    const at = (key: string): number | null => {
      const value = this.getMeta(key);
      return value === null || value === "" ? null : Number(value);
    };
    const error = this.getMeta("report_error");
    const failed = error !== null && error !== "";
    return { lastOkAt: at("report_last_ok_at"), lastErrorCode: failed ? error : null, lastErrorAt: failed ? at("report_error_at") : null };
  }

  /** How many unexported incidents retention has had to drop, and when last (null: never). */
  prunedUnexported(): { readonly count: number; readonly at: number | null } {
    const at = this.getMeta("pruned_unexported_at");
    return { count: Number(this.getMeta("pruned_unexported_count") ?? "0"), at: at === null || at === "" ? null : Number(at) };
  }

  /** Resolved incidents (drills included) the platform has not archived yet, oldest first. */
  unexportedIncidents(limit = REPORT_INCIDENTS): IncidentRow[] {
    return this.rows("SELECT * FROM incidents WHERE resolved_at IS NOT NULL AND exported_at IS NULL ORDER BY resolved_at, id LIMIT ?", limit)
      .map(incidentFrom);
  }

  /** Marks the given incidents archived, but only those that are resolved (the report only ever sends those). */
  markExported(ids: readonly string[], now: number): number {
    return this.storage.transactionSync(() => {
      let marked = 0;
      for (const id of ids) {
        marked += this.rows("UPDATE incidents SET exported_at = ? WHERE id = ? AND resolved_at IS NOT NULL AND exported_at IS NULL RETURNING id", now, id)
          .length;
      }
      return marked;
    });
  }

  /** Every event of one incident, oldest first (the archived timeline). */
  incidentEvents(incidentId: string): IncidentEvent[] {
    return this.rows("SELECT * FROM incident_events WHERE incident_id = ? ORDER BY at, id", incidentId).map(eventFrom);
  }

  /** Delivery counts of one incident's outbox rows: handed to the provider, confirmed delivered, failed for good. */
  deliveryCounts(incidentId: string): { readonly sent: number; readonly delivered: number; readonly failed: number } {
    const row = this.rows(
      `SELECT SUM(sent_at IS NOT NULL) AS sent, SUM(delivery_status = 'delivered') AS delivered,
       SUM(status = 'failed' OR delivery_status IN (${FAILED_STATUSES_SQL})) AS failed FROM outbox WHERE incident_id = ?`, incidentId,
    )[0];
    return { sent: num(row, "sent"), delivered: num(row, "delivered"), failed: num(row, "failed") };
  }

  uptime(now: number): Map<string, Uptime> {
    const hour = Math.floor(now / HOUR);
    const windowed = (hours: number): Map<string, number> =>
      new Map(this.rows(
        "SELECT component_id, SUM(up) AS up, SUM(total) AS total FROM component_hourly WHERE hour > ? GROUP BY component_id", hour - hours,
      ).map((row) => [text(row, "component_id"), num(row, "total") === 0 ? Number.NaN : num(row, "up") / num(row, "total")]));
    const [h24, d7, d30] = [windowed(24), windowed(168), windowed(720)];
    const ids = new Set([...d30.keys()]);
    const value = (map: Map<string, number>, id: string): number | null => {
      const ratio = map.get(id);
      return ratio === undefined || Number.isNaN(ratio) ? null : Math.round(ratio * 100_000) / 1000;
    };
    return new Map([...ids].map((id) => [id, { h24: value(h24, id), d7: value(d7, id), d30: value(d30, id) }]));
  }

  /** Every open incident (an exhausted one stays visible however many come after it), then the most recently resolved. */
  incidents(now: number, resolvedLimit = 50): IncidentRow[] {
    const open = this.rows("SELECT * FROM incidents WHERE resolved_at IS NULL AND drill = 0 ORDER BY opened_at DESC LIMIT ?", OPEN_INCIDENT_CAP);
    const closed = this.rows(
      "SELECT * FROM incidents WHERE resolved_at IS NOT NULL AND drill = 0 AND resolved_at >= ? ORDER BY opened_at DESC LIMIT ?", now - RETENTION_MS,
      resolvedLimit,
    );
    return [...open, ...closed].map(incidentFrom);
  }

  /** The most recent drills (private view only; drills never show on the status page). */
  drills(limit = 10): IncidentRow[] {
    return this.rows("SELECT * FROM incidents WHERE drill = 1 ORDER BY opened_at DESC LIMIT ?", limit).map(incidentFrom);
  }

  checkLatest(): CheckLatest[] {
    return this.rows("SELECT * FROM check_latest ORDER BY check_id").map((row) => {
      let data: unknown = null;
      try {
        const raw = text(row, "data");
        data = JSON.parse(raw === "" ? "null" : raw);
      } catch {
        data = null;
      }
      return {
        checkId: text(row, "check_id"), componentId: text(row, "component_id"), type: text(row, "type"), status: statusOf(text(row, "status")),
        inconclusive: num(row, "inconclusive") === 1, latencyMs: num(row, "latency_ms"), detail: text(row, "detail"),
        observedAt: num(row, "observed_at"), data,
      };
    });
  }

  recentFailures(limit = 50): { checkId: string; status: Status; detail: string; observedAt: number; latencyMs: number }[] {
    return this.rows(
      "SELECT check_id, status, detail, observed_at, latency_ms FROM check_results WHERE status != 'ok' ORDER BY observed_at DESC LIMIT ?", limit,
    ).map((row) => ({
      checkId: text(row, "check_id"), status: statusOf(text(row, "status")), detail: text(row, "detail"), observedAt: num(row, "observed_at"),
      latencyMs: num(row, "latency_ms"),
    }));
  }

  notifications(limit = 200): OutboxRow[] {
    return this.rows("SELECT * FROM outbox ORDER BY created_at DESC, key LIMIT ?", limit).map(outboxFrom);
  }

  events(limit = 200): IncidentEvent[] {
    return this.rows("SELECT * FROM incident_events ORDER BY at DESC, id DESC LIMIT ?", limit).map(eventFrom);
  }

  /** A webhook with a bad X-Twilio-Signature: counted for the private view. */
  recordSignatureRejected(now: number): void {
    this.storage.transactionSync(() => {
      this.setMeta("twilio_signature_rejected_count", String(Number(this.getMeta("twilio_signature_rejected_count") ?? "0") + 1));
      this.setMeta("twilio_signature_rejected_at", String(now));
    });
  }

  signatureRejections(): { readonly count: number; readonly lastAt: number | null } {
    const at = this.getMeta("twilio_signature_rejected_at");
    return { count: Number(this.getMeta("twilio_signature_rejected_count") ?? "0"), lastAt: at === null || at === "" ? null : Number(at) };
  }
}
