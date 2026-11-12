// What the public status page shows, worked out from /api/status without touching the DOM (app.ts renders it; the
// tests run this module under Node). Times are formatted by the caller, so the page can use the viewer's locale.

export type Status = "ok" | "degraded" | "down" | "unknown";
/**
 * A component under a maintenance window shows "Maintenance" instead of its run status. "none" is the page's empty
 * state (no component is public): neutral, neither operational nor unknown.
 */
export type Shown = Status | "maintenance" | "none";

export interface Uptime { h24: number | null; d7: number | null; d30: number | null }
/** One UTC day of a component's history: uptime percent, null when nothing ran that day. */
export interface DayPoint { date: string; uptime: number | null }
/** One hour of response times (ms), null when nothing conclusive was measured. */
export interface LatencyPoint { hour: string; avgMs: number | null; maxMs: number | null }
/** One operation checked for a component ("part": a sub-check the watched platform reports in its deep health). */
export interface PublicCheck { id: string; kind: "http" | "dns" | "deep" | "part"; status: Status; latencyMs: number | null; checkedAt: string | null }
export interface Rules { openAfterFailures: number; resolveAfterPasses: number }
export interface PublicComponent {
  id: string; name: string; status: Status; since: string | null; uptime: Uptime; maintenanceUntil?: string | null;
  /** When any check last reported on it (absent from an older monitor). */
  lastCheckedAt?: string | null;
  /** What is checked for it, in configuration order (absent from an older monitor). */
  checks?: PublicCheck[];
  /** 30 days, oldest first (absent from an older monitor). */
  history?: DayPoint[];
  /** 24 hours, oldest first (absent from an older monitor). */
  latency?: LatencyPoint[];
}
export interface PublicMaintenance { components: string[] | "all"; startsAt: string; endsAt: string; active: boolean }
export interface PublicIncident {
  id: string; component: string; title: string; startedAt: string; acknowledged: boolean; resolved: boolean; resolvedAt: string | null;
}
export interface PublicStatus {
  /** BRAND_NAME (absent from an older monitor). */
  brand?: string;
  overall: Status | "none"; generatedAt: string;
  monitor: { lastRunAt: string | null; stale: boolean; staleAfterSeconds?: number; rules?: Rules | null };
  components: PublicComponent[];
  maintenance?: PublicMaintenance[]; incidents: PublicIncident[];
}

export type Format = (iso: string | null) => string;

export interface ComponentView {
  readonly id: string;
  readonly name: string;
  readonly shown: Shown;
  readonly label: string;
  /** "until <end>" while a maintenance window covers the component. */
  readonly note: string | null;
  readonly uptime: Uptime;
  readonly history: readonly DayView[];
  readonly latency: readonly LatencyPoint[];
  /** The most recent hour's average response time. */
  readonly latencyNow: number | null;
  /** When any check last reported on it (ISO), null before the first run. */
  readonly lastCheckedAt: string | null;
  /** Since when it has had its current status (ISO). */
  readonly since: string | null;
  readonly checks: readonly CheckView[];
}

/** One checked operation, named for people ("Notification backlog", not "notification_backlog"). */
export interface CheckView {
  readonly id: string;
  readonly name: string;
  readonly kind: PublicCheck["kind"];
  /** "HTTP request", "DNS lookup", "Signed health check", "Platform check". */
  readonly kindLabel: string;
  readonly shown: Status;
  readonly latencyMs: number | null;
  readonly checkedAt: string | null;
}

/** "ok" 99.95 % and up, "degraded" from 99 %, "down" below; "none": no runs that day. */
export type Band = "ok" | "degraded" | "down" | "none";
export interface DayView { readonly date: string; readonly uptime: number | null; readonly band: Band }

/** The headline numbers over the public components. */
export interface Stats {
  /** Mean of the components' 30-day uptime. */
  readonly uptime30: number | null;
  /** Mean of the last 24 hours' hourly averages, over every component. */
  readonly latency24: number | null;
  /** Incidents opened in the last 30 days, open ones included. */
  readonly incidents30: number;
  readonly operational: number;
  readonly total: number;
}

/** One incident on the timeline. */
export interface IncidentView {
  readonly title: string;
  readonly component: string;
  readonly state: "investigating" | "acknowledged" | "resolved";
  readonly started: string;
  /** "Resolved Nov 11, 9:53 PM · 14 min", or the state while open. */
  readonly detail: string;
}

export interface MaintenanceView {
  readonly components: string;
  readonly when: string;
  readonly active: boolean;
}

