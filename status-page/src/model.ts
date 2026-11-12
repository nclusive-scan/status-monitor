// What the public status page shows, worked out from /api/status without touching the DOM (app.ts renders it; the
// tests run this module under Node). Times are formatted by the caller, so the page can use the viewer's locale.

export type Status = "ok" | "degraded" | "down" | "unknown";
/**
 * A component under a maintenance window shows "Maintenance" instead of its run status. "none" is the page's empty
 * state (no component is public): neutral, neither operational nor unknown.
 */
export type Shown = Status | "maintenance" | "none";

export interface Uptime { h24: number | null; d7: number | null; d30: number | null }
export interface PublicComponent {
  id: string; name: string; status: Status; since: string | null; uptime: Uptime; maintenanceUntil?: string | null;
}
export interface PublicMaintenance { components: string[] | "all"; startsAt: string; endsAt: string; active: boolean }
export interface PublicIncident {
  id: string; component: string; title: string; startedAt: string; acknowledged: boolean; resolved: boolean; resolvedAt: string | null;
}
export interface PublicStatus {
  /** BRAND_NAME (absent from an older monitor). */
  brand?: string;
  overall: Status | "none"; generatedAt: string; monitor: { lastRunAt: string | null; stale: boolean }; components: PublicComponent[];
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
const EMPTY: Summary = { overall: "none", headline: HEADLINE.none, freshness: "", components: [], maintenance: [], incidents: { open: [], past: [] } };

export function summarize(data: PublicStatus, format: Format): Summary {
  if (data.overall === "none" && data.components.length === 0) return EMPTY;
  const stale = data.monitor.stale;
  const names = new Map(data.components.map((component) => [component.id, component.name]));
  const components = data.components.map((component): ComponentView => {
    const until = typeof component.maintenanceUntil === "string" ? component.maintenanceUntil : null;
    // A stale monitor cannot vouch for anything, a window included: Unknown, as the Worker reports it.
    const shown: Shown = stale ? "unknown" : until !== null ? "maintenance" : asStatus(component.status);
    return {
      id: component.id, name: component.name, shown, label: LABEL[shown], note: shown === "maintenance" ? `until ${format(until)}` : null,
      uptime: component.uptime,
    };
  });
  const overall: Shown = stale ? "unknown" : overallOf(components.map((component) => component.shown), asStatus(data.overall));
  const maintenance = (Array.isArray(data.maintenance) ? data.maintenance : []).map((window): MaintenanceView => ({
    components: window.components === "all" ? "All components" : window.components.map((id) => names.get(id) ?? id).join(", "),
    when: window.active ? `In progress, until ${format(window.endsAt)}` : `${format(window.startsAt)} to ${format(window.endsAt)}`,
    active: window.active,
  }));
  return {
    overall,
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
    overall: "unknown",
    headline: UNAVAILABLE_HEADLINE,
    freshness: "The latest status could not be loaded. Retrying shortly.",
    components: (previous?.components ?? []).map((component) => ({
      ...component, shown: "unknown", label: LABEL.unknown, note: null, uptime: NO_UPTIME,
    })),
    maintenance: [],
    incidents: null,
  };
}
