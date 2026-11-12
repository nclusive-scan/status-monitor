// The report channel (Worker -> platform): POST /api/v2/monitor/report on PLATFORM_CONFIG_URL's origin, signed with
// protocol v2 and the CONFIG key, JSON, at most 64 KiB. It tells the platform which revision is
// running (or why one was refused), the monitor's warnings, per-contact delivery health, and hands over resolved
// incidents for the platform's append-only archive.
//
// Sent every REPORT_EVERY_MS and at the next run after an applied revision, a contact-health change, a refused revision
// or a resolved incident (store.markReportDue). The platform answers 200 {"archived": [incidentId, ...]}; those
// incidents are marked exported, and only exported incidents are pruned at 35 days (store.prune).
//
// Contact ids only, by construction: never phone numbers, email addresses, message bodies or ACK codes. Every code goes
// out as the monitor records it (safeCode's alphabet, which is the platform's MONITOR_CODE), and anything outside it is
// sent as "invalid_detail" (reportCode), because the platform refuses the whole body over one code outside it, and the
// same unexported incidents would then be refused at every run.
//
// Size: at most MAX_REPORT_BYTES. Contact health carries only channels with a problem (a channel back to "ok" is left
// out: the platform replaces the whole state each time, and no row means healthy). Over the limit, fewer incidents go
// (the rest wait for the next report); if the body is still too large with none, contact health is cut, the problems
// most worth acting on kept first, and the report says so (contact_health_truncated).
//
// A report the platform refuses as invalid (400) while it carried incidents is followed by one without incidents, so
// the monitor state still arrives (report_incidents_refused tells the platform the archive is stuck).
import type { ConfigResult } from "./config.ts";
import { platformConfigUrl } from "./config.ts";
import { systemRandom } from "./crypto.ts";
import type { RandomSource } from "./crypto.ts";
import { readCapped } from "./body.ts";
import { signRequest } from "./signature.ts";
import type { ContactHealthRow, IncidentEvent, IncidentRow, MonitorStore, TimelineType } from "./store.ts";
import { REPORT_INCIDENTS, TIMELINE_TYPES } from "./store.ts";
import type { Clock, FetchLike } from "./types.ts";
import { isRecord, USER_AGENT } from "./types.ts";
import { allWarnings, configWarnings, runtimeWarnings, storeSignals } from "./warnings.ts";

export const REPORT_PATH = "/api/v2/monitor/report";
export const REPORT_EVERY_MS = 5 * 60_000;
export const MAX_REPORT_BYTES = 64 * 1024;
export const MAX_TIMELINE = 200;
export const REPORT_TIMEOUT_MS = 10_000;
/**
 * The code alphabet of every code a report carries: safeCode's in types.ts, which the platform's report contract
 * (MONITOR_CODE) copies, so a code reaches the archive exactly as the monitor recorded it.
 */
export const REPORT_CODE = /^[a-z0-9_.:-]{1,64}$/;

/** The report endpoint: PLATFORM_CONFIG_URL's origin with REPORT_PATH; null when PLATFORM_CONFIG_URL is unusable. */
export function reportUrl(env: Readonly<Record<string, unknown>>): string | null {
  const url = platformConfigUrl(env);
  return url === null ? null : `${new URL(url).origin}${REPORT_PATH}`;
}

export interface TimelineEntry {
  readonly at: string;
  readonly type: TimelineType;
  readonly tierId: string | null;
  readonly contactId: string | null;
  readonly channel: "sms" | "email" | null;
  readonly code: string | null;
}

export interface ReportIncident {
  readonly incidentId: string;
  readonly drill: boolean;
  readonly components: readonly string[];
  readonly peakStatus: "down" | "degraded";
  readonly openedAt: string;
  readonly resolvedAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedVia: "sms" | "email" | null;
  readonly exhausted: boolean;
  readonly deliveries: { readonly sent: number; readonly delivered: number; readonly failed: number };
  readonly timeline: readonly TimelineEntry[];
}

