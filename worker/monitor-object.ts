// The single SQLite-backed Durable Object that owns all monitor state. The cron Worker hands it each run's results;
// the Pages binding asks it for status and acknowledgements; its alarm drives escalation deadlines and delivery
// retries. State changes are synchronous transactions (store.ts); provider calls happen after they commit.
//
// Every config read here is the effective configuration: the stored platform revision (last known good) over the env
// bootstrap (platform-config.ts), the same one the cron Worker resolves for its checks.
//
// Rescheduling always runs: ingest and alarm re-arm the alarm in a finally block, falling back to a fixed
// ALARM_FALLBACK_MS when computing the next wake-up itself fails. Alarms retry at most 6 times and then stop until
// setAlarm is called again, and the cron that would otherwise re-arm it is exactly what fails in a Cloudflare incident.
//
// The webhook paths (an inbound SMS, a Twilio status callback, an acknowledgement or escalation link) only change state
// and wake the alarm (at the 1 s floor); the alarm sends what they queued. Twilio gets its TwiML answer, and the person
// their page, without waiting on any provider call.
import { DurableObject } from "cloudflare:workers";
import type { AckPageView } from "./ack-actions.ts";
import { ackPageView, acknowledgeByLink, acknowledgeBySms, escalateByLink } from "./ack-actions.ts";
import type { ConfigResult, MonitorConfig, TargetsConfig } from "./config.ts";
import { systemRandom } from "./crypto.ts";
import { deliver } from "./deliver.ts";
import { createLimiter } from "./limit.ts";
import type { Env } from "./env.ts";
import { envRecord } from "./env.ts";
import type { EmailSender } from "./notify/email.ts";
import { createEmailSender } from "./notify/email.ts";
import type { ApplyResult } from "./platform-config.ts";
import { applyPlatformDocument, resolveConfig, SectionsCache } from "./platform-config.ts";
import type { PublicStatus } from "./redact.ts";
import { privateProjection, publicProjection } from "./redact.ts";
import type { PreparedReport } from "./report.ts";
import { buildReport, REPORT_EVERY_MS } from "./report.ts";
import { fullSnapshot, publicSnapshot, TimedCache } from "./status-view.ts";
import type { AckOutcome, EscalateOutcome, PagingHealth, StoredPlatformConfig } from "./store.ts";
import { CLAIM_BATCH, DELIVERY_CONCURRENCY, MonitorStore } from "./store.ts";
import type { CheckResult } from "./types.ts";
import { DNS_INCONCLUSIVE_NOTICE_MS } from "./warnings.ts";

const PRUNE_EVERY_MS = 3600_000;
const CONFIG_RETRY_MS = 60_000;
export const ALARM_FALLBACK_MS = 30_000;
/**
 * The earliest an alarm is ever set: one second from now. workerd loses an alarm set to exactly the scheduled time of
 * the alarm that is running (https://github.com/cloudflare/workerd/issues/7915), which "next step is due now" would
 * do. Keep this floor (test/monitor-object.test.ts guards it).
 */
export const ALARM_FLOOR_MS = 1000;

/** When to set the alarm for a wake-up due at `next` (null: none), never sooner than ALARM_FLOOR_MS from now. */
export const alarmTime = (next: number | null, now: number): number | null => (next === null ? null : Math.max(next, now + ALARM_FLOOR_MS));

export interface IngestOutcome {
  readonly opened: string[];
  readonly resolved: string[];
  readonly paging: PagingHealth;
}

