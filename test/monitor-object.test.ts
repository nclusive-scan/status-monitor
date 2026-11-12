// The Durable Object itself, loaded under Node with a stand-in for the Workers runtime's DurableObject base class, on
// the same SQLite fake as the store tests. DELIVERY_MODE "log": nothing is sent anywhere. Also: the alarm is re-armed
// even when a step throws, the 1 s alarm floor (workerd #7915), the "us" jurisdiction, the drill and the report.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import type { TargetsConfig } from "../worker/config.ts";
import { parseTargets } from "../worker/config.ts";
import type { ApplyResult } from "../worker/platform-config.ts";
import type { SqlRow } from "../worker/schema.ts";
import type { CheckResult } from "../worker/types.ts";
import { isRecord } from "../worker/types.ts";
import { fixtureTargets, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "cloudflare:workers") return next(specifier, context);
    const base = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
    return { url: `data:text/javascript,${encodeURIComponent(base)}`, shortCircuit: true };
  },
});

interface ObjectUnderTest {
  ingest(results: CheckResult[], now: number, checked: TargetsConfig): Promise<{ opened: string[]; resolved: string[] }>;
  offerPlatformConfig(body: string, now: number): Promise<ApplyResult>;
  alarm(): Promise<void>;
  privateStatus(now: number): string;
  prepareReport(now: number): { readonly body: string; readonly incidentIds: readonly string[]; readonly seq: number } | null;
  reportSent(incidentIds: readonly string[], archived: readonly string[], now: number, seq: number): number;
  reportFailed(code: string, now: number, incidentCount: number): void;
}
type ObjectClass = new (ctx: unknown, env: Record<string, unknown>) => ObjectUnderTest;
const isObjectClass = (value: unknown): value is ObjectClass => typeof value === "function";

const loaded: unknown = await import(new URL("../worker/monitor-object.ts", import.meta.url).href);
const MonitorObject: unknown = isRecord(loaded) ? loaded["MonitorObject"] : null;
if (!isObjectClass(MonitorObject)) throw new Error("MonitorObject not exported");
const alarmTime: unknown = isRecord(loaded) ? loaded["alarmTime"] : null;
const isAlarmTime = (value: unknown): value is (next: number | null, now: number) => number | null => typeof value === "function";
const entry: unknown = await import(new URL("../worker/index.ts", import.meta.url).href);
const monitorId: unknown = isRecord(entry) ? entry["monitorId"] : null;
const isMonitorId = (value: unknown): value is (namespace: { jurisdiction(name: string): { idFromName(name: string): unknown } }) => unknown =>
  typeof value === "function";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const KEY = "k".repeat(40);
const env = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  MONITOR_TARGETS: read("test/support/targets.fixture.json"),
  ESCALATION_POLICY: read("config/escalation.example.json"),
  STATUS_PAGE_URL: "https://status.example.com",
  TWILIO_WEBHOOK_URL: "https://status.example.com/hooks/twilio",
  MONITOR_HEALTH_KEY: KEY,
  MONITOR_CONFIG_KEY: "c".repeat(40),
  ACK_SIGNING_KEY: KEY,
  DELIVERY_MODE: "log",
  PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config",
  ...overrides,
});

interface Harness {
  readonly object: ObjectUnderTest;
  readonly alarms: (number | null)[];
  /** Makes every SQL statement matching the pattern throw (null: none). */
  readonly failOn: (pattern: RegExp | null) => void;
}

function harness(overrides: Record<string, unknown> = {}): Harness {
  if (!isObjectClass(MonitorObject)) throw new Error("MonitorObject not exported");
  const base = sqliteStorage();
  const alarms: (number | null)[] = [];
  let failing: RegExp | null = null;
  const storage = {
    ...base,
    sql: {
      exec(query: string, ...bindings: (string | number | null)[]): { toArray(): SqlRow[] } {
        if (failing?.test(query) === true) throw new Error("SQLITE_INJECTED_FAILURE");
        return base.sql.exec(query, ...bindings);
      },
    },
    setAlarm: (at: number) => {
      alarms.push(at);
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarms.push(null);
      return Promise.resolve();
    },
  };
  return { object: new MonitorObject({ storage }, env(overrides)), alarms, failOn: (pattern) => {
    failing = pattern;
  } };
}

const newObject = (): ObjectUnderTest => harness().object;

