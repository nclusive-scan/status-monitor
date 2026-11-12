// Component state and the persistent store on real SQLite (node:sqlite behind the Durable Object SqlStorage surface):
// 2 failing runs open, 3 passing runs resolve, escalation through the outbox, idempotent replays, retention.
import assert from "node:assert/strict";
import test from "node:test";
import type { ComponentConfig } from "../worker/config.ts";
import { initialComponentState, stepComponent } from "../worker/engine.ts";
import { MIGRATIONS } from "../worker/schema.ts";
import { backoffMs, MonitorStore, RETENTION_MS } from "../worker/store.ts";
import type { CheckResult, Status } from "../worker/types.ts";
import { countingRandom, examplePolicy, fixtureTargets, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

const targets = fixtureTargets();
const policy = examplePolicy();
const component: ComponentConfig = { id: "signup", name: "Signup", pageOn: "down", alert: "page", public: true };
const rules = { openAfterFailures: 2, resolveAfterPasses: 3 };
const result = (componentId: string, status: Status, at: number, inconclusive = false): CheckResult => ({
  checkId: `${componentId}_http`, componentId, type: "http", status, inconclusive, latencyMs: 10, detail: status === "ok" ? "ok" : "redirect_loop",
  observedAt: at, data: null,
});

void test("engine: one failing run never opens; two do; three passes resolve; a pass in between resets", () => {
  let state = initialComponentState("signup");
  const run = (status: Status, at: number) => {
    const step = stepComponent(component, state, [result("signup", status, at)], rules, at);
    state = step.state;
    return step.transition;
  };
  assert.equal(run("down", T0), null, "a single blip");
  assert.equal(run("ok", T0 + MINUTE), null);
  assert.equal(run("down", T0 + 2 * MINUTE), null);
  assert.equal(run("down", T0 + 3 * MINUTE), "open");
  state = { ...state, openIncidentId: "inc_1" };
  assert.equal(run("down", T0 + 4 * MINUTE), null, "an open incident does not reopen");
  assert.equal(run("ok", T0 + 5 * MINUTE), null);
  assert.equal(run("ok", T0 + 6 * MINUTE), null);
  assert.equal(run("down", T0 + 7 * MINUTE), null, "flap resets the pass count");
  assert.equal(run("ok", T0 + 8 * MINUTE), null);
  assert.equal(run("ok", T0 + 9 * MINUTE), null);
  assert.equal(run("ok", T0 + 10 * MINUTE), "resolve");
  assert.equal(state.openIncidentId, null);
});

void test("engine: degraded does not page a pageOn=down component; inconclusive results change nothing", () => {
  const degraded = stepComponent(component, { ...initialComponentState("signup"), consecutiveFailures: 5 }, [result("signup", "degraded", T0)], rules, T0);
  assert.equal(degraded.transition, null);
  assert.equal(degraded.state.status, "degraded");
  const paging = stepComponent({ ...component, pageOn: "degraded" }, { ...initialComponentState("signup"), consecutiveFailures: 1 },
    [result("signup", "degraded", T0)], rules, T0);
  assert.equal(paging.transition, "open");
  const before = { ...initialComponentState("signup"), consecutiveFailures: 1 };
  const nothing = stepComponent(component, before, [result("signup", "down", T0, true)], rules, T0);
  assert.deepEqual([nothing.state, nothing.transition, nothing.runStatus], [before, null, null]);
});

function newStore() {
  const storage = sqliteStorage();
  return { storage, store: new MonitorStore(storage, countingRandom()) };
}

const allOk = (at: number): CheckResult[] => targets.components.map((item) => result(item.id, "ok", at));
const signupDown = (at: number): CheckResult[] => targets.components.map((item) => result(item.id, item.id === "signup" ? "down" : "ok", at));

void test("store: migrations apply once and are recorded", () => {
  const { storage, store } = newStore();
  assert.equal(store.getMeta("schema_version"), String(MIGRATIONS.length));
  const again = new MonitorStore(storage, countingRandom());
  assert.equal(again.getMeta("schema_version"), String(MIGRATIONS.length));
});

void test("store: two failing runs open one incident and queue the primary page; nothing on the first", () => {
  const { store } = newStore();
  assert.deepEqual(store.recordRun(signupDown(T0), targets, policy, T0).opened, []);
  assert.equal(store.notifications().length, 0);
  const { opened } = store.recordRun(signupDown(T0 + MINUTE), targets, policy, T0 + MINUTE);
  assert.equal(opened.length, 1);
  const incident = store.incident(opened[0] ?? "");
  assert.equal(incident?.title, "Signup is down", "no detail code in the public title");
  assert.match(incident.ackCode, /^[2-9A-HJKMNP-Z]{6}$/);
  const queued = store.notifications();
  assert.deepEqual(queued.map((row) => [row.kind, row.contactId, row.channel]).sort(),
    [["page", "primary_oncall", "email"], ["page", "primary_oncall", "sms"]]);
  assert.equal(store.nextWakeAt(), T0 + MINUTE, "the pages are due now");
  assert.equal(store.recordRun(signupDown(T0 + 2 * MINUTE), targets, policy, T0 + 2 * MINUTE).opened.length, 0, "still one incident");
});

void test("store: claimed rows are not handed out twice; failures back off; sends are marked", () => {
  const { store } = newStore();
  store.recordRun(signupDown(T0), targets, policy, T0);
  store.recordRun(signupDown(T0 + MINUTE), targets, policy, T0 + MINUTE);
  const claimed = store.claimDue(T0 + MINUTE);
  assert.equal(claimed.length, 2);
  assert.equal(store.claimDue(T0 + MINUTE).length, 0, "an overlapping alarm gets nothing");
  const [sms, email] = [claimed.find((item) => item.row.channel === "sms"), claimed.find((item) => item.row.channel === "email")];
  assert.ok(sms !== undefined && email !== undefined);
  store.markFailed(sms.row.key, "twilio_http_503", true, T0 + MINUTE);
  store.markSent(email.row.key, "cfemail:1", T0 + MINUTE);
  const rows = store.notifications();
  assert.deepEqual(rows.find((row) => row.channel === "sms")?.status, "pending");
  assert.deepEqual(rows.find((row) => row.channel === "email")?.status, "sent", "Twilio down never holds up email");
  assert.equal(store.claimDue(T0 + MINUTE + backoffMs(1) - 1).length, 0, "waits out the backoff");
  assert.equal(store.claimDue(T0 + MINUTE + backoffMs(1)).length, 1);
  store.markFailed(sms.row.key, "twilio_http_400", false, T0 + 2 * MINUTE);
  assert.equal(store.notifications().find((row) => row.channel === "sms")?.status, "failed", "a permanent error is not retried");
  assert.deepEqual([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(10)], [30_000, 60_000, 120_000, 900_000]);
});

void test("store: escalation steps are taken by time, idempotently, and acknowledgement stops them", () => {
  const { store } = newStore();
  store.recordRun(signupDown(T0), targets, policy, T0);
  const id = store.recordRun(signupDown(T0 + MINUTE), targets, policy, T0 + MINUTE).opened[0] ?? "";
  assert.equal(store.advanceDue(policy, T0 + 5 * MINUTE), 0, "not due before the primary timeout");
  assert.equal(store.advanceDue(policy, T0 + 6 * MINUTE), 1);
  assert.equal(store.advanceDue(policy, T0 + 6 * MINUTE), 0, "a retried alarm takes nothing more");
  const kinds = store.notifications().map((row) => `${row.kind}:${row.contactId}:${row.channel}`).sort();
  assert.deepEqual(kinds, [
    "escalation_notice:primary_oncall:email", "escalation_notice:primary_oncall:sms", "page:engineering_lead:email",
    "page:primary_oncall:email", "page:primary_oncall:sms", "page:secondary_oncall:email", "page:secondary_oncall:sms",
  ]);
  assert.equal(store.acknowledge(id, { name: "Engineering Lead", via: "email" }, policy, T0 + 7 * MINUTE), "acknowledged");
  assert.equal(store.acknowledge(id, { name: "Primary On-call", via: "sms" }, policy, T0 + 8 * MINUTE), "already_acknowledged");
  assert.equal(store.incident(id)?.acknowledgedBy, "Engineering Lead");
  const acks = store.notifications().filter((row) => row.kind === "acknowledged");
  assert.deepEqual([...new Set(acks.map((row) => row.contactId))].sort(), ["engineering_lead", "primary_oncall", "secondary_oncall"]);
  assert.equal(store.advanceDue(policy, T0 + 100 * MINUTE), 0, "no deadlines after acknowledgement");
  assert.equal(store.acknowledge("inc_missing", { name: "x", via: "sms" }, policy, T0), "not_found");
});

void test("store: three passing runs resolve, notify everyone paged, and free the component for a new incident", () => {
  const { store } = newStore();
  store.recordRun(signupDown(T0), targets, policy, T0);
  const id = store.recordRun(signupDown(T0 + MINUTE), targets, policy, T0 + MINUTE).opened[0] ?? "";
  store.recordRun(allOk(T0 + 2 * MINUTE), targets, policy, T0 + 2 * MINUTE);
  store.recordRun(allOk(T0 + 3 * MINUTE), targets, policy, T0 + 3 * MINUTE);
  assert.deepEqual(store.recordRun(allOk(T0 + 4 * MINUTE), targets, policy, T0 + 4 * MINUTE).resolved, [id]);
  assert.equal(store.incident(id)?.phase, "resolved");
  assert.equal(store.acknowledge(id, { name: "x", via: "sms" }, policy, T0 + 5 * MINUTE), "resolved");
  assert.deepEqual(store.notifications().filter((row) => row.kind === "resolved").map((row) => row.contactId), ["primary_oncall", "primary_oncall"]);
  store.recordRun(signupDown(T0 + 5 * MINUTE), targets, policy, T0 + 5 * MINUTE);
  assert.equal(store.recordRun(signupDown(T0 + 6 * MINUTE), targets, policy, T0 + 6 * MINUTE).opened.length, 1, "a new incident");
  assert.equal(store.openIncidentByCode(store.incident(id)?.ackCode ?? ""), null, "a resolved incident's code no longer matches");
});

void test("store: uptime from hourly rollups, and 35-day retention", () => {
  const { store } = newStore();
  for (let minute = 0; minute < 10; minute += 1) {
    const at = T0 + minute * MINUTE;
    store.recordRun(minute < 2 ? signupDown(at) : allOk(at), targets, policy, at);
  }
  assert.deepEqual(store.uptime(T0 + 10 * MINUTE).get("signup"), { h24: 80, d7: 80, d30: 80 });
  assert.equal(store.uptime(T0).get("newsletters")?.d30, 100);
  const later = T0 + RETENTION_MS + 2 * 3600_000;
  store.prune(later);
  assert.equal(store.recentFailures().length, 0, "old check history dropped");
  assert.equal(store.uptime(later).get("signup"), undefined);
});

const HOUR = 3600_000, DAY = 24 * HOUR;
/** One signup result with its own check id and latency. */
const timed = (check: string, status: Status, latencyMs: number, at: number, inconclusive = false): CheckResult => ({
  ...result("signup", status, at, inconclusive), checkId: `signup_${check}`, latencyMs,
});

void test("store: history has 30 UTC days of uptime, oldest first, today last, null on days without runs", () => {
  const { store } = newStore();
  store.recordRun(signupDown(T0 - 30 * DAY), targets, policy, T0 - 30 * DAY);
  for (let minute = 0; minute < 3; minute += 1) {
    const at = T0 - 29 * DAY + minute * MINUTE;
    store.recordRun(minute === 0 ? signupDown(at) : allOk(at), targets, policy, at);
  }
  for (let minute = 0; minute < 4; minute += 1) store.recordRun(allOk(T0 + minute * MINUTE), targets, policy, T0 + minute * MINUTE);
  // Just before midnight UTC: the same day as T0. Degraded counts as up, like uptime().
  const lateToday = Date.UTC(2026, 10, 11, 23, 59, 0);
  store.recordRun(targets.components.map((item) => result(item.id, item.id === "signup" ? "degraded" : "ok", lateToday)), targets, policy, lateToday);

  const history = store.history(lateToday + 30_000).get("signup")?.history ?? [];
  assert.equal(history.length, 30);
  assert.deepEqual(history[0], { date: "2026-10-13", uptime: 66.667 }, "the oldest day is 29 days back; the day before it is out");
  assert.deepEqual(history[29], { date: "2026-11-11", uptime: 100 }, "today is last");
  assert.deepEqual(history.slice(1, 29).map((day) => day.uptime), Array.from({ length: 28 }, () => null), "days without runs are null");
  assert.deepEqual(history.map((day) => day.date).slice(27), ["2026-11-09", "2026-11-10", "2026-11-11"]);
  assert.equal(store.history(lateToday).get("newsletters")?.history[0]?.uptime, 100);
  // At midnight the window moves on: the new day is null and the oldest day drops off.
  const tomorrow = store.history(Date.UTC(2026, 10, 12, 0, 0, 1)).get("signup")?.history ?? [];
  assert.deepEqual([tomorrow[0]?.date, tomorrow[28], tomorrow[29]], ["2026-10-14", { date: "2026-11-11", uptime: 100 }, { date: "2026-11-12", uptime: null }]);
  assert.equal(store.history(T0 + 40 * DAY).get("signup"), undefined, "nothing in the window, no entry (the projection fills it with nulls)");
});

void test("store: history has 24 hours of latency (avg and max of one sample per run); down and inconclusive results are left out", () => {
  const { storage, store } = newStore();
  const record = (at: number, results: CheckResult[]): void => {
    store.recordRun(results, targets, policy, at);
  };
  record(T0 - 24 * HOUR, [timed("http", "ok", 999, T0 - 24 * HOUR)]);
  record(T0 - 3 * HOUR, [timed("http", "ok", 40, T0 - 3 * HOUR)]);
  // The run's sample is its slowest conclusive result that is not down.
  record(T0, [timed("http", "ok", 100, T0), timed("dns", "ok", 300, T0)]);
  record(T0 + MINUTE, [timed("http", "ok", 200, T0 + MINUTE), timed("dns", "down", 5000, T0 + MINUTE)]);
  record(T0 + 2 * MINUTE, [timed("http", "ok", 50, T0 + 2 * MINUTE), timed("dns", "degraded", 9000, T0 + 2 * MINUTE, true)]);
  // Only a timeout: the run counts for uptime but adds no latency sample.
  record(T0 + 3 * MINUTE, [timed("http", "down", 7000, T0 + 3 * MINUTE)]);

  const latency = store.history(T0 + 30 * MINUTE).get("signup")?.latency ?? [];
  assert.equal(latency.length, 24);
  assert.deepEqual(latency[23], { hour: "2026-11-11T14:00:00.000Z", avgMs: 183, maxMs: 300 }, "the current hour is last; avg rounds (300+200+50)/3");
  assert.deepEqual(latency[20], { hour: "2026-11-11T11:00:00.000Z", avgMs: 40, maxMs: 40 });
  assert.deepEqual(latency[0], { hour: "2026-11-10T15:00:00.000Z", avgMs: null, maxMs: null }, "24 hours back is out of the window");
  assert.deepEqual(latency[22], { hour: "2026-11-11T13:00:00.000Z", avgMs: null, maxMs: null });
  assert.equal(latency.filter((hour) => hour.avgMs !== null).length, 2);
  const row = storage.db.prepare("SELECT total, up, latency_sum, latency_count, latency_max FROM component_hourly WHERE component_id = 'signup' AND hour = ?")
    .get(Math.floor(T0 / HOUR));
  assert.deepEqual({ ...row }, { total: 4, up: 2, latency_sum: 550, latency_count: 3, latency_max: 300 }, "the timeout-only run counted no sample");
});

void test("store: a store at the previous schema version migrates to the latency columns and keeps its hourly rows", () => {
  const storage = sqliteStorage();
  storage.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const migration of MIGRATIONS.slice(0, -1)) {
    for (const statement of migration.split(";").map((part) => part.trim()).filter((part) => part !== "")) storage.db.exec(statement);
  }
  storage.db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '${String(MIGRATIONS.length - 1)}')`);
  storage.db.exec(`INSERT INTO component_hourly (component_id, hour, total, up) VALUES ('signup', ${String(Math.floor(T0 / HOUR))}, 4, 3),
    ('signup', ${String(Math.floor((T0 - DAY) / HOUR))}, 60, 60)`);
  const store = new MonitorStore(storage, countingRandom());
  assert.equal(store.getMeta("schema_version"), String(MIGRATIONS.length));
  const before = store.history(T0 + 30 * MINUTE).get("signup");
  assert.ok(before !== undefined);
  assert.deepEqual(before.history.slice(28), [{ date: "2026-11-10", uptime: 100 }, { date: "2026-11-11", uptime: 75 }], "old rollups still count");
  assert.deepEqual(before.latency[23], { hour: "2026-11-11T14:00:00.000Z", avgMs: null, maxMs: null }, "an hour rolled up before has no samples");
  assert.deepEqual(store.uptime(T0 + 30 * MINUTE).get("signup")?.h24, 75);
  store.recordRun([timed("http", "ok", 120, T0 + MINUTE)], targets, policy, T0 + MINUTE);
  const after = store.history(T0 + 30 * MINUTE).get("signup");
  assert.ok(after !== undefined);
  assert.deepEqual(after.history[29], { date: "2026-11-11", uptime: 80 });
  assert.deepEqual(after.latency[23], { hour: "2026-11-11T14:00:00.000Z", avgMs: 120, maxMs: 120 }, "only the new sample counts");
});

void test("store: config errors are recorded for the status page", () => {
  const { store } = newStore();
  store.recordConfigError("policy: must be an object", T0);
  assert.equal(store.getMeta("config_error"), "policy: must be an object");
  store.recordRun(allOk(T0 + MINUTE), targets, policy, T0 + MINUTE);
  assert.equal(store.getMeta("config_error"), "", "cleared by the next good run");
});
