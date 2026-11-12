// Public and private projections of the monitor's state.
//   Public (/api/status, anyone): per-component status, uptime and history (30 days of daily uptime, 24 hours of hourly
//   latency), the operations checked for it (each check's name, kind, status, response time and when it last ran, with
//   a deep check's sub-checks listed by id), the rules that open and resolve an incident, and incidents with title,
//   start, impact (outage or partial outage), acknowledged yes/no and resolution. Never URLs, hostnames, detail or error codes, deep values or release
//   data, contacts, numbers or addresses. Only components
//   with public: true: a private component's status, uptime, incidents and maintenance windows are left out, and so is
//   its part in the overall status. With no public component the overall status is "none" (the page's empty state).
//   Private (/api/private, STATUS_VIEW_KEY): everything an operator needs, with contacts masked (last 4 digits of a
//   phone number; first letter and domain of an email address).
import type { ComponentConfig } from "./config.ts";
import type { ComponentState } from "./engine.ts";
import type { ComponentHistory, DayUptime, HourLatency } from "./history.ts";
import { historySeries } from "./history.ts";
import type { MaintenanceWindow } from "./maintenance.ts";
import { activeWindow } from "./maintenance.ts";
import type { CheckLatest, ContactHealthRow, IncidentEvent, IncidentRow, OutboxRow, PagingHealth, Uptime } from "./store.ts";
import type { Status } from "./types.ts";
import { worst } from "./types.ts";

export const STALE_AFTER_MS = 5 * 60_000;

/** What the public page needs: cheap reads only (meta, component rows, hourly rollups, incidents). */
export interface PublicSnapshot {
  readonly now: number;
  /** BRAND_NAME (brand.ts): the page titles itself "<brand> status". */
  readonly brand: string;
  readonly lastRunAt: number | null;
  readonly configError: string | null;
  readonly components: readonly { readonly config: ComponentConfig; readonly state: ComponentState }[];
  readonly uptime: ReadonlyMap<string, Uptime>;
  /** Per component: 30 days of daily uptime and 24 hours of hourly latency (history.ts); a missing one reads as all null. */
  readonly history: ReadonlyMap<string, ComponentHistory>;
  readonly incidents: readonly IncidentRow[];
  /** Maintenance windows active now or starting within a week. */
  readonly maintenance: readonly MaintenanceWindow[];
  /** The latest result per check (one small row each). */
  readonly checks: readonly CheckLatest[];
  /** The configured checks' ids in configuration order, for listing them; empty under a refused configuration. */
  readonly checkOrder: readonly string[];
  /** Consecutive failing runs that open an incident and passing runs that resolve it; null under a refused configuration. */
  readonly rules: { readonly openAfterFailures: number; readonly resolveAfterPasses: number } | null;
}

/** Where the effective configuration comes from (private view only). */
export interface ConfigView {
  /** "standalone": no PLATFORM_CONFIG_URL, the Worker's own settings are the whole configuration (no pull, no report). */
  readonly mode: "standalone" | "platform";
  readonly source: "platform" | "bootstrap";
  /** The platform revision in force; null on the bootstrap. */
  readonly revision: number | null;
  /** The stored LKG revision (the same as revision whenever one is stored: a stored copy that no longer validates refuses the run). */
  readonly storedRevision: number | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly lastFetchAt: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: number | null;
  readonly lastErrorDetail: string | null;
  readonly lastErrorRevision: number | null;
  readonly deliveryMode: "live" | "log" | null;
}

/** The operator view adds the latest result per check, recent failures and the notification and event logs. */
export interface Snapshot extends PublicSnapshot {
  readonly config: ConfigView;
  readonly recentFailures: readonly { checkId: string; status: Status; detail: string; observedAt: number; latencyMs: number }[];
  readonly notifications: readonly OutboxRow[];
  readonly events: readonly IncidentEvent[];
  readonly warnings: readonly string[];
  readonly contactHealth: readonly ContactHealthRow[];
  readonly drills: readonly IncidentRow[];
  readonly nextDrillAt: number | null;
  readonly report: { readonly lastOkAt: number | null; readonly lastErrorCode: string | null; readonly lastErrorAt: number | null };
  readonly heartbeat: { readonly configured: boolean; readonly failUrlConfigured: boolean; readonly paging: PagingHealth };
  readonly dnsInconclusiveSince: number | null;
  readonly prunedUnexported: { readonly count: number; readonly at: number | null };
  /** Every configured maintenance window (the note included). */
  readonly maintenanceAll: readonly MaintenanceWindow[];
  /** Twilio webhooks refused for a bad X-Twilio-Signature. */
  readonly twilioSignatureRejected?: { readonly count: number; readonly lastAt: number | null };
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length < 4 ? "•••" : `•••${digits.slice(-4)}`;
}

