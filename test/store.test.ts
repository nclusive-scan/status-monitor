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

void test("store: config errors are recorded for the status page", () => {
  const { store } = newStore();
  store.recordConfigError("policy: must be an object", T0);
  assert.equal(store.getMeta("config_error"), "policy: must be an object");
  store.recordRun(allOk(T0 + MINUTE), targets, policy, T0 + MINUTE);
  assert.equal(store.getMeta("config_error"), "", "cleared by the next good run");
});