export interface Summary {
  readonly overall: Shown;
  readonly headline: string;
  readonly freshness: string;
  readonly components: readonly ComponentView[];
  readonly maintenance: readonly MaintenanceView[];
  /** null: the incident lists could not be loaded (shown as unavailable, not as "no incidents"). */
  readonly incidents: { readonly open: readonly string[][]; readonly past: readonly string[][] } | null;
  readonly stats: Stats | null;
  /** The same incidents as `incidents`, structured for the timeline (null: unavailable). */
  readonly timeline: { readonly open: readonly IncidentView[]; readonly past: readonly IncidentView[] } | null;
  /** When the monitor last ran (ISO), null if never or unknown. */
  readonly lastRunAt: string | null;
  readonly stale: boolean;
  readonly staleAfterSeconds: number;
  /** null: not sent (an older monitor or a refused configuration). */
  readonly rules: Rules | null;
  /** Checks that are not passing right now, worst first: what is out. */
  readonly attention: readonly { readonly component: string; readonly check: CheckView }[];
}

export const LABEL: Readonly<Record<Shown, string>> = {
  ok: "Operational", degraded: "Degraded", down: "Down", unknown: "Unknown", maintenance: "Maintenance", none: "Not listed",
};
export const HEADLINE: Readonly<Record<Shown, string>> = {
  ok: "All systems operational",
  degraded: "Some systems are degraded",
  down: "Some systems are down",
  unknown: "Status unknown",
  maintenance: "Scheduled maintenance in progress",
  none: "No services are listed here yet.",
};
export const UNAVAILABLE_HEADLINE = "Status is unavailable right now";
export const NO_UPTIME: Uptime = { h24: null, d7: null, d30: null };

const RANK: Readonly<Record<"ok" | "degraded" | "down", number>> = { ok: 0, degraded: 1, down: 2 };

export const asStatus = (value: unknown): Status => (value === "ok" || value === "degraded" || value === "down" ? value : "unknown");

const isRecord = (value: unknown): value is object => typeof value === "object" && value !== null;

// A shallow shape check: the renderer reads every nested field defensively anyway.
export function isPublicStatus(data: unknown): data is PublicStatus {
  if (!isRecord(data)) return false;
  const monitor: unknown = Reflect.get(data, "monitor");
  return Array.isArray(Reflect.get(data, "components")) && Array.isArray(Reflect.get(data, "incidents")) &&
    isRecord(monitor) && typeof Reflect.get(monitor, "stale") === "boolean";
}

/** What the page calls itself before /api/status answers (index.html carries the same text). */
export const DEFAULT_SITE_NAME = "Status";
/** Mirrors the Worker's brand rule (worker/brand.ts): 1 to 24 of these characters, so nothing odd reaches the title. */
const BRAND = /^[A-Za-z0-9](?:[A-Za-z0-9.,&'()+_-]| (?! ))*$/;

/**
 * The page's name for a brand: "<brand> status", or "Status" for the default brand "Status" (never "Status status").
 * Anything that is not a brand the Worker would accept (absent, too long, odd characters) gives the neutral default.
 */
export function siteName(brand: unknown): string {
  if (typeof brand !== "string" || brand.length > 24 || !BRAND.test(brand) || brand.endsWith(" ")) return DEFAULT_SITE_NAME;
  return brand.toLowerCase() === "status" ? brand : `${brand} status`;
}

/** Title and detail line of one incident. */
export function incidentLines(incident: PublicIncident, format: Format): string[] {
  const state = incident.resolved ? `Resolved ${format(incident.resolvedAt)}` : incident.acknowledged ? "Acknowledged, being worked on" : "Investigating";
  return [incident.title, `${incident.component} · started ${format(incident.startedAt)} · ${state}`];
}

/** A day's band: the thresholds a status page reader expects (three nines-and-a-half is a clean day). */
export function band(uptime: number | null): Band {
  if (uptime === null) return "none";
  return uptime >= 99.95 ? "ok" : uptime >= 99 ? "degraded" : "down";
}

const DAY_MS = 24 * 3600_000;
/** Exactly `days` UTC days ending at `generatedAt`'s day, oldest first, filled from whatever history arrived. */
export function dayViews(history: readonly DayPoint[] | undefined, generatedAt: string, days = 30): DayView[] {
  const byDate = new Map((history ?? []).map((point) => [point.date, point.uptime]));
  const end = Date.parse(generatedAt);
  const today = Number.isNaN(end) ? 0 : end - (end % DAY_MS);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    const uptime = byDate.get(date) ?? null;
    return { date, uptime: typeof uptime === "number" ? uptime : null, band: band(typeof uptime === "number" ? uptime : null) };
  });
}

/** The hourly response times as sent, keeping only well-formed points. */
const latency = (points: readonly LatencyPoint[] | undefined): LatencyPoint[] =>
  (points ?? []).filter((point) => typeof point.hour === "string").map((point) => ({
    hour: point.hour, avgMs: typeof point.avgMs === "number" ? point.avgMs : null, maxMs: typeof point.maxMs === "number" ? point.maxMs : null,
  }));