const runOf = (targets: TargetsConfig, at: number, down: readonly string[]): CheckResult[] =>
  targets.checks.map((check) => ({
    checkId: check.id, componentId: check.component, type: check.type, status: down.includes(check.component) ? "down" : "ok", inconclusive: false,
    latencyMs: 10, detail: "x", observedAt: at, data: null,
  }));

void test("ingest: a run is folded against the targets it checked, even when the pull accepted a newer revision meanwhile", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const object = newObject();
  const old = fixtureTargets();
  await object.ingest(runOf(old, T0, ["signup"]), T0, old);
  const opened = await object.ingest(runOf(old, T0 + MINUTE, ["signup"]), T0 + MINUTE, old);
  assert.equal(opened.opened.length, 1, "the signup incident opens on the bootstrap targets");

  // Revision 1 moves the signup checks to a new component and removes "signup"; it lands while the run's checks are out.
  const raw: unknown = JSON.parse(read("test/support/targets.fixture.json"));
  if (!isRecord(raw) || !Array.isArray(raw["components"]) || !Array.isArray(raw["checks"])) throw new Error("example targets unreadable");
  const movedJson = {
    ...raw,
    components: [...raw["components"].filter(isRecord).filter((component) => component["id"] !== "signup"), { id: "signup_edge", name: "Signup" }],
    checks: raw["checks"].filter(isRecord).map((check) => (check["component"] === "signup" ? { ...check, component: "signup_edge" } : check)),
  };
  const moved = parseTargets(movedJson);
  assert.ok(moved !== null);
  const policy: unknown = JSON.parse(read("config/escalation.example.json"));
  const document = { schema: 1, revision: 1, updatedAt: null, updatedBy: "Dana Admin", policy, targets: movedJson, senders: null, maintenance: [] };
  assert.equal((await object.offerPlatformConfig(JSON.stringify(document), T0 + 2 * MINUTE)).outcome, "accepted");

  // The run that started before the revision: its results name "signup", and "signup" is what they are folded into.
  const race = await object.ingest(runOf(old, T0 + 2 * MINUTE, ["signup"]), T0 + 2 * MINUTE, old);
  assert.deepEqual([race.opened, race.resolved], [[], []], "the incident is not closed as removed by results that still report on it");

  // From the next run on, the new targets apply: the removed component's incident closes.
  const next = await object.ingest(runOf(moved, T0 + 3 * MINUTE, []), T0 + 3 * MINUTE, moved);
  assert.deepEqual(next.resolved, opened.opened);
});

const ADVANCE_DUE = /^SELECT \* FROM incidents WHERE resolved_at IS NULL AND next_alarm_at IS NOT NULL AND next_alarm_at <= \?/;
const NEXT_WAKE = /^SELECT MIN\(at\) AS at FROM/;

void test("an alarm whose escalation step throws still re-arms the alarm; a failing reschedule falls back to 30 s", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const { object, alarms, failOn } = harness();
  const targets = fixtureTargets();
  await object.ingest(runOf(targets, T0, ["signup"]), T0, targets);
  await object.ingest(runOf(targets, T0 + MINUTE, ["signup"]), T0 + MINUTE, targets);
  assert.ok(alarms.at(-1) !== null, "an open incident keeps an alarm");
  alarms.length = 0;
  failOn(ADVANCE_DUE);
  await assert.rejects(object.alarm(), /SQLITE_INJECTED_FAILURE/, "the error still reaches the runtime (which retries the alarm)");
  assert.equal(alarms.length, 1, "but the alarm was set again first");
  assert.ok(typeof alarms[0] === "number" && alarms[0] > Date.now(), "for the next escalation deadline");

  alarms.length = 0;
  failOn(NEXT_WAKE);
  const before = Date.now();
  await object.alarm();
  const [fallback] = alarms;
  assert.ok(typeof fallback === "number" && fallback >= before + 30_000 && fallback <= Date.now() + 30_000,
    "a fixed retry when the next wake-up cannot be computed");

  alarms.length = 0;
  failOn(/^INSERT INTO runs/);
  await assert.rejects(object.ingest(runOf(targets, T0 + 2 * MINUTE, []), T0 + 2 * MINUTE, targets), /SQLITE_INJECTED_FAILURE/);
  assert.equal(alarms.length, 1, "ingest re-arms in finally too");
});

