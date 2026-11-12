// A component's alert setting changed while its incident is open (store changeAlertMode): the incident follows the new
// setting at the next run instead of keeping the mode it opened with for the rest of the outage. And an email-only
// alert never leads to an SMS, not even the channel notice about account-wide email failure.
import assert from "node:assert/strict";
import test from "node:test";
import type { AlertMode, EscalationPolicy, TargetsConfig } from "../worker/config.ts";
import { parsePolicy, parseTargets } from "../worker/config.ts";
import type { OutboxRow } from "../worker/store.ts";
import { MonitorStore } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { countingRandom, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

/** Two paging-capable components; `modes` sets each one's alert setting for a run. */
function targetsWith(modes: Readonly<Record<string, AlertMode>>): TargetsConfig {
  const ids = Object.keys(modes);
  const targets = parseTargets({
    version: 1,
    components: ids.map((id) => ({ id, name: id.toUpperCase(), alert: modes[id], public: true })),
    checks: ids.map((id) => ({ id: `${id}_http`, component: id, type: "http", url: `https://${id}.example.test/` })),
  });
  if (targets === null) throw new Error("targets invalid");
  return targets;
}

const policy: EscalationPolicy = (() => {
  const parsed = parsePolicy({
    version: 1, maxCycles: 2, reminderMinutes: 15, tiers: [
      { id: "primary", name: "Primary", ackTimeoutMinutes: 5, contacts: [{ id: "first", name: "First", sms: "+15555550100", email: "first@example.com" }] },
      { id: "secondary", name: "Secondary", ackTimeoutMinutes: 5, contacts: [{ id: "second", name: "Second", sms: "+15555550110" }] },
    ],
  });
  if (parsed === null) throw new Error("policy invalid");
  return parsed;
})();

const result = (componentId: string, down: boolean, at: number): CheckResult => ({
  checkId: `${componentId}_http`, componentId, type: "http", status: down ? "down" : "ok", inconclusive: false, latencyMs: 10,
  detail: down ? "status_503" : "ok", observedAt: at, data: null,
});

/** One run at `at`: the components in `down` fail, every other one passes; then every due row is "sent". */
function tick(store: MonitorStore, at: number, targets: TargetsConfig, down: readonly string[]): string[] {
  const opened = store.recordRun(targets.components.map((item) => result(item.id, down.includes(item.id), at)), targets, policy, at).opened;
  for (const claimed of store.claimDue(at, 100)) store.markSent(claimed.row.key, `log:${claimed.row.channel}`, at, policy);
  return opened;
}

/** Runs every minute in [from, to]. */
function ticks(store: MonitorStore, from: number, to: number, targets: TargetsConfig, down: readonly string[]): void {
  for (let at = from; at <= to; at += MINUTE) tick(store, at, targets, down);
}

const newStore = (): MonitorStore => new MonitorStore(sqliteStorage(), countingRandom());
const rowsOf = (store: MonitorStore, id: string): OutboxRow[] => store.notifications(1000).filter((row) => row.incidentId === id);
const sentAfter = (store: MonitorStore, at: number): OutboxRow[] => store.notifications(1000).filter((row) => row.createdAt >= at);

void test("email to page while down: the incident starts paging at once and escalates, with an ACK code", () => {
  const store = newStore();
  const email = targetsWith({ web: "email" }), page = targetsWith({ web: "page" });
  tick(store, T0, email, ["web"]);
  const [id] = tick(store, T0 + MINUTE, email, ["web"]);
  assert.ok(id !== undefined);
  ticks(store, T0 + 2 * MINUTE, T0 + 10 * MINUTE, email, ["web"]);
  assert.deepEqual(rowsOf(store, id).map((row) => row.kind), ["email_alert"], "email only while the component alerts by email");

  const switched = T0 + 11 * MINUTE;
  tick(store, switched, page, ["web"]);
  const incident = store.incident(id);
  assert.deepEqual([incident?.alertMode, incident?.phase, incident?.groupId, incident?.ackCode.length], ["page", "paging", id, 6]);
  assert.ok(incident?.nextAlarmAt !== null && incident?.escalation !== null, "an escalation with a deadline");
  assert.deepEqual(sentAfter(store, switched).map((row) => [row.kind, row.contactId, row.channel, row.status]).sort(), [
    ["page", "first", "email", "sent"], ["page", "first", "sms", "sent"],
  ], "the first tier is paged by SMS and email");
  ticks(store, switched + MINUTE, switched + 6 * MINUTE, page, ["web"]);
  assert.ok(rowsOf(store, id).some((row) => row.kind === "page" && row.contactId === "second" && row.channel === "sms"), "and it escalates");
  assert.ok(store.incidentEvents(id).some((event) => event.type === "alert_mode" && event.code === "alert_page"), "the change is logged");

  const recover = switched + 7 * MINUTE;
  ticks(store, recover, recover + 3 * MINUTE, page, []);
  assert.ok(store.incident(id)?.resolvedAt !== null);
  assert.ok(rowsOf(store, id).some((row) => row.kind === "resolved" && row.channel === "sms"), "the people paged hear it resolved");
});

void test("page to email while down: paging stops (pending pages cancelled, no SMS after), the first tier gets the email pair", () => {
  const store = newStore();
  const page = targetsWith({ web: "page" }), email = targetsWith({ web: "email" });
  tick(store, T0, page, ["web"]);
  const [id] = store.recordRun([result("web", true, T0 + MINUTE)], page, policy, T0 + MINUTE).opened;
  assert.ok(id !== undefined);
  assert.ok(rowsOf(store, id).some((row) => row.kind === "page" && row.status === "pending"), "pages queued, not yet sent");

  const switched = T0 + 2 * MINUTE;
  tick(store, switched, email, ["web"]);
  const incident = store.incident(id);
  assert.deepEqual([incident?.alertMode, incident?.phase, incident?.ackCode, incident?.escalation, incident?.nextAlarmAt, incident?.groupId],
    ["email", "email_only", "", null, null, id]);
  assert.ok(rowsOf(store, id).filter((row) => row.kind === "page").every((row) => row.status === "cancelled"), "the unsent pages are cancelled");
  assert.deepEqual(sentAfter(store, switched).map((row) => [row.kind, row.contactId, row.channel]), [["email_alert", "first", "email"]]);

  // Hours later: no SMS, no escalation, no reminder.
  ticks(store, switched + MINUTE, switched + 120 * MINUTE, email, ["web"]);
  assert.deepEqual(sentAfter(store, switched).map((row) => row.kind), ["email_alert"]);
  assert.deepEqual(store.pagingHealth(switched + 120 * MINUTE), { failedPages: 0, oldestPendingMs: null });
  const recover = switched + 121 * MINUTE;
  ticks(store, recover, recover + 3 * MINUTE, email, []);
  assert.deepEqual(sentAfter(store, switched).map((row) => [row.kind, row.status]).sort(), [["email_alert", "sent"], ["email_alert_resolved", "sent"]]);
});

void test("page to email for a group's carrier: the page member carries the escalation on; the switched incident leaves the group", () => {
  const store = newStore();
  const page = targetsWith({ web: "page", api: "page" }), webEmail = targetsWith({ web: "email", api: "page" });
  tick(store, T0, page, ["web"]);
  const [carrier] = tick(store, T0 + MINUTE, page, ["web"]);
  tick(store, T0 + 2 * MINUTE, page, ["web", "api"]);
  const [member] = tick(store, T0 + 3 * MINUTE, page, ["web", "api"]);
  assert.ok(carrier !== undefined && member !== undefined);
  assert.equal(store.incident(member)?.groupId, carrier);

  tick(store, T0 + 4 * MINUTE, webEmail, ["web", "api"]);
  const successor = store.incident(member);
  assert.ok(successor?.phase === "paging" && successor.escalation?.incidentId === member, "the member carries the escalation");
  assert.deepEqual([store.incident(carrier)?.groupId, store.incident(carrier)?.phase], [carrier, "email_only"]);
  assert.deepEqual(store.alsoAffected(successor), [], "the email-only incident is no longer part of the page");
  ticks(store, T0 + 5 * MINUTE, T0 + 10 * MINUTE, webEmail, ["web", "api"]);
  assert.ok(rowsOf(store, member).some((row) => row.kind === "page" && row.contactId === "second"), "paging goes on for the group");
});

void test("page to none: nothing more is sent; page to email and back to page pages again", () => {
  const store = newStore();
  const page = targetsWith({ web: "page" }), none = targetsWith({ web: "none" }), email = targetsWith({ web: "email" });
  tick(store, T0, page, ["web"]);
  const [id] = tick(store, T0 + MINUTE, page, ["web"]);
  assert.ok(id !== undefined);
  tick(store, T0 + 2 * MINUTE, none, ["web"]);
  ticks(store, T0 + 3 * MINUTE, T0 + 60 * MINUTE, none, ["web"]);
  assert.deepEqual(sentAfter(store, T0 + 2 * MINUTE), [], "nothing after the switch to none");
  assert.deepEqual([store.incident(id)?.alertMode, store.incident(id)?.phase], ["none", "no_alert"]);

  tick(store, T0 + 61 * MINUTE, email, ["web"]);
  const repaged = T0 + 62 * MINUTE;
  tick(store, repaged, page, ["web"]);
  assert.deepEqual(sentAfter(store, repaged).filter((row) => row.kind === "page").map((row) => [row.contactId, row.channel, row.status]).sort(), [
    ["first", "email", "sent"], ["first", "sms", "sent"],
  ], "paging again is not dropped as a repeat of the first escalation's sends");
});

void test("a page in flight when its component stopped paging fails without failing over", () => {
  const store = newStore();
  const page = targetsWith({ web: "page" }), email = targetsWith({ web: "email" });
  tick(store, T0, page, ["web"]);
  const [id] = store.recordRun([result("web", true, T0 + MINUTE)], page, policy, T0 + MINUTE).opened;
  assert.ok(id !== undefined);
  const inFlight = store.claimDue(T0 + MINUTE, 100).find((claimed) => claimed.row.channel === "sms");
  assert.ok(inFlight !== undefined);
  store.recordRun([result("web", true, T0 + 2 * MINUTE)], email, policy, T0 + 2 * MINUTE);
  store.markFailed(inFlight.row.key, "twilio_21211", false, T0 + 2 * MINUTE, policy);
  ticks(store, T0 + 2 * MINUTE, T0 + 30 * MINUTE, email, ["web"]);
  assert.deepEqual(sentAfter(store, T0 + 2 * MINUTE).map((row) => row.kind), ["email_alert"], "no failover page, no escalation");
});

void test("an email-only alert failing account-wide records the problem but texts nobody; a paging email still does", () => {
  const store = newStore();
  const email = targetsWith({ staging: "email", prod: "page" });
  tick(store, T0, email, ["staging"]);
  const [id] = store.recordRun([result("staging", true, T0 + MINUTE), result("prod", false, T0 + MINUTE)], email, policy, T0 + MINUTE).opened;
  assert.ok(id !== undefined);
  for (const claimed of store.claimDue(T0 + MINUTE, 100)) store.markFailed(claimed.row.key, "email_account_suspended", false, T0 + MINUTE, policy);
  assert.deepEqual(store.emailChannelProblems(), ["email_account_suspended"], "recorded for the email_channel_failing warning");
  assert.deepEqual(store.notifications(1000).filter((row) => row.channel === "sms"), [], "no channel notice by SMS");

  // Production's page email failing the same way still warns the first tier by SMS.
  store.recordRun([result("staging", true, T0 + 2 * MINUTE), result("prod", true, T0 + 2 * MINUTE)], email, policy, T0 + 2 * MINUTE);
  store.recordRun([result("staging", true, T0 + 3 * MINUTE), result("prod", true, T0 + 3 * MINUTE)], email, policy, T0 + 3 * MINUTE);
  const pageEmail = store.claimDue(T0 + 3 * MINUTE, 100).find((claimed) => claimed.row.kind === "page" && claimed.row.channel === "email");
  assert.ok(pageEmail !== undefined);
  store.markFailed(pageEmail.row.key, "email_account_suspended", false, T0 + 3 * MINUTE, policy);
  assert.deepEqual(store.notifications(1000).filter((row) => row.kind === "channel_notice").map((row) => [row.contactId, row.channel]), [["first", "sms"]]);
});
