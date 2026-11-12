// Builds what /api/status and /api/private show. The public snapshot reads only small tables (meta, components, the
// hourly rollups, the latest result per check and incidents), never the run history or the logs, and the object caches its projection briefly:
// /api/status is unauthenticated and its traffic peaks during an incident, exactly when the same single-threaded
// Durable Object must keep ingesting runs and firing escalation alarms.
import { brandOf } from "./brand.ts";
import type { ConfigResult } from "./config.ts";
import { monitorMode } from "./config.ts";
import { nextDrillSlot } from "./drill.ts";
import { currentAndUpcoming } from "./maintenance.ts";
import type { ConfigView, PublicSnapshot, Snapshot } from "./redact.ts";
import type { MonitorStore } from "./store.ts";
import { allWarnings, configWarnings, runtimeWarnings, storeSignals } from "./warnings.ts";

export const PUBLIC_CACHE_MS = 15_000;

/** `env` is read for the brand only (brandOf: an invalid BRAND_NAME reads as the default, so the page still renders). */
export function publicSnapshot(store: MonitorStore, loaded: ConfigResult, now: number, env: Readonly<Record<string, unknown>> = {}): PublicSnapshot {
  const components = loaded.ok ? loaded.config.targets.components : [];
  const lastRun = store.getMeta("last_run_at");
  return {
    now,
    brand: loaded.ok ? loaded.config.brandName : brandOf(env),
    lastRunAt: lastRun === null ? null : Number(lastRun),
    configError: loaded.ok ? (store.getMeta("config_error") ?? null) : loaded.errors.join("; "),
    components: components.map((config) => ({ config, state: store.component(config.id) })),
    uptime: store.uptime(now),
    history: store.history(now),
    incidents: store.incidents(now),
    maintenance: loaded.ok ? currentAndUpcoming(loaded.config.maintenance, now) : [],
    checks: store.checkLatest(),
    checkOrder: loaded.ok ? loaded.config.targets.checks.map((check) => check.id) : [],
    rules: loaded.ok ? { openAfterFailures: loaded.config.targets.openAfterFailures, resolveAfterPasses: loaded.config.targets.resolveAfterPasses } : null,
  };
}

/** Where the effective configuration comes from and how the platform pull is doing. */
export function configView(store: MonitorStore, loaded: ConfigResult, env: Readonly<Record<string, unknown>> = {}): ConfigView {
  const stored = store.platformConfig();
  const fetch = store.configFetchStatus();
  // With a refused configuration the source is what would have been used: the stored revision if there is one.
  const source = loaded.ok ? loaded.config.source : stored === null ? { kind: "bootstrap" as const } : { kind: "platform" as const, revision: stored.revision };
  return {
    mode: loaded.ok ? loaded.config.mode : monitorMode(env),
    source: source.kind,
    revision: source.kind === "platform" ? source.revision : null,
    storedRevision: stored?.revision ?? null,
    updatedAt: stored?.updatedAt ?? null,
    updatedBy: stored?.updatedBy ?? null,
    lastFetchAt: fetch.lastSuccessAt,
    lastErrorCode: fetch.lastErrorCode,
    lastErrorAt: fetch.lastErrorAt,
    lastErrorDetail: fetch.lastErrorDetail,
    lastErrorRevision: fetch.lastErrorRevision,
    deliveryMode: loaded.ok ? loaded.config.deliveryMode : null,
  };
}

export function fullSnapshot(store: MonitorStore, loaded: ConfigResult, now: number, env: Readonly<Record<string, unknown>> = {}): Snapshot {
  const pruned = store.prunedUnexported();
  return {
    ...publicSnapshot(store, loaded, now, env),
    config: configView(store, loaded, env),
    recentFailures: store.recentFailures(),
    notifications: store.notifications(),
    events: store.events(),
    warnings: allWarnings([
      loaded.ok ? configWarnings(loaded.config) : [],
      runtimeWarnings(storeSignals(store, now), now),
    ]),
    contactHealth: store.contactHealth(),
    drills: store.drills(),
    nextDrillAt: loaded.ok && loaded.config.policy.drill.enabled ? nextDrillSlot(loaded.config.policy.drill, loaded.config.policy.timeZone, now) : null,
    report: store.reportStatus(),
    heartbeat: {
      configured: loaded.ok && loaded.config.heartbeatUrl !== null,
      failUrlConfigured: loaded.ok && loaded.config.heartbeatFailUrl !== null,
      paging: store.pagingHealth(now),
    },
    dnsInconclusiveSince: store.dnsInconclusiveSince(),
    prunedUnexported: pruned,
    maintenanceAll: loaded.ok ? loaded.config.maintenance : [],
    twilioSignatureRejected: store.signatureRejections(),
  };
}

/** Holds one value for ttlMs; invalidate() after any state change so a new incident shows at once. */
export class TimedCache<T> {
  private entry: { readonly value: T; readonly at: number } | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs = PUBLIC_CACHE_MS) {
    this.ttlMs = ttlMs;
  }

  get(now: number, build: () => T): T {
    if (this.entry !== null && now >= this.entry.at && now - this.entry.at < this.ttlMs) return this.entry.value;
    const value = build();
    this.entry = { value, at: now };
    return value;
  }

  invalidate(): void {
    this.entry = null;
  }
}