const numbers = (values: readonly (number | null)[]): number[] => values.filter((value): value is number => typeof value === "number");
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);

/** "45 s", "14 min", "2 h 5 min", "3 d 4 h". */
export function duration(ms: number): string {
  if (ms < 60_000) return `${String(Math.max(0, Math.round(ms / 1000)))} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
  return `${String(Math.floor(hours / 24))} d ${String(hours % 24)} h`;
}

function incidentView(incident: PublicIncident, format: Format): IncidentView {
  const state = incident.resolved ? "resolved" : incident.acknowledged ? "acknowledged" : "investigating";
  const took = incident.resolvedAt === null ? Number.NaN : Date.parse(incident.resolvedAt) - Date.parse(incident.startedAt);
  const detail = state === "resolved"
    ? `Resolved ${format(incident.resolvedAt)}${Number.isNaN(took) ? "" : ` · ${duration(took)}`}`
    : state === "acknowledged" ? "Acknowledged, being worked on" : "Investigating";
  return { title: incident.title, component: incident.component, state, started: format(incident.startedAt), detail };
}

function overallOf(shown: readonly Shown[], fallback: Status): Shown {
  if (shown.length === 0) return fallback;
  let worst: "ok" | "degraded" | "down" | null = null;
  for (const status of shown) {
    if (status === "unknown" || status === "maintenance" || status === "none") continue;
    if (worst === null || RANK[status] > RANK[worst]) worst = status;
  }
  const maintenance = shown.includes("maintenance");
  if (worst === null) return maintenance ? "maintenance" : "unknown";
  return worst === "ok" && maintenance ? "maintenance" : worst;
}

/** No component is public: one neutral line, whether or not the monitor is current (there is nothing it could vouch for). */
const EMPTY: Summary = {
  lastRunAt: null, stale: false, staleAfterSeconds: 300, rules: null, attention: [],
  overall: "none", headline: HEADLINE.none, freshness: "Services show up here, with their uptime and response times, once they are published to this page.", components: [], maintenance: [], incidents: { open: [], past: [] }, stats: null,
  timeline: { open: [], past: [] },
};

const ACRONYMS = new Set(["api", "dns", "http", "https", "db", "sms", "url", "ui", "tls", "ssl", "cdn", "id"]);
/** "notification_backlog_age" -> "Notification backlog age"; "platform.database" -> "Database"; "api_http" -> "API HTTP". */
export function checkName(id: string): string {
  const words = (id.split(".").at(-1) ?? id).split(/[_-]+/).filter((word) => word !== "");
  const named = words.map((word, index) => (ACRONYMS.has(word) ? word.toUpperCase() : index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word));
  return named.length === 0 ? id : named.join(" ");
}
export const KIND_LABEL: Readonly<Record<PublicCheck["kind"], string>> = {
  http: "HTTP request", dns: "DNS lookup", deep: "Signed health check", part: "Platform check",
};
const KINDS = new Set(["http", "dns", "deep", "part"]);
const isKind = (value: unknown): value is PublicCheck["kind"] => typeof value === "string" && KINDS.has(value);

/** The checks as sent, keeping only well-formed ones. A stale monitor vouches for none of them. */
const isCheck = (value: unknown): value is PublicCheck =>
  isRecord(value) && typeof Reflect.get(value, "id") === "string" && isKind(Reflect.get(value, "kind"));

function checkViews(checks: readonly PublicCheck[] | undefined, stale: boolean): CheckView[] {
  const raw: readonly unknown[] = Array.isArray(checks) ? checks : [];
  return raw.filter(isCheck).map((check) => ({
    id: check.id, name: check.kind === "deep" ? "Deep health check" : checkName(check.id), kind: check.kind, kindLabel: KIND_LABEL[check.kind], shown: stale ? "unknown" : asStatus(check.status),
    latencyMs: typeof check.latencyMs === "number" ? check.latencyMs : null, checkedAt: typeof check.checkedAt === "string" ? check.checkedAt : null,
  }));
}

const isRules = (value: unknown): value is Rules =>
  isRecord(value) && typeof Reflect.get(value, "openAfterFailures") === "number" && typeof Reflect.get(value, "resolveAfterPasses") === "number";

export function summarize(data: PublicStatus, format: Format): Summary {
  const monitorFacts = {
    lastRunAt: typeof data.monitor.lastRunAt === "string" ? data.monitor.lastRunAt : null, stale: data.monitor.stale,
    staleAfterSeconds: typeof data.monitor.staleAfterSeconds === "number" ? data.monitor.staleAfterSeconds : 300,
    rules: isRules(data.monitor.rules) ? data.monitor.rules : null,
  };
  if (data.overall === "none" && data.components.length === 0) return { ...EMPTY, ...monitorFacts };
  const stale = data.monitor.stale;
  const names = new Map(data.components.map((component) => [component.id, component.name]));
  const components = data.components.map((component): ComponentView => {
    const until = typeof component.maintenanceUntil === "string" ? component.maintenanceUntil : null;
    // A stale monitor cannot vouch for anything, a window included: Unknown, as the Worker reports it.
    const shown: Shown = stale ? "unknown" : until !== null ? "maintenance" : asStatus(component.status);
    return {
      id: component.id, name: component.name, shown, label: LABEL[shown], note: shown === "maintenance" ? `until ${format(until)}` : null,
      uptime: component.uptime, history: dayViews(component.history, data.generatedAt), latency: latency(component.latency),
      latencyNow: numbers(latency(component.latency).map((point) => point.avgMs)).at(-1) ?? null,
      lastCheckedAt: typeof component.lastCheckedAt === "string" ? component.lastCheckedAt : null,
      since: typeof component.since === "string" ? component.since : null,
      checks: checkViews(component.checks, stale),
    };
  });
  const overall: Shown = stale ? "unknown" : overallOf(components.map((component) => component.shown), asStatus(data.overall));
  const maintenance = (Array.isArray(data.maintenance) ? data.maintenance : []).map((window): MaintenanceView => ({
    components: window.components === "all" ? "All components" : window.components.map((id) => names.get(id) ?? id).join(", "),
    when: window.active ? `In progress, until ${format(window.endsAt)}` : `${format(window.startsAt)} to ${format(window.endsAt)}`,
    active: window.active,
  }));
  const since = Date.parse(data.generatedAt) - 30 * DAY_MS;
  const stats: Stats = {
    uptime30: mean(numbers(components.map((component) => component.uptime.d30))),
    latency24: mean(numbers(components.flatMap((component) => component.latency.map((point) => point.avgMs)))),
    incidents30: data.incidents.filter((incident) => !incident.resolved || Date.parse(incident.startedAt) >= since).length,
    operational: components.filter((component) => component.shown === "ok").length,
    total: components.length,
  };
  // A failing deep check is left out when its failing parts are listed: they say what is wrong, it only repeats it.
  const failing = (check: CheckView): boolean => check.shown === "down" || check.shown === "degraded";
  const explained = new Set(components.flatMap((component) => component.checks).filter((check) => check.kind === "part" && failing(check))
    .map((check) => check.id.split(".")[0] ?? ""));
  const attention = components.flatMap((component) => component.checks.filter((check) => failing(check) && !(check.kind === "deep" && explained.has(check.id)))
    .map((check) => ({ component: component.name, check })))
    .toSorted((a, b) => RANK[b.check.shown === "down" ? "down" : "degraded"] - RANK[a.check.shown === "down" ? "down" : "degraded"]);
  return {
    ...monitorFacts,
    attention,
    overall,
    stats,
    timeline: {
      open: data.incidents.filter((incident) => !incident.resolved).map((incident) => incidentView(incident, format)),
      past: data.incidents.filter((incident) => incident.resolved).map((incident) => incidentView(incident, format)),
    },
    headline: stale ? "Monitoring is delayed" : HEADLINE[overall],
    freshness: stale
      ? `The monitor has not reported since ${format(data.monitor.lastRunAt)}. Component status is unknown until it does.`
      : `Last checked ${format(data.monitor.lastRunAt)}.`,
    components,
    maintenance,
    incidents: {
      open: data.incidents.filter((incident) => !incident.resolved).map((incident) => incidentLines(incident, format)),
      past: data.incidents.filter((incident) => incident.resolved).map((incident) => incidentLines(incident, format)),
    },
  };
}

/**
 * /api/status failed: nothing on the page may keep claiming a status. Components keep their names (from the last
 * good response) but show Unknown with no uptime; the incident lists and maintenance windows are marked unavailable.
 */
export function unavailable(previous: Summary | null): Summary {
  return {
    lastRunAt: previous?.lastRunAt ?? null, stale: true, staleAfterSeconds: previous?.staleAfterSeconds ?? 300, rules: previous?.rules ?? null,
    attention: [],
    overall: "unknown",
    headline: UNAVAILABLE_HEADLINE,
    freshness: "The latest status could not be loaded. Retrying shortly.",
    components: (previous?.components ?? []).map((component) => ({
      ...component, shown: "unknown", label: LABEL.unknown, note: null, uptime: NO_UPTIME,
      history: component.history.map((day) => ({ ...day, uptime: null, band: "none" as const })), latency: [], latencyNow: null,
      checks: component.checks.map((check) => ({ ...check, shown: "unknown" as const, latencyMs: null })),
    })),
    maintenance: [],
    incidents: null,
    stats: null,
    timeline: null,
  };
}