export interface Report {
  readonly schema: 1;
  readonly sentAt: string;
  readonly monitor: {
    readonly appliedRevision: number;
    readonly configSource: "platform" | "bootstrap";
    readonly lastConfigError: { readonly code: string; readonly revision: number | null; readonly at: string } | null;
    readonly deliveryMode: "live" | "log";
    readonly lastRunAt: string | null;
    readonly heartbeatConfigured: boolean;
    readonly warnings: readonly string[];
  };
  readonly contactHealth: readonly {
    readonly contactId: string;
    readonly channel: "sms" | "email";
    readonly state: ContactHealthRow["state"];
    readonly code: string | null;
    readonly since: string;
  }[];
  readonly incidents: readonly ReportIncident[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * A code as the monitor recorded it ("tls-handshake", "rcode.5", "cfemail:unknown" stay as they are), or
 * "invalid_detail" for anything outside the alphabet, like safeCode. The monitor's own codes already fit.
 */
export const reportCode = (value: string): string => (REPORT_CODE.test(value) ? value : "invalid_detail");
const code = (value: string | null): string | null => (value === null ? null : reportCode(value));

/** Contact health problems in the order they are kept when the report must cut some: the ones someone must fix first. */
const HEALTH_ORDER: readonly ContactHealthRow["state"][] = ["opted_out", "undeliverable", "suppressed", "drill_missed"];
const isTimelineType = (value: string): value is TimelineType => TIMELINE_TYPES.some((type) => type === value);

/** At most MAX_TIMELINE entries: the first (opened) and the most recent, dropping the oldest of the middle. */
export function timelineOf(events: readonly IncidentEvent[]): TimelineEntry[] {
  const entries = events.flatMap((event): TimelineEntry[] => isTimelineType(event.type)
    ? [{ at: iso(event.at), type: event.type, tierId: event.tierId, contactId: event.contactId, channel: event.channel, code: code(event.code) }]
    : []);
  if (entries.length <= MAX_TIMELINE) return entries;
  return [...entries.slice(0, 1), ...entries.slice(entries.length - (MAX_TIMELINE - 1))];
}

export function reportIncident(store: MonitorStore, incident: IncidentRow): ReportIncident {
  return {
    incidentId: incident.id,
    drill: incident.drill,
    components: incident.drill ? [] : [incident.componentId],
    // A drill has no status of its own; "degraded" by convention (drill: true says what it is).
    peakStatus: incident.peakStatus === "down" || incident.peakStatus === "degraded" ? incident.peakStatus : incident.drill ? "degraded" : "down",
    openedAt: iso(incident.openedAt),
    resolvedAt: iso(incident.resolvedAt ?? incident.openedAt),
    acknowledgedAt: incident.acknowledgedAt === null ? null : iso(incident.acknowledgedAt),
    acknowledgedBy: incident.acknowledgedAt === null ? null : incident.acknowledgedContact,
    acknowledgedVia: incident.acknowledgedAt === null ? null : incident.acknowledgedVia,
    exhausted: incident.escalation?.steps.includes("exhausted") ?? false,
    deliveries: store.deliveryCounts(incident.id),
    timeline: timelineOf(store.incidentEvents(incident.id)),
  };
}

/** A report ready to send: its body, the incidents in it, and the report-due counter it was built at (store.reportSeq). */
export interface PreparedReport {
  readonly body: string;
  readonly incidentIds: readonly string[];
  readonly seq: number;
}

export interface ReportOptions {
  /** Send no incidents (the last report carrying incidents was refused as invalid): the state still gets through. */
  readonly withoutIncidents?: boolean;
}

const fits = (body: string): boolean => new TextEncoder().encode(body).byteLength <= MAX_REPORT_BYTES;

/** The monitor section and warnings, from the effective configuration (or its refusal) and the store. */
export function buildReport(
  store: MonitorStore,
  loaded: ConfigResult,
  env: Readonly<Record<string, unknown>>,
  now: number,
  options: ReportOptions = {},
): { readonly body: string; readonly incidentIds: readonly string[] } {
  const stored = store.platformConfig();
  const fetch = store.configFetchStatus();
  const configErrorAt = Number(store.getMeta("config_error_at") ?? "0");
  let lastConfigError: Report["monitor"]["lastConfigError"] = null;
  // While the stored revision no longer works, a newer revision the Worker refused (the admin's attempted fix) would
  // otherwise go unseen: lastConfigError must keep saying the monitor has stopped, so the refusal goes as a warning.
  const newerRefused = !loaded.ok && stored !== null && fetch.lastErrorCode !== null && fetch.lastErrorRevision !== null
    && fetch.lastErrorRevision > stored.revision ? [`newer_revision_refused:${fetch.lastErrorCode}`] : [];
  if (!loaded.ok) {
    lastConfigError = {
      code: stored === null ? "config_bootstrap_invalid" : "config_stored_invalid", revision: stored?.revision ?? null,
      at: iso(configErrorAt > 0 ? configErrorAt : now),
    };
  } else if (fetch.lastErrorCode !== null) {
    lastConfigError = { code: reportCode(fetch.lastErrorCode), revision: fetch.lastErrorRevision, at: iso(fetch.lastErrorAt ?? now) };
  }
  const contactIds = loaded.ok ? new Set(loaded.config.policy.tiers.flatMap((tier) => tier.contacts.map((contact) => contact.id))) : null;
  const lastRun = store.getMeta("last_run_at");
  const warningsWith = (extra: readonly string[]): string[] => allWarnings([
    loaded.ok ? configWarnings(loaded.config) : [],
    runtimeWarnings(storeSignals(store, now), now),
    options.withoutIncidents === true ? ["report_incidents_refused"] : [],
    newerRefused,
    extra,
  ]);
  const monitor = (warnings: readonly string[]): Report["monitor"] => ({
    appliedRevision: stored?.revision ?? 0,
    configSource: stored === null ? "bootstrap" : "platform",
    lastConfigError,
    deliveryMode: loaded.ok ? loaded.config.deliveryMode : env["DELIVERY_MODE"] === "log" ? "log" : "live",
    lastRunAt: lastRun === null ? null : iso(Number(lastRun)),
    heartbeatConfigured: loaded.ok ? loaded.config.heartbeatUrl !== null : typeof env["HEARTBEAT_URL"] === "string" && env["HEARTBEAT_URL"].trim() !== "",
    warnings,
  });
  const rank = (state: ContactHealthRow["state"]): number => HEALTH_ORDER.indexOf(state);
  const contactHealth = store.contactHealth()
    .filter((row) => row.state !== "ok" && (contactIds === null || contactIds.has(row.contactId)))
    .sort((a, b) => rank(a.state) - rank(b.state))
    .map((row) => ({ contactId: row.contactId, channel: row.channel, state: row.state, code: code(row.code), since: iso(row.since) }));
  const incidents = options.withoutIncidents === true ? [] : store.unexportedIncidents(REPORT_INCIDENTS).map((incident) => reportIncident(store, incident));
  const full = monitor(warningsWith([]));
  const body = (section: Report["monitor"], health: Report["contactHealth"], count: number): string =>
    JSON.stringify({ schema: 1, sentAt: iso(now), monitor: section, contactHealth: health, incidents: incidents.slice(0, count) } satisfies Report);
  // Over the size limit: send fewer incidents (the rest go in the next report).
  for (let count = incidents.length; count >= 0; count -= 1) {
    const candidate = body(full, contactHealth, count);
    if (fits(candidate)) return { body: candidate, incidentIds: incidents.slice(0, count).map((incident) => incident.incidentId) };
  }
  // Still too large with no incidents: the most contact-health rows that fit (binary search), saying it was cut.
  const truncated = monitor(warningsWith(["contact_health_truncated"]));
  let low = 0, high = contactHealth.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(body(truncated, contactHealth.slice(0, middle), 0))) low = middle;
    else high = middle - 1;
  }
  return { body: body(truncated, contactHealth.slice(0, low), 0), incidentIds: [] };
}

