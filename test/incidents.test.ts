// Incident lifecycle edge cases on the real store (node:sqlite behind the Durable Object SqlStorage surface): grouped
// fleet-wide outages, outbox rows cancelled after acknowledgement or resolution, open incidents that stay visible,
// removed components, flapping, repeated cron deliveries, ack links of removed contacts, and the cost of /api/status.
import assert from "node:assert/strict";
import test from "node:test";
import { ackPageView, acknowledgeByLink, acknowledgeBySms } from "../worker/ack-actions.ts";
import type { EscalationPolicy, MonitorConfig, TargetsConfig } from "../worker/config.ts";
import { messageContext } from "../worker/deliver.ts";
import { smsText } from "../worker/notify/messages.ts";
import { MIGRATIONS } from "../worker/schema.ts";
import type { SqlLike, StorageLike } from "../worker/schema.ts";
import { privateProjection, publicProjection } from "../worker/redact.ts";
import { fullSnapshot, publicSnapshot, TimedCache } from "../worker/status-view.ts";
import { GROUP_WINDOW_MS, MonitorStore } from "../worker/store.ts";
import type { CheckResult, Status } from "../worker/types.ts";
import { countingRandom, examplePolicy, fixtureTargets, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

const targets = fixtureTargets();
const policy = examplePolicy();
const result = (componentId: string, status: Status, at: number): CheckResult => ({
  checkId: `${componentId}_http`, componentId, type: "http", status, inconclusive: false, latencyMs: 10, detail: status === "ok" ? "ok" : "redirect_loop",
  observedAt: at, data: null,
});
const run = (at: number, down: readonly string[], config: TargetsConfig = targets): CheckResult[] =>
  config.components.map((item) => result(item.id, down.includes(item.id) ? "down" : "ok", at));
const allIds = targets.components.map((item) => item.id);
const monitorConfig: MonitorConfig = {
  brandName: "Acme", mode: "standalone", targets, policy, statusPageUrl: "https://status.example.com", twilioWebhookUrl: "https://status.example.com/hooks/twilio",
  healthKey: null, configKey: null, ackSigningKey: "a".repeat(40), twilio: null, email: null, heartbeatUrl: null, heartbeatFailUrl: null,
  dnsSecondaryResolver: null, maintenance: [], deliveryMode: "live", source: { kind: "bootstrap" },
};

function newStore(storage: StorageLike = sqliteStorage()) {
  return { storage, store: new MonitorStore(storage, countingRandom()) };
}

/** Opens one signup incident (two failing runs) and returns its id. */
function openSignup(store: MonitorStore, at = T0): string {
  store.recordRun(run(at, ["signup"]), targets, policy, at);
  const id = store.recordRun(run(at + MINUTE, ["signup"]), targets, policy, at + MINUTE).opened[0];
  if (id === undefined) throw new Error("no incident opened");
  return id;
}

const pendingKeys = (store: MonitorStore): string[] => store.notifications().filter((row) => row.status === "pending").map((row) => row.key).sort();

void test("a fleet-wide outage opens one escalation: one page per channel, one code, one acknowledgement for all", () => {
  const { store } = newStore();
  store.recordRun(run(T0, allIds), targets, policy, T0);
  const { opened } = store.recordRun(run(T0 + MINUTE, allIds), targets, policy, T0 + MINUTE);
  assert.equal(opened.length, 8, "every component still has its own incident on the status page");
  const incidents = opened.map((id) => store.incident(id));
  assert.equal(new Set(incidents.map((incident) => incident?.groupId)).size, 1, "one group");
  assert.equal(new Set(incidents.map((incident) => incident?.ackCode)).size, 1, "one code");
  assert.deepEqual(store.notifications().map((row) => [row.kind, row.contactId, row.channel]).sort(),
    [["page", "primary_oncall", "email"], ["page", "primary_oncall", "sms"]], "two messages at open, not sixteen");

  const claimed = store.claimDue(T0 + MINUTE);
  assert.equal(claimed[0]?.alsoAffected.length, 7, "the page names the seven other components");
  const text = smsText({
    brand: "Acme", kind: "page", componentName: "Signup", incidentTitle: "Signup is down", openedAt: T0 + MINUTE, ackCode: "K7M2QX",
    statusPageUrl: monitorConfig.statusPageUrl, cycle: 1, maxCycles: 3, targetTierName: null, targetContactNames: [], acknowledgedBy: null,
    now: T0 + MINUTE, ackUrl: null, alsoAffected: ["Newsletters", "Scheduling", "Checkout", "Upload", "Forums", "Platform API", "Notifications"],
  });
  assert.match(text, /DOWN: Signup \+7\. /);
  assert.match(text, /Reply ACK K7M2QX to acknowledge all 8\. status\.example\.com\n/, "the ACK instruction and link come first");
  assert.match(text, /Also affected: Newsletters, Scheduling, Checkout, Upload, Forums, Platform API and 1 more\./);

  // A member's code is the group's code: acknowledging through any member acknowledges them all.
  const member = opened[3] ?? "";
  assert.equal(store.acknowledge(member, { name: "Primary On-call", via: "sms" }, policy, T0 + 2 * MINUTE), "acknowledged");
  assert.ok(opened.every((id) => store.incident(id)?.acknowledgedAt === T0 + 2 * MINUTE), "every incident in the group shows acknowledged");
  assert.equal(store.advanceDue(policy, T0 + 30 * MINUTE), 0, "nothing escalates after the acknowledgement");
  assert.equal(store.notifications().filter((row) => row.kind === "page").length, 2);
});

void test("an incident opening after the group's window, or after it was acknowledged, pages on its own", () => {
  const { store } = newStore();
  const signup = openSignup(store);
  const late = T0 + MINUTE + GROUP_WINDOW_MS + MINUTE;
  store.recordRun(run(late, ["signup", "forums"]), targets, policy, late);
  const forums = store.recordRun(run(late + MINUTE, ["signup", "forums"]), targets, policy, late + MINUTE).opened[0] ?? "";
  assert.notEqual(store.incident(forums)?.groupId, store.incident(signup)?.groupId);

  const second = newStore().store;
  const first = openSignup(second);
  second.acknowledge(first, { name: "Primary On-call", via: "sms" }, policy, T0 + 2 * MINUTE);
  second.recordRun(run(T0 + 2 * MINUTE, ["signup", "forums"]), targets, policy, T0 + 2 * MINUTE);
  const next = second.recordRun(run(T0 + 3 * MINUTE, ["signup", "forums"]), targets, policy, T0 + 3 * MINUTE).opened[0] ?? "";
  assert.equal(second.incident(next)?.groupId, next, "a new failure after an acknowledgement pages afresh");
});

void test("when the group's carrier recovers first, a member carries the escalation on and the same code still works", () => {
  const { store } = newStore();
  store.recordRun(run(T0, ["signup", "forums"]), targets, policy, T0);
  const [signup = "", forums = ""] = store.recordRun(run(T0 + MINUTE, ["signup", "forums"]), targets, policy, T0 + MINUTE).opened;
  const code = store.incident(signup)?.ackCode ?? "";
  for (let minute = 2; minute <= 4; minute += 1) store.recordRun(run(T0 + minute * MINUTE, ["forums"]), targets, policy, T0 + minute * MINUTE);
  assert.notEqual(store.incident(signup)?.resolvedAt, null);
  const carrier = store.incident(forums);
  assert.equal(carrier?.phase, "paging", "forums now carries the escalation");
  assert.equal(carrier.escalation?.incidentId, forums);
  assert.equal(carrier.nextAlarmAt, T0 + MINUTE + 5 * MINUTE, "the deadline is unchanged");
  assert.ok(store.notifications().some((row) => row.kind === "resolved" && row.incidentId === signup), "signup's recovery is announced");

  store.advanceDue(policy, T0 + 6 * MINUTE);
  assert.ok(store.notifications().some((row) => row.kind === "page" && row.incidentId === forums && row.contactId === "secondary_oncall"),
    "escalation continues to the secondary tier");
  assert.equal(store.openIncidentByCode(code)?.id, forums);
  // An email link minted for signup (now resolved) acknowledges the group, not "resolved".
  assert.equal(acknowledgeByLink(store, policy, signup, "primary_oncall", T0 + 7 * MINUTE), "acknowledged");
  assert.notEqual(store.incident(forums)?.acknowledgedAt, null);
});

void test("a page still waiting in the outbox is cancelled by an acknowledgement, never delivered after it", () => {
  const { store } = newStore();
  const id = openSignup(store);
  store.advanceDue(policy, T0 + 6 * MINUTE);
  // Twilio is down: the secondary's SMS page fails and waits for its retry.
  const secondarySms = `${id}:page-c1-t1:secondary_oncall:sms`;
  for (const { row } of store.claimDue(T0 + 6 * MINUTE)) {
    if (row.key === secondarySms) store.markFailed(row.key, "twilio_503", true, T0 + 6 * MINUTE);
    else store.markSent(row.key, "sent", T0 + 6 * MINUTE);
  }
  assert.deepEqual(pendingKeys(store), [secondarySms]);
  store.acknowledge(id, { name: "Primary On-call", via: "sms" }, policy, T0 + 6 * MINUTE + 10_000);
  const due = store.claimDue(T0 + 8 * MINUTE).map(({ row }) => row.key);
  assert.ok(!due.includes(secondarySms), "the stale page is not handed out");
  assert.ok(due.every((key) => key.includes(":ack:")), "only the acknowledgement notices go out");
  assert.equal(store.notifications().find((row) => row.key === secondarySms)?.status, "cancelled");
});

void test("pages still waiting when the incident resolves are cancelled; RESOLVED is never followed by DOWN", () => {
  const { store } = newStore();
  const id = openSignup(store);
  for (const { row } of store.claimDue(T0 + MINUTE)) store.markFailed(row.key, "provider_503", true, T0 + MINUTE);
  for (let minute = 2; minute <= 4; minute += 1) store.recordRun(run(T0 + minute * MINUTE, []), targets, policy, T0 + minute * MINUTE);
  assert.notEqual(store.incident(id)?.resolvedAt, null);
  const kinds = store.claimDue(T0 + 10 * MINUTE).map(({ row }) => row.kind);
  assert.deepEqual([...new Set(kinds)], ["resolved"]);
  assert.ok(store.notifications().filter((row) => row.kind === "page").every((row) => row.status === "cancelled"));
});

void test("a row cancelled while its send was in flight stays cancelled when the send then fails", () => {
  const { store } = newStore();
  const id = openSignup(store);
  const claimed = store.claimDue(T0 + MINUTE);
  assert.equal(claimed.length, 2);
  store.acknowledge(id, { name: "Primary On-call", via: "sms" }, policy, T0 + MINUTE + 1000);
  const [first, second] = claimed;
  // One in-flight send fails (it must not come back as pending and retry); the other went through (recorded as sent).
  store.markFailed(first?.row.key ?? "", "provider_503", true, T0 + MINUTE + 2000);
  store.markSent(second?.row.key ?? "", "SM123", T0 + MINUTE + 2000);
  const status = (key: string | undefined): string | undefined => store.notifications().find((row) => row.key === key)?.status;
  assert.equal(status(first?.row.key), "cancelled");
  assert.equal(status(second?.row.key), "sent");
  assert.ok(store.claimDue(T0 + 10 * MINUTE).every(({ row }) => row.kind === "acknowledged"));
});

void test("an open, exhausted incident stays listed however many newer incidents resolve after it", () => {
  const { store } = newStore();
  store.recordRun(run(T0, ["forums"]), targets, policy, T0);
  const forums = store.recordRun(run(T0 + MINUTE, ["forums"]), targets, policy, T0 + MINUTE).opened[0] ?? "";
  store.acknowledge(forums, { name: "Primary On-call", via: "sms" }, policy, T0 + 2 * MINUTE);
  let at = T0 + 20 * MINUTE;
  for (let flap = 0; flap < 55; flap += 1) {
    for (const down of [["forums", "signup"], ["forums", "signup"], ["forums"], ["forums"], ["forums"]]) {
      store.recordRun(run(at, down), targets, policy, at);
      at += MINUTE;
    }
  }
  const listed = store.incidents(at);
  assert.ok(listed.length > 50);
  assert.equal(listed[0]?.id, forums, "open incidents first");
  assert.equal(listed.filter((incident) => incident.resolvedAt !== null).length, 50, "then the 50 most recently resolved");
});

void test("removing a component closes its open incident with a notice instead of paging through every cycle", () => {
  const { store } = newStore();
  const id = openSignup(store);
  const without: TargetsConfig = { ...targets, components: targets.components.filter((item) => item.id !== "signup") };
  const { resolved } = store.recordRun(run(T0 + 2 * MINUTE, [], without), without, policy, T0 + 2 * MINUTE);
  assert.deepEqual(resolved, [id]);
  const incident = store.incident(id);
  assert.equal(incident?.closeReason, "component_removed");
  assert.equal(store.component("signup").openIncidentId, null);
  for (let minute = 3; minute <= 200; minute += 1) store.recordRun(run(T0 + minute * MINUTE, [], without), without, policy, T0 + minute * MINUTE);
  assert.equal(store.notifications().filter((row) => row.kind === "page").length, 2, "no tier after the primary was ever paged");
  assert.ok(store.notifications().some((row) => row.kind === "resolved"), "everyone paged is told");
  assert.equal(store.notifications().filter((row) => row.kind === "page").every((row) => row.status === "cancelled"), true);
});

void test("a component failing every other run opens an incident (flapping); a lone blip still never does", () => {
  const { store } = newStore();
  const opened: string[] = [];
  for (let minute = 0; minute < 7; minute += 1) {
    opened.push(...store.recordRun(run(T0 + minute * MINUTE, minute % 2 === 0 ? ["signup"] : []), targets, policy, T0 + minute * MINUTE).opened);
  }
  assert.equal(opened.length, 1, "opened on the 7th run: 4 failures in the window");
  assert.equal(store.incident(opened[0] ?? "")?.title, "Signup is down");

  const quiet = newStore().store;
  let count = 0;
  for (let minute = 0; minute < 120; minute += 1) {
    const down = minute % 10 === 0 ? ["signup"] : [];
    count += quiet.recordRun(run(T0 + minute * MINUTE, down), targets, policy, T0 + minute * MINUTE).opened.length;
  }
  assert.equal(count, 0, "one blip every ten minutes is not flapping");
});

void test("a repeated cron delivery of the same scheduled time is not a second consecutive failure", () => {
  const { store } = newStore();
  assert.deepEqual(store.recordRun(run(T0, ["signup"]), targets, policy, T0).opened, []);
  assert.deepEqual(store.recordRun(run(T0, ["signup"]), targets, policy, T0).opened, [], "the same tick again");
  assert.deepEqual(store.recordRun(run(T0 - MINUTE, ["signup"]), targets, policy, T0 - MINUTE).opened, [], "an older tick");
  assert.equal(store.getMeta("last_run_at"), String(T0), "last_run_at never moves backwards");
  assert.equal(store.component("signup").consecutiveFailures, 1);
  assert.equal(store.recordRun(run(T0 + MINUTE, ["signup"]), targets, policy, T0 + MINUTE).opened.length, 1, "the next real tick counts");
});

void test("an ack link of a contact removed from the policy no longer acknowledges, or even shows the confirm page", () => {
  const { store } = newStore();
  const id = openSignup(store);
  const trimmed: EscalationPolicy = {
    ...policy,
    tiers: policy.tiers.map((tier) => ({ ...tier, contacts: tier.contacts.filter((contact) => contact.id !== "vendor_support") }))
      .filter((tier) => tier.contacts.length > 0),
  };
  assert.equal(ackPageView(store, trimmed, id, "vendor_support"), null);
  assert.equal(acknowledgeByLink(store, trimmed, id, "vendor_support", T0 + 2 * MINUTE), "not_found");
  assert.equal(store.incident(id)?.acknowledgedAt, null, "paging continues");
  assert.equal(ackPageView(store, trimmed, id, "primary_oncall")?.acknowledged, false);
  assert.equal(acknowledgeByLink(store, trimmed, id, "primary_oncall", T0 + 2 * MINUTE), "acknowledged");
  // SMS: same rule; an unknown number gets no reply at all.
  const code = store.incident(id)?.ackCode ?? "";
  assert.deepEqual(acknowledgeBySms(store, trimmed, "+15555550102", `ACK ${code}`, T0 + 3 * MINUTE), { reply: null, changed: false });
  assert.deepEqual(acknowledgeBySms(store, trimmed, "+15555550100", `ACK ${code}`, T0 + 3 * MINUTE),
    { reply: "Already acknowledged by Primary On-call.", changed: false });
});

void test("/api/status reads no run history or logs and is cached; the failure list uses its partial index", () => {
  const storage = sqliteStorage();
  const { store } = newStore(storage);
  openSignup(store);
  // 35 days of all-ok history for 15 checks a minute: the case that made each status read walk ~756k rows.
  storage.db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 755999)
    INSERT INTO check_results (run_id, check_id, component_id, type, status, inconclusive, latency_ms, detail, observed_at)
    SELECT 1, 'c' || (i % 15), 'signup', 'http', 'ok', 0, 10, 'ok', ${String(T0)} - i * 4000 FROM n`);
  const plan = storage.db.prepare("EXPLAIN QUERY PLAN SELECT check_id FROM check_results WHERE status != 'ok' ORDER BY observed_at DESC LIMIT 50").all();
  assert.match(JSON.stringify(plan), /check_results_failures/);
  const started = process.hrtime.bigint();
  store.recentFailures();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 50, `recentFailures took ${elapsedMs.toFixed(1)} ms`);

  const seen: string[] = [];
  const spy: SqlLike = { exec: (query, ...bindings) => {
    seen.push(query);
    return storage.sql.exec(query, ...bindings);
  } };
  const watched = new MonitorStore({ sql: spy, transactionSync: (closure) => storage.transactionSync(closure) }, countingRandom());
  seen.length = 0;
  const loaded = { ok: true, config: monitorConfig } as const;
  publicSnapshot(watched, loaded, T0 + 2 * MINUTE);
  assert.ok(seen.length > 0);
  assert.deepEqual(seen.filter((query) => /check_results|check_latest|outbox|incident_events|\bruns\b/.test(query)), [],
    "the public path touches only meta, components, component_hourly and incidents");
  assert.ok(seen.some((query) => /FROM component_hourly/.test(query) && /latency_max/.test(query)), "the latency history comes from the rollups");
  const full = fullSnapshot(watched, loaded, T0 + 2 * MINUTE);
  assert.ok(full.notifications.length > 0, "the operator view still has everything");

  const cache = new TimedCache<number>(15_000);
  let builds = 0;
  const build = (): number => (builds += 1);
  cache.get(T0, build);
  cache.get(T0 + 14_999, build);
  assert.equal(builds, 1);
  cache.get(T0 + 15_000, build);
  assert.equal(builds, 2, "rebuilt after 15 s");
  cache.invalidate();
  cache.get(T0 + 15_001, build);
  assert.equal(builds, 3, "rebuilt at once after a state change");
});

void test("/api/status and /api/private give every component 30 days of uptime and 24 hours of latency, all null without runs", () => {
  const { store } = newStore();
  // Every component but the first reports (10 ms each); the first has no rollups at all.
  const silent = targets.components[0]?.id ?? "";
  store.recordRun(run(T0, []).filter((item) => item.componentId !== silent), targets, policy, T0);
  const loaded = { ok: true, config: monitorConfig } as const;
  const view = publicProjection(publicSnapshot(store, loaded, T0 + MINUTE));
  assert.ok(view.components.length > 1);
  for (const component of view.components) {
    assert.equal(component.history.length, 30, component.id);
    assert.equal(component.latency.length, 24, component.id);
    assert.equal(component.history[0]?.date, "2026-10-13");
    assert.equal(component.latency[0]?.hour, "2026-11-10T15:00:00.000Z");
    const reported = component.id !== silent;
    assert.deepEqual(component.history[29], { date: "2026-11-11", uptime: reported ? 100 : null });
    assert.deepEqual(component.latency[23], { hour: "2026-11-11T14:00:00.000Z", avgMs: reported ? 10 : null, maxMs: reported ? 10 : null });
    assert.ok(component.history.slice(0, 29).every((day) => day.uptime === null));
  }
  const full = privateProjection(fullSnapshot(store, loaded, T0 + MINUTE))["components"];
  assert.ok(Array.isArray(full) && full.length === targets.components.length);
  assert.deepEqual(full.map((component: unknown) => {
    const history: unknown = typeof component === "object" && component !== null ? Reflect.get(component, "history") : null;
    const latency: unknown = typeof component === "object" && component !== null ? Reflect.get(component, "latency") : null;
    return [Array.isArray(history) ? history.length : null, Array.isArray(latency) ? latency.length : null];
  }), targets.components.map(() => [30, 24]), "the operator view carries the same history");
});

void test("a version 1 database migrates: existing incidents become their own group and keep working", () => {
  const storage = sqliteStorage();
  storage.db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const statement of (MIGRATIONS[0] ?? "").split(";").map((part) => part.trim()).filter((part) => part !== "")) storage.db.exec(statement);
  storage.db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
  storage.db.exec(`INSERT INTO incidents (id, component_id, title, opened_at, ack_code, phase, escalation)
    VALUES ('inc_old', 'signup', 'Signup is down', ${String(T0)}, 'K7M2QX', 'acknowledged', '{}')`);
  storage.db.exec(`INSERT INTO components (id, status, consecutive_failures, consecutive_passes, open_incident_id)
    VALUES ('signup', 'down', 3, 0, 'inc_old')`);
  const { store } = newStore(storage);
  assert.equal(store.getMeta("schema_version"), String(MIGRATIONS.length));
  assert.equal(store.incident("inc_old")?.groupId, "inc_old");
  assert.equal(store.component("signup").recent, "");
  for (let minute = 1; minute <= 3; minute += 1) store.recordRun(run(T0 + minute * MINUTE, []), targets, policy, T0 + minute * MINUTE);
  assert.notEqual(store.incident("inc_old")?.resolvedAt, null);
});

void test("delivery context names the rest of the group, and a removed component's notice says so", async () => {
  const { store } = newStore();
  const id = openSignup(store);
  const without: TargetsConfig = { ...targets, components: targets.components.filter((item) => item.id !== "signup") };
  store.recordRun(run(T0 + 2 * MINUTE, [], without), without, policy, T0 + 2 * MINUTE);
  const resolvedRow = store.claimDue(T0 + 2 * MINUTE).find(({ row }) => row.kind === "resolved" && row.channel === "sms");
  assert.ok(resolvedRow !== undefined && resolvedRow.incident !== null);
  const context = await messageContext(resolvedRow.row, resolvedRow.incident, { config: monitorConfig, fetch, email: null, now: T0 + 2 * MINUTE }, ["forums"]);
  assert.deepEqual(context.alsoAffected, ["Forums"]);
  assert.match(
    smsText(context), /RESOLVED: Signup\. status\.example\.com\nClosed: no longer monitored \(removed from the configuration\)\. Still affected: Forums\./,
  );
  assert.equal(store.incident(id)?.closeReason, "component_removed");
});