export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${value.slice(0, 1)}…@${value.slice(at + 1)}`;
}

export const maskRecipient = (channel: "sms" | "email", value: string): string => (channel === "sms" ? maskPhone(value) : maskEmail(value));

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export function monitorHealth(snapshot: PublicSnapshot): { lastRunAt: string | null; stale: boolean } {
  const stale = snapshot.lastRunAt === null || snapshot.now - snapshot.lastRunAt > STALE_AFTER_MS || (snapshot.configError ?? "") !== "";
  return { lastRunAt: iso(snapshot.lastRunAt), stale };
}

export interface PublicStatus {
  readonly version: 1;
  readonly generatedAt: string;
  /** BRAND_NAME: the status page titles itself "<brand> status". */
  readonly brand: string;
  /** "none": no component is public (the page shows an empty state, neither operational nor unknown). */
  readonly overall: Status | "unknown" | "none";
  readonly monitor: {
    readonly lastRunAt: string | null;
    readonly stale: boolean;
    /** With no run for this long the monitor counts as stale and every status reads "unknown". */
    readonly staleAfterSeconds: number;
    /** How many failing runs in a row open an incident and passing runs resolve it (null: configuration refused). */
    readonly rules: { readonly openAfterFailures: number; readonly resolveAfterPasses: number } | null;
  };
  readonly components: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: Status | "unknown";
    readonly since: string | null;
    readonly uptime: Uptime;
    /** Exactly 30 UTC days, oldest first, the last one today; uptime null on a day without runs. */
    readonly history: readonly DayUptime[];
    /** Exactly 24 hours, oldest first, the last the current hour; null where no latency was recorded. */
    readonly latency: readonly HourLatency[];
    /** Set while a maintenance window covers the component: its end ("Maintenance until ..."). */
    readonly maintenanceUntil: string | null;
    /** When any check last reported on this component. */
    readonly lastCheckedAt: string | null;
    /** What is checked for this component, in configuration order. */
    readonly checks: readonly PublicCheck[];
  }[];
  /** Windows active now or starting within a week. The note is private (it is free text); the page shows the times. */
  readonly maintenance: readonly {
    readonly components: readonly string[] | "all";
    readonly startsAt: string;
    readonly endsAt: string;
    readonly active: boolean;
  }[];
  readonly incidents: readonly {
    readonly id: string;
    readonly component: string;
    readonly title: string;
    /** The worst it got while open: "down" (an outage) or "degraded" (a partial outage). */
    readonly impact: "down" | "degraded";
    readonly startedAt: string;
    readonly acknowledged: boolean;
    readonly resolved: boolean;
    readonly resolvedAt: string | null;
  }[];
}

/**
 * One operation checked for a component. "part" is a sub-check of a deep check (the watched platform's own list:
 * database, migrations, ...). Latency is the check's own round trip, or the sub-check's as the platform measured it.
 */
export interface PublicCheck {
  readonly id: string;
  readonly kind: "http" | "dns" | "deep" | "part";
  readonly status: Status | "unknown";
  readonly latencyMs: number | null;
  readonly checkedAt: string | null;
}

const kindOf = (type: string): PublicCheck["kind"] => (type === "http" || type === "dns" ? type : "deep");

/** A deep check's sub-check list from its stored payload ({ checks: [{ id, status, latencyMs }] }); anything else is []. */
function deepParts(data: unknown): { id: string; status: Status; latencyMs: number }[] {
  if (typeof data !== "object" || data === null) return [];
  const list: unknown = Reflect.get(data, "checks");
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const id: unknown = Reflect.get(entry, "id"), status: unknown = Reflect.get(entry, "status"), latency: unknown = Reflect.get(entry, "latencyMs");
    if (typeof id !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(id)) return [];
    if (status !== "ok" && status !== "degraded" && status !== "down") return [];
    return [{ id, status, latencyMs: typeof latency === "number" && Number.isFinite(latency) ? Math.round(latency) : 0 }];
  });
}

/**
 * A component's checks: its own check rows (in configuration order), and under each deep check the sub-checks the
 * platform reported that no other component claims (a mapped sub-check has its own row, on its own component). A stale
 * monitor shows every status as unknown, like the component itself.
 */
function componentChecks(snapshot: PublicSnapshot, componentId: string, stale: boolean): PublicCheck[] {
  const order = new Map(snapshot.checkOrder.map((id, index) => [id, index]));
  const rank = (checkId: string): number => order.get(checkId) ?? order.get(checkId.split(".")[0] ?? "") ?? order.size;
  const rowIds = new Set(snapshot.checks.map((row) => row.checkId));
  const shown = (status: Status, inconclusive: boolean): Status | "unknown" => (stale || inconclusive ? "unknown" : status);
  return snapshot.checks
    .filter((row) => row.componentId === componentId && (order.has(row.checkId) || order.has(row.checkId.split(".")[0] ?? "")))
    .toSorted((a, b) => (rank(a.checkId) === rank(b.checkId) ? a.checkId.localeCompare(b.checkId) : rank(a.checkId) - rank(b.checkId)))
    .flatMap((row): PublicCheck[] => {
      const checkedAt = iso(row.observedAt);
      const own: PublicCheck = {
        id: row.checkId, kind: row.checkId.includes(".") ? "part" : kindOf(row.type), status: shown(row.status, row.inconclusive),
        latencyMs: row.inconclusive ? null : row.latencyMs, checkedAt,
      };
      if (row.type !== "deep" || row.checkId.includes(".")) return [own];
      const parts = deepParts(row.data).filter((part) => !rowIds.has(`${row.checkId}.${part.id}`)).map((part): PublicCheck => ({
        id: `${row.checkId}.${part.id}`, kind: "part", status: shown(part.status, false), latencyMs: part.latencyMs, checkedAt,
      }));
      return [own, ...parts];
    });
}

/** What /api/status shows: the public components only. */
export const publicProjection = (snapshot: PublicSnapshot): PublicStatus => projection(snapshot, true);

function projection(snapshot: PublicSnapshot, publicOnly: boolean): PublicStatus {
  const listed = publicOnly ? snapshot.components.filter(({ config }) => config.public) : snapshot.components;
  const ids = new Set(listed.map(({ config }) => config.id));
  const names = new Map(listed.map(({ config }) => [config.id, config.name]));
  const monitor = monitorHealth(snapshot);
  // A window over private components only is left out; one that also covers public ones names only those.
  const windows = snapshot.maintenance.flatMap((window): MaintenanceWindow[] => {
    if (!publicOnly || window.components === "all") return [window];
    const shown = window.components.filter((id) => ids.has(id));
    return shown.length === 0 ? [] : [{ ...window, components: shown }];
  });
  const components = listed.map(({ config, state }) => {
    const { history, latency } = snapshot.history.get(config.id) ?? historySeries(snapshot.now);
    return {
      id: config.id,
      name: config.name,
      // A stale monitor cannot vouch for anything: show unknown rather than a green that may be hours old.
      status: monitor.stale ? ("unknown" as const) : state.status,
      since: iso(state.since),
      uptime: snapshot.uptime.get(config.id) ?? { h24: null, d7: null, d30: null },
      history,
      latency,
      maintenanceUntil: iso(activeWindow(snapshot.maintenance, config.id, snapshot.now)?.endsAt ?? null),
      lastCheckedAt: iso(state.lastObservedAt),
      checks: componentChecks(snapshot, config.id, monitor.stale),
    };
  });
  const known = components.flatMap((component) => (component.status === "unknown" ? [] : [component.status]));
  // Components configured, none of them public. (A refused configuration has no components: that stays "unknown".)
  const none = listed.length === 0 && snapshot.components.length > 0;
  return {
    version: 1,
    generatedAt: new Date(snapshot.now).toISOString(),
    brand: snapshot.brand,
    overall: none ? "none" : known.length === 0 ? "unknown" : worst(known),
    monitor: { ...monitor, staleAfterSeconds: STALE_AFTER_MS / 1000, rules: snapshot.rules },
    components,
    maintenance: windows.map((window) => ({
      components: window.components, startsAt: new Date(window.startsAt).toISOString(), endsAt: new Date(window.endsAt).toISOString(),
      active: window.startsAt <= snapshot.now && snapshot.now < window.endsAt,
    })),
    incidents: snapshot.incidents.filter((incident) => !publicOnly || ids.has(incident.componentId)).map((incident) => ({
      id: incident.id,
      component: names.get(incident.componentId) ?? incident.componentId,
      title: incident.title,
      impact: incident.peakStatus === "degraded" ? "degraded" as const : "down" as const,
      startedAt: new Date(incident.openedAt).toISOString(),
      acknowledged: incident.acknowledgedAt !== null,
      resolved: incident.resolvedAt !== null,
      resolvedAt: iso(incident.resolvedAt),
    })),
  };
}

/** What /api/private shows: every component, public or not. */
export function privateProjection(snapshot: Snapshot): Record<string, unknown> {
  const base = projection(snapshot, false);
  return {
    ...base,
    monitor: {
      ...base.monitor,
      configError: snapshot.configError === "" ? null : snapshot.configError,
      deliveryMode: snapshot.config.deliveryMode,
      config: {
        mode: snapshot.config.mode, source: snapshot.config.source, revision: snapshot.config.revision, storedRevision: snapshot.config.storedRevision,
        updatedAt: snapshot.config.updatedAt, updatedBy: snapshot.config.updatedBy, lastFetchAt: iso(snapshot.config.lastFetchAt),
        lastErrorCode: snapshot.config.lastErrorCode, lastErrorAt: iso(snapshot.config.lastErrorAt), lastErrorDetail: snapshot.config.lastErrorDetail,
        lastErrorRevision: snapshot.config.lastErrorRevision,
      },
      warnings: snapshot.warnings,
      heartbeat: snapshot.heartbeat,
      report: { lastOkAt: iso(snapshot.report.lastOkAt), lastErrorCode: snapshot.report.lastErrorCode, lastErrorAt: iso(snapshot.report.lastErrorAt) },
      dnsInconclusiveSince: iso(snapshot.dnsInconclusiveSince),
      prunedUnexported: { count: snapshot.prunedUnexported.count, at: iso(snapshot.prunedUnexported.at) },
      nextDrillAt: iso(snapshot.nextDrillAt),
      twilioSignatureRejected: {
        count: snapshot.twilioSignatureRejected?.count ?? 0, lastAt: iso(snapshot.twilioSignatureRejected?.lastAt ?? null),
      },
    },
    contactHealth: snapshot.contactHealth.map((row) => ({ ...row, since: iso(row.since) })),
    drills: snapshot.drills.map((drill) => ({
      incidentId: drill.id, contactId: drill.escalation?.paged[0] ?? null, openedAt: iso(drill.openedAt), resolvedAt: iso(drill.resolvedAt),
      outcome: drill.closeReason, acknowledgedVia: drill.acknowledgedVia,
    })),
    maintenanceWindows: snapshot.maintenanceAll.map((window) => ({
      id: window.id, components: window.components, startsAt: iso(window.startsAt), endsAt: iso(window.endsAt), note: window.note,
    })),
    componentState: snapshot.components.map(({ state }) => ({
      id: state.id, status: state.status, consecutiveFailures: state.consecutiveFailures, consecutivePasses: state.consecutivePasses,
      openIncidentId: state.openIncidentId, lastObservedAt: iso(state.lastObservedAt),
    })),
    checks: snapshot.checks.map((check) => ({
      id: check.checkId, component: check.componentId, type: check.type, status: check.status, inconclusive: check.inconclusive,
      latencyMs: check.latencyMs, detail: check.detail, observedAt: iso(check.observedAt), data: check.data,
    })),
    recentFailures: snapshot.recentFailures.map((failure) => ({ ...failure, observedAt: iso(failure.observedAt) })),
    escalation: snapshot.incidents.map((incident) => ({
      incidentId: incident.id, groupId: incident.groupId, phase: incident.phase, alert: incident.alertMode,
      ackCode: incident.resolvedAt === null && incident.ackCode !== "" ? incident.ackCode : null,
      closeReason: incident.closeReason,
      cycle: incident.escalation?.cycle ?? null, tierIndex: incident.escalation?.tierIndex ?? null, acknowledgedBy: incident.acknowledgedBy,
      acknowledgedAt: iso(incident.acknowledgedAt), nextStepAt: iso(incident.nextAlarmAt),
    })),
    notifications: snapshot.notifications.map((row) => ({
      incidentId: row.incidentId, kind: row.kind, cycle: row.cycle, channel: row.channel, contact: row.contactName,
      to: maskRecipient(row.channel, row.recipient), status: row.status, attempts: row.attempts, lastError: row.lastError,
      provider: row.providerId, createdAt: iso(row.createdAt), sentAt: iso(row.sentAt), deliveryStatus: row.deliveryStatus, deliveryCode: row.deliveryCode,
    })),
    events: snapshot.events.map((event) => ({ ...event, at: iso(event.at) })),
  };
}
