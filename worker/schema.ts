// The monitor object's SQLite schema, applied in order and recorded in meta.schema_version. Append new migrations;
// never edit an applied one.

export type SqlValue = string | number | null | ArrayBuffer;
export type SqlRow = Readonly<Record<string, SqlValue>>;

/** The part of Durable Object SqlStorage the store uses; node:sqlite is adapted to it in the tests. */
export interface SqlLike {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): SqlRow[] };
}

export interface StorageLike {
  readonly sql: SqlLike;
  transactionSync<T>(closure: () => T): T;
}

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, results INTEGER NOT NULL);
   CREATE INDEX runs_started ON runs (started_at);
   CREATE TABLE check_results (
     run_id INTEGER NOT NULL, check_id TEXT NOT NULL, component_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
     inconclusive INTEGER NOT NULL, latency_ms INTEGER NOT NULL, detail TEXT NOT NULL, observed_at INTEGER NOT NULL);
   CREATE INDEX check_results_observed ON check_results (observed_at);
   CREATE INDEX check_results_check ON check_results (check_id, observed_at);
   CREATE TABLE check_latest (
     check_id TEXT PRIMARY KEY, component_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, inconclusive INTEGER NOT NULL,
     latency_ms INTEGER NOT NULL, detail TEXT NOT NULL, observed_at INTEGER NOT NULL, data TEXT);
   CREATE TABLE components (
     id TEXT PRIMARY KEY, status TEXT NOT NULL, consecutive_failures INTEGER NOT NULL, consecutive_passes INTEGER NOT NULL,
     open_incident_id TEXT, since INTEGER, last_observed_at INTEGER);
   CREATE TABLE component_hourly (
     component_id TEXT NOT NULL, hour INTEGER NOT NULL, total INTEGER NOT NULL, up INTEGER NOT NULL, PRIMARY KEY (component_id, hour));
   CREATE TABLE incidents (
     id TEXT PRIMARY KEY, component_id TEXT NOT NULL, title TEXT NOT NULL, opened_at INTEGER NOT NULL, ack_code TEXT NOT NULL,
     phase TEXT NOT NULL, acknowledged_at INTEGER, acknowledged_by TEXT, resolved_at INTEGER, next_alarm_at INTEGER, escalation TEXT NOT NULL);
   CREATE INDEX incidents_open ON incidents (resolved_at, next_alarm_at);
   CREATE INDEX incidents_code ON incidents (ack_code);
   CREATE TABLE incident_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, at INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL);
   CREATE INDEX incident_events_incident ON incident_events (incident_id, at);
   CREATE TABLE outbox (
     key TEXT PRIMARY KEY, incident_id TEXT NOT NULL, kind TEXT NOT NULL, contact_id TEXT NOT NULL, contact_name TEXT NOT NULL,
     channel TEXT NOT NULL, recipient TEXT NOT NULL, tier_id TEXT, cycle INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
     attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, claim_until INTEGER, last_error TEXT, provider_id TEXT,
     created_at INTEGER NOT NULL, sent_at INTEGER);
   CREATE INDEX outbox_due ON outbox (status, next_attempt_at);
   CREATE INDEX outbox_incident ON outbox (incident_id);`,
  // 2: the failure list reads a partial index instead of walking 35 days of mostly-ok history; components remember their
  // recent run outcomes (the flapping rule); incidents opened together share one escalation (group_id) and record why
  // they closed.
  `CREATE INDEX check_results_failures ON check_results (observed_at) WHERE status != 'ok';
   ALTER TABLE components ADD COLUMN recent TEXT NOT NULL DEFAULT '';
   ALTER TABLE incidents ADD COLUMN group_id TEXT;
   UPDATE incidents SET group_id = id WHERE group_id IS NULL;
   ALTER TABLE incidents ADD COLUMN close_reason TEXT;
   CREATE INDEX incidents_group ON incidents (group_id, resolved_at);`,
  // 3: the last-known-good platform configuration (one row: the highest accepted revision of /api/v2/monitor/config),
  // and an index for pruning the config-change notices, which belong to no incident.
  `CREATE TABLE platform_config (
     id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, updated_at TEXT, updated_by TEXT, body TEXT NOT NULL,
     fetched_at INTEGER NOT NULL, accepted_at INTEGER NOT NULL);
   CREATE INDEX outbox_kind_created ON outbox (kind, created_at);`,
  // 4: the report channel and the drill. Incidents record whether they are a drill, their worst status, who
  // acknowledged them (contact id and channel) and when the platform archived them (exported_at; only exported ones
  // are pruned at 35 days). Events carry the structured fields of the archived timeline. Outbox rows can record the
  // provider's final delivery status by provider id. contact_health holds per-contact, per-channel delivery health.
  `ALTER TABLE incidents ADD COLUMN drill INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE incidents ADD COLUMN peak_status TEXT;
   ALTER TABLE incidents ADD COLUMN acknowledged_contact TEXT;
   ALTER TABLE incidents ADD COLUMN acknowledged_via TEXT;
   ALTER TABLE incidents ADD COLUMN exported_at INTEGER;
   CREATE INDEX incidents_export ON incidents (exported_at, resolved_at);
   ALTER TABLE incident_events ADD COLUMN tier_id TEXT;
   ALTER TABLE incident_events ADD COLUMN contact_id TEXT;
   ALTER TABLE incident_events ADD COLUMN channel TEXT;
   ALTER TABLE incident_events ADD COLUMN code TEXT;
   ALTER TABLE outbox ADD COLUMN delivery_status TEXT;
   ALTER TABLE outbox ADD COLUMN delivery_code TEXT;
   ALTER TABLE outbox ADD COLUMN delivery_at INTEGER;
   CREATE INDEX outbox_provider ON outbox (provider_id);
   CREATE TABLE contact_health (
     contact_id TEXT NOT NULL, channel TEXT NOT NULL, state TEXT NOT NULL, code TEXT, since INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (contact_id, channel));`,
  // 5: the per-contact SMS reply limiter (5 replies in 10 minutes; contact ids only, never numbers) and an index for the
  // sweep that marks SMS without a final delivery status as unknown.
  `CREATE TABLE sms_replies (contact_id TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX sms_replies_contact ON sms_replies (contact_id, at);
   CREATE INDEX outbox_sent ON outbox (status, channel, sent_at);`,
  // 6: final Twilio statuses that arrived before markSent recorded the message SID (applied by markSent, pruned after an
  // hour). SIDs and status codes only.
  `CREATE TABLE early_status (provider_id TEXT PRIMARY KEY, status TEXT NOT NULL, code TEXT, at INTEGER NOT NULL);`,
  // 7: how an incident notifies, copied from its component's alert setting when it opens ("page", "email" or "none").
  // Incidents of different modes never share a group; every incident opened before this migration paged.
  `ALTER TABLE incidents ADD COLUMN alert_mode TEXT NOT NULL DEFAULT 'page';`,
  // 8: the incident that took over this one's escalation when its component stopped paging (changeAlertMode), so its
  // earlier pages (ack links, sent and failed outbox rows) still resolve to the group that carries them now.
  `ALTER TABLE incidents ADD COLUMN handed_over_to TEXT;`,
  // 9: hourly latency for the status page chart: one sample per component per run (its slowest conclusive result that
  // was not down), summed, counted and maxed per hour. Hours rolled up before this migration have no samples.
  `ALTER TABLE component_hourly ADD COLUMN latency_sum INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE component_hourly ADD COLUMN latency_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE component_hourly ADD COLUMN latency_max INTEGER NOT NULL DEFAULT 0;`,
];

export function migrate(sql: SqlLike): number {
  sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
  let version = typeof row?.["value"] === "string" ? Number.parseInt(row["value"], 10) : 0;
  for (; version < MIGRATIONS.length; version += 1) {
    const migration = MIGRATIONS[version] ?? "";
    for (const statement of migration.split(";").map((part) => part.trim()).filter((part) => part !== "")) sql.exec(statement);
    sql.exec("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(version + 1));
  }
  return version;
}

export const num = (row: SqlRow | undefined, key: string): number => {
  const value = row?.[key];
  return typeof value === "number" ? value : Number(value ?? 0);
};
export const nullableNum = (row: SqlRow | undefined, key: string): number | null => {
  const value = row?.[key];
  return value === null || value === undefined ? null : typeof value === "number" ? value : Number(value);
};
export const text = (row: SqlRow | undefined, key: string): string => {
  const value = row?.[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
};
export const nullableText = (row: SqlRow | undefined, key: string): string | null => {
  const value = row?.[key];
  return typeof value === "string" ? value : null;
};