void test("alarm floor: never sooner than 1 s from now, whatever is due (workerd #7915 loses an alarm set to the running alarm's time)", () => {
  if (!isAlarmTime(alarmTime)) throw new Error("alarmTime not exported");
  assert.equal(alarmTime(T0, T0), T0 + 1000, "due now: one second from now");
  assert.equal(alarmTime(T0 - 60_000, T0), T0 + 1000, "overdue: one second from now");
  assert.equal(alarmTime(T0 + 5000, T0), T0 + 5000);
  assert.equal(alarmTime(null, T0), null);
  const source = read("worker/monitor-object.ts");
  assert.match(source, /export const ALARM_FLOOR_MS = 1000;/);
  assert.match(source, /workerd\/issues\/7915/, "the reason stays next to the constant");
});

void test("the monitor object is always addressed in jurisdiction us, by name", () => {
  if (!isMonitorId(monitorId)) throw new Error("monitorId not exported");
  const seen: string[] = [];
  const id = monitorId({ jurisdiction: (name) => {
    seen.push(`jurisdiction:${name}`);
    return { idFromName: (objectName) => {
      seen.push(`name:${objectName}`);
      return "id";
    } };
  } });
  assert.equal(id, "id");
  assert.deepEqual(seen, ["jurisdiction:us", "name:monitor"]);
  const source = read("worker/index.ts");
  assert.equal(source.match(/idFromName\(/g)?.length, 1, "no other way to address the object");
});

void test("ingest starts this week's drill at its slot; the private view lists it with warnings and contact health", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const policy: unknown = JSON.parse(read("config/escalation.example.json"));
  if (!isRecord(policy)) throw new Error("example policy unreadable");
  // T0 is Wednesday 09:00 in New York.
  const { object } = harness({ ESCALATION_POLICY: JSON.stringify({ ...policy, drill: { enabled: true, weekday: 3, time: "09:00" } }) });
  const targets = fixtureTargets();
  await object.ingest(runOf(targets, T0, []), T0, targets);
  const view: unknown = JSON.parse(object.privateStatus(T0 + 1000));
  if (!isRecord(view)) throw new Error("private view unreadable");
  const drills = Array.isArray(view["drills"]) ? view["drills"].filter(isRecord) : [];
  assert.deepEqual(drills.map((drill) => [drill["contactId"], drill["outcome"]]), [["primary_oncall", null]]);
  const monitor = isRecord(view["monitor"]) ? view["monitor"] : {};
  assert.ok(Array.isArray(monitor["warnings"]) && !monitor["warnings"].includes("drill_disabled"));
  assert.equal(monitor["nextDrillAt"], new Date(T0 + 7 * 86_400_000).toISOString());
  const publicIncidents: unknown = JSON.parse(JSON.stringify(view["incidents"]));
  assert.deepEqual(publicIncidents, [], "the drill is not a public incident");
});

void test("prepareReport: due at once (nothing sent yet), then not again until something changes or 5 minutes pass", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const { object } = harness();
  const targets = fixtureTargets();
  await object.ingest(runOf(targets, T0, []), T0, targets);
  const first = object.prepareReport(T0 + 1000);
  assert.ok(first !== null);
  const body: unknown = JSON.parse(first.body);
  assert.ok(isRecord(body) && isRecord(body["monitor"]) && body["monitor"]["deliveryMode"] === "log");
  object.reportSent(first.incidentIds, [], T0 + 2000, first.seq);
  assert.equal(object.prepareReport(T0 + 3000), null, "nothing changed since");

  // Refused as invalid while carrying incidents: the next one goes without incidents, saying why.
  await object.ingest(runOf(targets, T0 + 6 * 60_000, []), T0 + 6 * 60_000, targets);
  object.reportFailed("report_status_400", T0 + 6 * 60_000, 2);
  const stateOnly = object.prepareReport(T0 + 6 * 60_000 + 1000);
  assert.ok(stateOnly !== null);
  const stateBody: unknown = JSON.parse(stateOnly.body);
  assert.ok(isRecord(stateBody) && Array.isArray(stateBody["incidents"]) && stateBody["incidents"].length === 0);
  assert.ok(isRecord(stateBody["monitor"]) && Array.isArray(stateBody["monitor"]["warnings"])
    && stateBody["monitor"]["warnings"].includes("report_incidents_refused"));
});