export class MonitorObject extends DurableObject<Env> {
  private readonly store: MonitorStore;
  private email: { readonly key: string; readonly sender: EmailSender } | null = null;
  private readonly sections = new SectionsCache();
  private readonly publicCache = new TimedCache<PublicStatus>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new MonitorStore(ctx.storage, systemRandom);
  }

  private loaded(): ConfigResult {
    return resolveConfig(envRecord(this.env), this.store.platformConfig(), this.sections);
  }

  private config(): MonitorConfig | null {
    const loaded = this.loaded();
    if (loaded.ok) return loaded.config;
    this.store.recordConfigError(loaded.errors.join("; "), Date.now());
    return null;
  }

  /** The ALERT_EMAIL binding as a sender, rebuilt only when the sender identity changes. */
  private emailSender(config: MonitorConfig): EmailSender | null {
    const binding = this.env.ALERT_EMAIL;
    if (config.email === null || binding === undefined) return null;
    const key = `${config.email.from}:${config.email.fromName}`;
    if (this.email?.key !== key) this.email = { key, sender: createEmailSender(binding, config.email) };
    return this.email.sender;
  }

  /** The last-known-good platform configuration, for the cron Worker's own effective config. */
  storedPlatformConfig(): StoredPlatformConfig | null {
    return this.store.platformConfig();
  }

  /** A fetched /api/v2/monitor/config body: validated, accepted only above the stored revision, then delivered. */
  async offerPlatformConfig(body: string, now: number): Promise<ApplyResult> {
    const result = applyPlatformDocument(this.store, envRecord(this.env), body, now);
    if (result.outcome === "accepted") {
      this.publicCache.invalidate();
      const config = this.config();
      if (config !== null) {
        try {
          await this.deliverDue(config);
        } finally {
          await this.safeReschedule();
        }
      }
    }
    return result;
  }

  recordConfigFetchError(code: string, now: number): void {
    this.store.recordConfigFetchError(code, "", now);
  }

  /**
   * Folds one run. `checked` is the targets the results came from: the config pull runs beside the checks and can accept
   * a new revision before they finish, and folding old results against new targets would skip the components it adds,
   * count a moved check toward its old component and close a removed component's incident within the same run. The
   * policy is the current one, so whoever gets paged is always up to date; the new targets apply from the next run.
   */
  async ingest(results: CheckResult[], now: number, checked: TargetsConfig): Promise<IngestOutcome> {
    try {
      const config = this.config();
      if (config === null) throw new Error("MONITOR_CONFIG_INVALID");
      const outcome = this.store.recordRun(results, checked, config.policy, now, { maintenance: config.maintenance });
      this.publicCache.invalidate();
      // Standalone, nothing archives incidents, so they are pruned at 35 days like the history (no unexported warning).
      if (now - Number(this.store.getMeta("last_prune_at") ?? 0) > PRUNE_EVERY_MS) this.store.prune(now, { archived: config.mode === "platform" });
      this.store.startDueDrill(config.policy, now);
      this.store.markUnknownDeliveries(now);
      const dnsSince = this.store.dnsInconclusiveSince();
      if (dnsSince !== null && now - dnsSince >= DNS_INCONCLUSIVE_NOTICE_MS) this.store.queueMonitorNotice("dns_inconclusive", dnsSince, config.policy, now);
      await this.deliverDue(config);
      return { ...outcome, paging: this.store.pagingHealth(Date.now()) };
    } finally {
      await this.safeReschedule();
    }
  }

  recordConfigError(code: string, now: number): void {
    this.store.recordConfigError(code, now);
    this.publicCache.invalidate();
  }

  override async alarm(): Promise<void> {
    const config = this.config();
    if (config === null) {
      await this.ctx.storage.setAlarm(Date.now() + CONFIG_RETRY_MS);
      return;
    }
    try {
      if (this.store.advanceDue(config.policy, Date.now()) > 0) this.publicCache.invalidate();
      await this.deliverDue(config);
    } finally {
      await this.safeReschedule();
    }
  }

  /** Sends what is due, DELIVERY_CONCURRENCY at a time; each provider timeout starts once its send holds a slot. */
  private async deliverDue(config: MonitorConfig): Promise<void> {
    const email = this.emailSender(config);
    const limiter = createLimiter(DELIVERY_CONCURRENCY);
    for (let round = 0; round < 4; round += 1) {
      const claimed = this.store.claimDue(Date.now(), CLAIM_BATCH);
      if (claimed.length === 0) return;
      await Promise.all(
        claimed.map(({ row, incident, alsoAffected }) => limiter.run(async () => {
          try {
            const result = await deliver(row, incident, { config, fetch, email, now: Date.now() }, alsoAffected);
            if (result.ok) this.store.markSent(row.key, result.providerId, Date.now(), config.policy);
            else this.store.markFailed(row.key, result.code, result.retryable, Date.now(), config.policy);
          } catch {
            this.store.markFailed(row.key, "delivery_error", true, Date.now(), config.policy);
          }
        })),
      );
    }
  }

  private async reschedule(): Promise<void> {
    const next = alarmTime(this.store.nextWakeAt(), Date.now());
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  /** reschedule, or when that throws, a fixed retry so the alarm chain never ends on an error. */
  private async safeReschedule(): Promise<void> {
    try {
      await this.reschedule();
    } catch (error) {
      console.error(JSON.stringify({ event: "monitor_reschedule_error", code: error instanceof Error ? error.name : "unknown" }));
      await this.ctx.storage.setAlarm(Date.now() + ALARM_FALLBACK_MS);
    }
  }

  /**
   * The report to send now (JSON body, the incidents in it and the report-due counter it was built at), or null when
   * none is due. Runs even with a refused config. Right after a report with incidents was refused as invalid, this one
   * carries none, so the monitor state still reaches the platform.
   */
  prepareReport(now: number): PreparedReport | null {
    if (!this.store.reportDue(now, REPORT_EVERY_MS)) return null;
    const seq = this.store.reportSeq();
    const built = buildReport(this.store, this.loaded(), envRecord(this.env), now, { withoutIncidents: this.store.reportIncidentsRefused() });
    return { ...built, seq };
  }

  reportSent(incidentIds: readonly string[], archived: readonly string[], now: number, seq: number): number {
    return this.store.recordReportSent(incidentIds, archived, now, seq);
  }

  reportFailed(code: string, now: number, incidentCount: number): void {
    this.store.recordReportFailed(code, now, incidentCount);
  }

  /** Public, unauthenticated: cheap reads only, and the projection is cached for 15 s (rebuilt after any change). */
  publicStatus(now: number): PublicStatus {
    return this.publicCache.get(now, () => publicProjection(publicSnapshot(this.store, this.loaded(), now, envRecord(this.env))));
  }

  /** Serialized here: the projection holds free-form diagnostics (unknown), which the RPC stub would type as never. */
  privateStatus(now: number): string {
    return JSON.stringify(privateProjection(fullSnapshot(this.store, this.loaded(), now, envRecord(this.env))));
  }

  incidentForAck(incidentId: string, contactId: string): AckPageView | null {
    const config = this.config();
    return config === null ? null : ackPageView(this.store, config.policy, incidentId, contactId);
  }

  /** Acknowledges from an email link. The notices it queues go out from the alarm, a second later. */
  async acknowledgeByLink(incidentId: string, contactId: string, now: number): Promise<AckOutcome> {
    const config = this.config();
    if (config === null) return "not_found";
    try {
      const outcome = acknowledgeByLink(this.store, config.policy, incidentId, contactId, now);
      if (outcome === "acknowledged") this.publicCache.invalidate();
      return outcome;
    } finally {
      await this.safeReschedule();
    }
  }

  /** The escalate button on the acknowledgement page: the next tier is paged (from the alarm) now. */
  async escalateByLink(incidentId: string, contactId: string, now: number): Promise<EscalateOutcome> {
    const config = this.config();
    if (config === null) return { outcome: "not_found", tierName: null };
    try {
      return escalateByLink(this.store, config.policy, incidentId, contactId, now);
    } finally {
      await this.safeReschedule();
    }
  }

  /**
   * Returns the SMS reply text, or null to send no reply. Never waits on a delivery: anything the message queued
   * (acknowledgement notices, an escalation, an opt-out notice) is sent by the alarm, so the TwiML answer goes first.
   */
  async acknowledgeBySms(from: string, body: string, now: number): Promise<string | null> {
    const config = this.config();
    if (config === null) return null;
    const { reply, changed } = acknowledgeBySms(this.store, config.policy, from, body, now);
    if (changed) {
      this.publicCache.invalidate();
      await this.safeReschedule();
    }
    return reply;
  }

  /**
   * A Twilio status callback (already signature-checked): records the status by message SID; a failure fails over,
   * updates contact health and may escalate early, all sent from the alarm. False when no send has this SID.
   */
  async recordSmsStatus(messageSid: string, status: string, code: string | null, now: number): Promise<boolean> {
    const config = this.config();
    try {
      return this.store.recordProviderStatus(messageSid, status, code, now, config?.policy ?? null) !== null;
    } finally {
      await this.safeReschedule();
    }
  }

  /** A webhook arrived with a bad X-Twilio-Signature: counted for the private view. */
  recordTwilioSignatureRejected(now: number): void {
    this.store.recordSignatureRejected(now);
  }
}