export type SendOutcome = { readonly ok: true; readonly archived: readonly string[] } | { readonly ok: false; readonly code: string };

export interface ReportDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly random?: RandomSource;
  readonly timeoutMs?: number;
}

/** POSTs one report. 401/403/404 mean refused or not deployed (the server hides which), like the config pull. */
export async function sendReport(settings: { readonly url: string; readonly key: string }, body: string, deps: ReportDeps): Promise<SendOutcome> {
  // Called bare, never as deps.fetch(...): the Workers fetch throws "Illegal invocation" when called as a method.
  const { fetch } = deps;
  let response: Response;
  try {
    response = await fetch(settings.url, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? REPORT_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        ...(await signRequest(settings.key, { method: "POST", url: settings.url, body }, deps.clock.now(), deps.random ?? systemRandom)),
      },
      body,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, code: name === "TimeoutError" || name === "AbortError" ? "report_timeout" : "report_network" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { ok: false, code: [401, 403, 404].includes(response.status) ? "report_rejected_or_missing" : `report_status_${String(response.status)}` };
  }
  let answer: unknown;
  try {
    const text = await readCapped(response, MAX_REPORT_BYTES);
    answer = text === null ? null : JSON.parse(text);
  } catch {
    answer = null;
  }
  const archived: unknown = isRecord(answer) ? answer["archived"] : null;
  if (!Array.isArray(archived) || !archived.every((id): id is string => typeof id === "string" && id.length <= 64)) {
    return { ok: false, code: "report_invalid_response" };
  }
  return { ok: true, archived };
}
