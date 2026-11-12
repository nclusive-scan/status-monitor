// Delivery hardening (hardening contract section 5) on the real store: Twilio status callbacks (out of order, unknown
// after 10 minutes), failover and early escalation, contact health from error codes and opt-out keywords, the account-
// level email alert by SMS, ESC and bare ACK, help replies and the per-contact reply limiter. The SMS composer is in
// sms-composer.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeBySms } from "../worker/ack-actions.ts";
import type { EscalationPolicy, MonitorConfig, TwilioSettings } from "../worker/config.ts";
import { deliver } from "../worker/deliver.ts";
import { contactProblemFor } from "../worker/delivery-health.ts";
import { parseInbound } from "../worker/inbound.ts";
import { createEmailSender } from "../worker/notify/email.ts";
import { channelNoticeSms, contactNoticeEmail } from "../worker/notify/messages.ts";
import { smsSize } from "../worker/notify/sms-text.ts";
import { CHANNEL_NOTICE_EVERY_MS, MonitorStore, REPLY_LIMIT, REPLY_WINDOW_MS } from "../worker/store.ts";
import type { OutboxRow } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { runtimeWarnings, storeSignals } from "../worker/warnings.ts";
import { countingRandom, examplePolicy, fixtureTargets, jsonResponse, MINUTE, scriptedFetch, sqliteStorage, T0 } from "./support/fakes.ts";

const targets = fixtureTargets();
const policy = examplePolicy();
const SID = (n: number): string => `SM${n.toString(16).padStart(32, "0")}`;

const run = (at: number, down: readonly string[]): CheckResult[] => targets.components.map((component) => ({
  checkId: `${component.id}_http`, componentId: component.id, type: "http", status: down.includes(component.id) ? "down" : "ok", inconclusive: false,
  latencyMs: 5, detail: "x", observedAt: at, data: null,
}));

function newStore(): MonitorStore {
  return new MonitorStore(sqliteStorage(), countingRandom());
}

/** Opens one signup incident under `using` and returns its id. */
function openSignup(store: MonitorStore, using: EscalationPolicy = policy, at = T0): string {
  store.recordRun(run(at, ["signup"]), targets, using, at);
  const id = store.recordRun(run(at + MINUTE, ["signup"]), targets, using, at + MINUTE).opened[0];
  if (id === undefined) throw new Error("no incident opened");
  return id;
}

/** Claims what is due and marks every row sent: SMS with a Twilio-like SID (numbered in claim order), email with a message id. */
function sendAll(store: MonitorStore, at: number, firstSid = 1): Map<string, string> {
  const sids = new Map<string, string>();
  let next = firstSid;
  for (const { row } of store.claimDue(at)) {
    const id = row.channel === "sms" ? SID(next++) : `cfemail:${row.key}`;
    store.markSent(row.key, id, at);
    sids.set(row.key, id);
  }
  return sids;
}

const rows = (store: MonitorStore): OutboxRow[] => store.notifications(500);
const byKey = (store: MonitorStore, key: string): OutboxRow | undefined => rows(store).find((row) => row.key === key);

void test("status callback: delivered is recorded; the first final status wins over late or out-of-order ones", () => {
  const store = newStore();
  const id = openSignup(store);
  const sids = sendAll(store, T0 + MINUTE);
  const smsKey = `${id}:page-c1-t0:primary_oncall:sms`;
  const sid = sids.get(smsKey) ?? "";
  store.recordProviderStatus(sid, "sent", null, T0 + MINUTE + 1000, policy);
  assert.equal(byKey(store, smsKey)?.deliveryStatus, "sent");
  store.recordProviderStatus(sid, "delivered", null, T0 + MINUTE + 2000, policy);
  store.recordProviderStatus(sid, "sent", null, T0 + MINUTE + 3000, policy);
  store.recordProviderStatus(sid, "undelivered", "twilio_30007", T0 + MINUTE + 4000, policy);
  const row = byKey(store, smsKey);
  assert.deepEqual([row?.status, row?.deliveryStatus, row?.deliveryCode], ["sent", "delivered", null], "late statuses change nothing");
  assert.deepEqual(store.incidentEvents(id).filter((event) => event.type === "delivered").map((event) => [event.contactId, event.channel]),
    [["primary_oncall", "sms"]]);
  assert.equal(store.recordProviderStatus(SID(999), "delivered", null, T0, policy), null, "an unknown SID is ignored");
});

void test("status callback: no final status within 10 minutes is 'unknown' (surfaced, no failover); a late final status still counts", () => {
  const store = newStore();
  const id = openSignup(store);
  const sids = sendAll(store, T0 + MINUTE);
  const smsKey = `${id}:page-c1-t0:primary_oncall:sms`;
  store.recordProviderStatus(sids.get(smsKey) ?? "", "sent", null, T0 + 2 * MINUTE, policy);
  assert.equal(store.markUnknownDeliveries(T0 + 10 * MINUTE), 0, "not yet 10 minutes");
  assert.equal(store.markUnknownDeliveries(T0 + 11 * MINUTE + 1), 1, "only the SMS: email has no status callback");
  const before = rows(store).length;
  assert.deepEqual([byKey(store, smsKey)?.deliveryStatus, byKey(store, smsKey)?.deliveryCode], ["unknown", "twilio_no_final_status"]);
  assert.equal(rows(store).length, before, "nothing failed over");
  assert.ok(runtimeWarnings(storeSignals(store, T0 + 12 * MINUTE), T0 + 12 * MINUTE).includes("sms_delivery_unknown"));
  store.recordProviderStatus(sids.get(smsKey) ?? "", "sent", null, T0 + 12 * MINUTE, policy);
  assert.equal(byKey(store, smsKey)?.deliveryStatus, "unknown", "a non-final status does not undo unknown");
  store.recordProviderStatus(sids.get(smsKey) ?? "", "delivered", null, T0 + 13 * MINUTE, policy);
  assert.equal(byKey(store, smsKey)?.deliveryStatus, "delivered");
  assert.equal(store.markUnknownDeliveries(T0 + 60 * MINUTE), 0);
});

void test("every channel of the paged tier failed (sync and callback): escalate at once, with the reason in the archived timeline", () => {
  const store = newStore();
  const id = openSignup(store);
  const claimed = store.claimDue(T0 + MINUTE);
  const sms = claimed.find(({ row }) => row.channel === "sms")?.row;
  const email = claimed.find(({ row }) => row.channel === "email")?.row;
  assert.ok(sms !== undefined && email !== undefined);
  store.markSent(sms.key, SID(1), T0 + MINUTE);
  store.markFailed(email.key, "email_recipient_suppressed", false, T0 + MINUTE, policy);
  assert.equal(store.incident(id)?.escalation?.tierIndex, 0, "one channel left: still waiting on the primary tier");
  assert.deepEqual(store.contactHealth().map((row) => [row.contactId, row.channel, row.state]), [["primary_oncall", "email", "suppressed"]]);
  // 30003: the handset is unreachable, a failure about the contact (a provider- or account-level code never escalates early).
  store.recordProviderStatus(SID(1), "undelivered", "twilio_30003", T0 + 2 * MINUTE, policy);
  const incident = store.incident(id);
  assert.equal(incident?.escalation?.tierIndex, 1, "secondary tier paged at minute 2, not at the 5-minute timeout");
  assert.equal(incident.nextAlarmAt, T0 + 2 * MINUTE + 10 * MINUTE, "the secondary tier's own timeout runs from now");
  const pages = rows(store).filter((row) => row.kind === "page" && row.status === "pending").map((row) => `${row.contactId}:${row.channel}`).sort();
  assert.deepEqual(pages, ["engineering_lead:email", "secondary_oncall:email", "secondary_oncall:sms"]);
  const escalated = store.incidentEvents(id).filter((event) => event.type === "escalated");
  assert.deepEqual(escalated.map((event) => [event.tierId, event.code]), [["secondary", "all_channels_failed"]]);
  assert.deepEqual(byKey(store, sms.key)?.status, "failed", "the callback marks the row failed");
  assert.equal(store.pagingHealth(T0 + 2 * MINUTE).failedPages, 2, "the heartbeat fail URL sees it");
  assert.deepEqual(store.deliveryCounts(id), { sent: 1, delivered: 0, failed: 2 });
  // A second, late failure of the same old step does not escalate again.
  store.recordProviderStatus(SID(1), "failed", "twilio_30007", T0 + 3 * MINUTE, policy);
  assert.equal(store.incident(id)?.escalation?.tierIndex, 1);
});

void test("early escalation: account- or provider-level failures never run through the tiers; paging is still in cycle 1 a minute later", () => {
  const store = newStore();
  const id = openSignup(store);
  // Bad Twilio credentials and a suspended Email Service account: every send fails at once, for everyone.
  for (let second = 0; second <= 60; second += 1) {
    const at = T0 + MINUTE + second * 1000;
    for (const { row } of store.claimDue(at)) store.markFailed(row.key, row.channel === "sms" ? "twilio_20003" : "email_account_suspended", false, at, policy);
  }
  const state = store.incident(id)?.escalation;
  assert.deepEqual([state?.phase, state?.cycle, state?.tierIndex], ["paging", 1, 0], "waits for the primary tier's deadline");
  assert.equal(store.incidentEvents(id).filter((event) => event.type === "escalated").length, 0);
  // The tier deadline still moves it on, one tier at a time.
  store.advanceDue(policy, T0 + 6 * MINUTE);
  assert.equal(store.incident(id)?.escalation?.tierIndex, 1);
});

void test("early escalation: contact-level failures escalate early within a cycle only; the next cycle and 'exhausted' wait for the deadline", () => {
  const store = newStore();
  const id = openSignup(store);
  /** A minute of every page failing for a contact reason (every number opted out, every address suppressed). */
  const burst = (from: number): void => {
    for (let second = 0; second <= 60; second += 1) {
      const at = from + second * 1000;
      for (const { row } of store.claimDue(at)) {
        const code = row.channel === "sms" ? "twilio_recipient_opted_out" : "email_recipient_suppressed";
        if (row.kind === "page") store.markFailed(row.key, code, false, at, policy);
        else store.markSent(row.key, row.channel === "sms" ? SID(second + 100) : `cfemail:${row.key}`, at);
      }
    }
  };
  let from = T0 + MINUTE;
  for (let cycle = 1; cycle <= policy.maxCycles; cycle += 1) {
    burst(from);
    const state = store.incident(id)?.escalation;
    assert.deepEqual([state?.phase, state?.cycle, state?.tierIndex], ["paging", cycle, policy.tiers.length - 1],
      `cycle ${String(cycle)}: up to its last tier at once, never into the next cycle on a burst of failures`);
    const deadline = store.incident(id)?.nextAlarmAt ?? 0;
    assert.ok(deadline > from + MINUTE, "waiting for the last tier's deadline");
    store.advanceDue(policy, deadline);
    from = deadline;
    if (cycle < policy.maxCycles) {
      assert.deepEqual([store.incident(id)?.escalation?.cycle, store.incident(id)?.escalation?.tierIndex], [cycle + 1, 0], "the next cycle at the deadline");
    }
  }
  assert.ok(store.incidentEvents(id).some((event) => event.code === "all_channels_failed" && event.detail.includes("waits for the tier's deadline")));
  assert.equal(store.incident(id)?.escalation?.phase, "exhausted", "at the last deadline, as usual");
});

void test("early escalation: a carrier blip (30003 for every text) cannot use up every cycle in minutes", () => {
  const store = newStore();
  const smsOnly: EscalationPolicy = {
    ...policy, tiers: policy.tiers.map((tier) => ({ ...tier, contacts: tier.contacts.map((contact) => ({ ...contact, email: null })) })),
  };
  const id = openSignup(store, smsOnly);
  let sid = 1000;
  for (let second = 0; second <= 10 * 60; second += 10) {
    const at = T0 + MINUTE + second * 1000;
    for (const { row } of store.claimDue(at)) {
      const provider = SID(sid++);
      store.markSent(row.key, provider, at, smsOnly);
      if (row.kind === "page") store.recordProviderStatus(provider, "undelivered", "twilio_30003", at + 1000, smsOnly);
    }
    store.advanceDue(smsOnly, at);
  }
  const state = store.incident(id)?.escalation;
  assert.deepEqual([state?.phase, state?.cycle], ["paging", 1], "ten minutes in, still in the first cycle, waiting for the last tier's deadline");
});

void test("carrier hand-over: a page waiting to retry goes with the escalation to the member that takes over, and still fails over", () => {
  const store = newStore();
  const signup = openSignup(store);
  const claimed = store.claimDue(T0 + MINUTE);
  const sms = claimed.find(({ row }) => row.channel === "sms")?.row;
  const email = claimed.find(({ row }) => row.channel === "email")?.row;
  assert.ok(sms !== undefined && email !== undefined);
  store.markFailed(email.key, "email_rejected", false, T0 + MINUTE, policy);
  store.markFailed(sms.key, "twilio_http_503", true, T0 + MINUTE, policy);
  assert.equal(byKey(store, sms.key)?.status, "pending", "in backoff");
  // Forums opens within the group window and joins signup's group; signup then recovers while forums stays down.
  store.recordRun(run(T0 + 2 * MINUTE, ["signup", "forums"]), targets, policy, T0 + 2 * MINUTE);
  const forums = store.recordRun(run(T0 + 3 * MINUTE, ["signup", "forums"]), targets, policy, T0 + 3 * MINUTE).opened[0] ?? "";
  assert.equal(store.incident(forums)?.groupId, signup);
  for (let minute = 4; minute <= 6; minute += 1) store.recordRun(run(T0 + minute * MINUTE, ["forums"]), targets, policy, T0 + minute * MINUTE);
  assert.notEqual(store.incident(signup)?.resolvedAt, null);
  assert.equal(store.incident(forums)?.phase, "paging", "forums carries the escalation");
  const moved = byKey(store, sms.key);
  assert.deepEqual([moved?.status, moved?.incidentId], ["pending", forums], "handed over, key unchanged, not cancelled");
  // The retry goes out for forums (its message names the outage still going on), and its final failure still fails over.
  const retry = store.claimDue(T0 + 7 * MINUTE).find(({ row }) => row.key === sms.key);
  assert.equal(retry?.incident?.id, forums);
  store.markSent(sms.key, SID(42), T0 + 7 * MINUTE, policy);
  store.recordProviderStatus(SID(42), "undelivered", "twilio_30003", T0 + 8 * MINUTE, policy);
  assert.equal(store.incident(forums)?.escalation?.tierIndex, 1, "every channel of the tier failed for a contact reason: escalated early");

  // A page already sent by the old carrier, failing after the hand-over, is judged by the group too.
  const other = newStore();
  other.recordRun(run(T0, ["signup"]), targets, policy, T0);
  const first = other.recordRun(run(T0 + MINUTE, ["signup", "forums"]), targets, policy, T0 + MINUTE).opened[0] ?? "";
  for (const { row } of other.claimDue(T0 + MINUTE)) {
    if (row.channel === "sms") other.markSent(row.key, SID(9), T0 + MINUTE, policy);
    else other.markFailed(row.key, "email_recipient_suppressed", false, T0 + MINUTE, policy);
  }
  const successor = other.recordRun(run(T0 + 2 * MINUTE, ["forums"]), targets, policy, T0 + 2 * MINUTE).opened[0] ?? "";
  for (let minute = 3; minute <= 4; minute += 1) other.recordRun(run(T0 + minute * MINUTE, ["forums"]), targets, policy, T0 + minute * MINUTE);
  assert.notEqual(other.incident(first)?.resolvedAt, null);
  assert.equal(other.incident(successor)?.escalation?.tierIndex, 0, "before the primary tier's deadline");
  other.recordProviderStatus(SID(9), "undelivered", "twilio_30003", T0 + 4 * MINUTE + 1000, policy);
  assert.equal(other.incident(successor)?.escalation?.tierIndex, 1, "the successor escalates early on the old carrier's failed page");
  assert.equal(other.pagingHealth(T0 + 4 * MINUTE + 2000).failedPages, 2,
    "the heartbeat fail URL sees both failed pages: they keep the old carrier's id, but the group still needs someone");
});

void test("status callback before markSent: the final status is kept and applied when the SID is recorded (failover, contact health)", () => {
  const store = newStore();
  const smsOnly: EscalationPolicy = {
    ...policy,
    tiers: policy.tiers.map((tier, index) => (index === 0 ? { ...tier, contacts: tier.contacts.map((contact) => ({ ...contact, email: null })) } : tier)),
  };
  const id = openSignup(store, smsOnly);
  const [claimed] = store.claimDue(T0 + MINUTE);
  assert.ok(claimed !== undefined);
  // Twilio's 21610 callback lands while the send still awaits the API response body.
  assert.equal(store.recordProviderStatus(SID(5), "failed", "twilio_21610", T0 + MINUTE + 200, policy), null, "no row has the SID yet");
  store.markSent(claimed.row.key, SID(5), T0 + MINUTE + 300, policy);
  const row = byKey(store, claimed.row.key);
  assert.deepEqual([row?.status, row?.deliveryStatus, row?.deliveryCode], ["failed", "failed", "twilio_21610"]);
  assert.equal(store.contactHealthState("primary_oncall", "sms"), "opted_out");
  assert.equal(byKey(store, `${id}:page-c1-t0:primary_oncall:email`)?.status, "pending", "failed over to email (policy now has it)");
  assert.equal(store.markUnknownDeliveries(T0 + 20 * MINUTE), 0, "never left to become unknown");
  // An unclaimed early status is pruned after an hour.
  store.recordProviderStatus(SID(6), "delivered", null, T0, policy);
  store.prune(T0 + 2 * 60 * MINUTE);
  store.markSent("nothing", SID(6), T0 + 2 * 60 * MINUTE);
  assert.equal(store.notifications(500).filter((item) => item.deliveryStatus === "delivered").length, 0);
});

void test("SMS channel: an account-level Twilio failure warns until an SMS is delivered, and emails the first tier at most hourly", () => {
  const store = newStore();
  const id = openSignup(store);
  const sms = store.claimDue(T0 + MINUTE).find(({ row }) => row.channel === "sms")?.row;
  assert.ok(sms !== undefined);
  store.markSent(sms.key, SID(1), T0 + MINUTE, policy);
  store.recordProviderStatus(SID(1), "undelivered", "twilio_30034", T0 + 2 * MINUTE, policy);
  assert.ok(runtimeWarnings(storeSignals(store, T0 + 2 * MINUTE), T0 + 2 * MINUTE).includes("sms_channel_failing:twilio_30034"));
  const notices = rows(store).filter((row) => row.kind === "channel_notice");
  assert.deepEqual(notices.map((row) => [row.contactId, row.channel, row.detail]), [["primary_oncall", "email", "twilio_30034"]]);
  assert.deepEqual(store.contactHealth(), [], "not the contact's fault");
  assert.equal(store.incident(id)?.escalation?.tierIndex, 0, "and no early escalation");
  // Another within the hour: no second notice.
  store.recordProviderStatus(SID(1), "failed", "twilio_30034", T0 + 3 * MINUTE, policy);
  assert.equal(rows(store).filter((row) => row.kind === "channel_notice").length, 1);
  // An SMS confirmed delivered (the next tier's page) clears the warning.
  store.advanceDue(policy, T0 + 6 * MINUTE);
  const later = store.claimDue(T0 + 6 * MINUTE).find(({ row }) => row.channel === "sms" && row.kind === "page");
  assert.ok(later !== undefined);
  store.markSent(later.row.key, SID(2), T0 + 6 * MINUTE, policy);
  store.recordProviderStatus(SID(2), "delivered", null, T0 + 7 * MINUTE, policy);
  assert.deepEqual(store.smsChannelProblems(), []);
});

void test("failover: a failed send goes to the contact's other channel when that step has not used it", () => {
  const store = newStore();
  // At open the primary contact has a mobile number only; the next revision adds an email address.
  const smsOnly: EscalationPolicy = {
    ...policy,
    tiers: policy.tiers.map((tier, index) => (index === 0 ? { ...tier, contacts: tier.contacts.map((contact) => ({ ...contact, email: null })) } : tier)),
  };
  const id = openSignup(store, smsOnly);
  sendAll(store, T0 + MINUTE);
  const failoverKey = `${id}:page-c1-t0:primary_oncall:email`;
  assert.equal(byKey(store, failoverKey), undefined);
  store.recordProviderStatus(SID(1), "failed", "twilio_30003", T0 + 2 * MINUTE, policy);
  const failover = byKey(store, failoverKey);
  assert.deepEqual([failover?.status, failover?.kind, failover?.recipient, failover?.tierId], ["pending", "page", "primary@example.com", "primary"]);
  assert.equal(store.incident(id)?.escalation?.tierIndex, 0, "the email is still on its way: no early escalation");
  assert.deepEqual(store.contactHealth(), [], "30003 (handset unreachable) says nothing about the number itself");
  // After an acknowledgement nothing fails over any more.
  const other = newStore();
  const second = openSignup(other, smsOnly);
  sendAll(other, T0 + MINUTE);
  other.acknowledge(second, { name: "Primary On-call", via: "sms", contactId: "primary_oncall" }, policy, T0 + 2 * MINUTE);
  other.recordProviderStatus(SID(1), "failed", "twilio_30003", T0 + 3 * MINUTE, policy);
  assert.equal(byKey(other, `${second}:page-c1-t0:primary_oncall:email`), undefined);
});

void test("contact health: a 21610 send failure is opted_out, tells the first tier and the contact by email; a delivered SMS clears it", () => {
  const store = newStore();
  const id = openSignup(store);
  const claimed = store.claimDue(T0 + MINUTE);
  const sms = claimed.find(({ row }) => row.channel === "sms")?.row;
  assert.ok(sms !== undefined);
  store.markFailed(sms.key, "twilio_recipient_opted_out", false, T0 + MINUTE, policy);
  assert.deepEqual(store.contactHealth().map((row) => [row.contactId, row.channel, row.state, row.code]),
    [["primary_oncall", "sms", "opted_out", "twilio_recipient_opted_out"]]);
  const notices = rows(store).filter((row) => row.kind === "contact_notice");
  assert.deepEqual(
    notices.map((row) => [row.contactId, row.channel, row.detail, row.about]), [["primary_oncall", "email", "opted_out:self", "Primary On-call"]],
    "the primary tier is just this contact: they get their own copy (how to undo it)",
  );
  // The same state again queues nothing new.
  store.markFailed(`${id}:page-c1-t0:primary_oncall:email`, "x", false, T0 + MINUTE, policy);
  store.setContactHealth("primary_oncall", "sms", "opted_out", "inbound_stop", T0 + 2 * MINUTE);
  assert.equal(rows(store).filter((row) => row.kind === "contact_notice").length, 1);
  // A later SMS that arrives proves the number works again.
  const later = newStore();
  later.setContactHealth("primary_oncall", "sms", "opted_out", "twilio_21610", T0);
  const second = openSignup(later);
  const sids = sendAll(later, T0 + MINUTE);
  later.recordProviderStatus(sids.get(`${second}:page-c1-t0:primary_oncall:sms`) ?? "", "delivered", null, T0 + 2 * MINUTE, policy);
  assert.deepEqual(later.contactHealth().map((row) => [row.state, row.code]), [["ok", "delivered"]]);
});

void test("error codes: which mean the contact, and on which channel", () => {
  assert.equal(contactProblemFor("sms", "twilio_recipient_opted_out"), "opted_out");
  assert.equal(contactProblemFor("sms", "twilio_21610"), "opted_out", "async, in a status callback (Messaging Service)");
  for (const code of ["twilio_invalid_number", "twilio_21211", "twilio_not_sms_capable", "twilio_21614", "twilio_region_not_enabled", "twilio_30006"]) {
    assert.equal(contactProblemFor("sms", code), "undeliverable", code);
  }
  for (const code of ["twilio_30007", "twilio_30034", "twilio_30032", "twilio_http_503"]) {
    assert.equal(contactProblemFor("sms", code), null, `${code}: the sender's problem`);
  }
  assert.equal(contactProblemFor("email", "email_recipient_suppressed"), "suppressed");
  assert.equal(contactProblemFor("sms", "email_recipient_suppressed"), null);
  assert.equal(contactProblemFor("email", "twilio_21610"), null);
});

void test("an account-level email failure texts the first tier at most hourly per code, and warns until an email goes out", () => {
  const store = newStore();
  openSignup(store);
  const email = store.claimDue(T0 + MINUTE).find(({ row }) => row.channel === "email")?.row;
  assert.ok(email !== undefined);
  store.markFailed(email.key, "email_daily_limit_exceeded", false, T0 + MINUTE, policy);
  const notices = (): OutboxRow[] => rows(store).filter((row) => row.kind === "channel_notice");
  assert.deepEqual(notices().map((row) => [row.contactId, row.channel, row.detail]), [["primary_oncall", "sms", "email_daily_limit_exceeded"]]);
  assert.deepEqual(store.contactHealth(), [], "not the recipient's fault");
  const warnings = (at: number): string[] => runtimeWarnings(storeSignals(store, at), at);
  assert.ok(warnings(T0 + 2 * MINUTE).includes("email_channel_failing:daily_limit_exceeded"));
  // Another email failing the same way within the hour sends no second text.
  store.queueContactNotice("secondary_oncall", "undeliverable", policy, T0 + 30 * MINUTE);
  const second = store.claimDue(T0 + 30 * MINUTE).find(({ row }) => row.kind === "contact_notice")?.row;
  assert.ok(second !== undefined);
  store.markFailed(second.key, "email_daily_limit_exceeded", false, T0 + 30 * MINUTE, policy);
  assert.equal(notices().length, 1);
  // A successful email clears the warning.
  store.queueContactNotice("secondary_oncall", "undeliverable", policy, T0 + 40 * MINUTE);
  const third = store.claimDue(T0 + 40 * MINUTE).find(({ row }) => row.kind === "contact_notice")?.row;
  assert.ok(third !== undefined);
  store.markSent(third.key, "cfemail:ok", T0 + 40 * MINUTE);
  assert.ok(!warnings(T0 + 41 * MINUTE).some((warning) => warning.startsWith("email_channel_failing")), "an email went out: the warning clears");
});

void test("the channel notice is sent again after an hour", () => {
  const store = newStore();
  openSignup(store);
  const failEmail = (at: number): void => {
    store.queueContactNotice("secondary_oncall", "undeliverable", policy, at);
    const row = store.claimDue(at).find((item) => item.row.kind === "contact_notice")?.row;
    if (row !== undefined) store.markFailed(row.key, "email_account_suspended", false, at, policy);
  };
  failEmail(T0 + 2 * MINUTE);
  failEmail(T0 + 30 * MINUTE);
  failEmail(T0 + 2 * MINUTE + CHANNEL_NOTICE_EVERY_MS);
  assert.equal(rows(store).filter((row) => row.kind === "channel_notice").length, 2);
});

const reply = (store: MonitorStore, from: string, body: string, at: number) => acknowledgeBySms(store, policy, from, body, at);
const PRIMARY = "+15555550100";

void test("inbound grammar: ACK <code>, bare ACK/A, ESC <code>, opt-out and opt-in words, malformed commands, everything else", () => {
  assert.deepEqual(parseInbound(" ack k7m2qx. "), { type: "ack", code: "K7M2QX" });
  assert.deepEqual(parseInbound("ACK"), { type: "ack_bare" });
  assert.deepEqual(parseInbound("a"), { type: "ack_bare" });
  assert.deepEqual(parseInbound("Esc K7M2QX"), { type: "esc", code: "K7M2QX" });
  assert.deepEqual(parseInbound("escalate k7m2qx!"), { type: "esc", code: "K7M2QX" });
  for (const word of ["STOP", "stop", "StopAll", "UNSUBSCRIBE", "cancel", "END", "quit", "REVOKE", "optout", " STOP. "]) {
    assert.deepEqual(parseInbound(word), { type: "opt_out" }, word);
  }
  for (const word of ["START", "unstop", "Yes"]) assert.deepEqual(parseInbound(word), { type: "opt_in" }, word);
  for (const text of ["ACK K7M2Q", "ACKK7M2QX", "ack 123456", "esc", "acknowledged"]) assert.deepEqual(parseInbound(text), { type: "malformed" }, text);
  for (const text of ["STOP PLEASE", "please stop", "OPT OUT", "thanks", "on it"]) assert.deepEqual(parseInbound(text), { type: "other" }, text);
});

void test("SMS: bare ACK acknowledges the one open incident that paged this contact; with two it asks for the code", () => {
  const store = newStore();
  const id = openSignup(store);
  assert.deepEqual(reply(store, PRIMARY, "ACK", T0 + 2 * MINUTE), { reply: null, changed: true });
  assert.equal(store.incident(id)?.acknowledgedBy, "Primary On-call");
  assert.deepEqual(reply(store, PRIMARY, "A", T0 + 3 * MINUTE), { reply: "Already acknowledged by Primary On-call.", changed: false });
  assert.deepEqual(reply(store, "+15555550101", "ACK", T0 + 3 * MINUTE), { reply: "Nothing is waiting for your acknowledgement.", changed: false },
    "the secondary contact was never paged");

  const two = newStore();
  openSignup(two);
  // A second, separate group: the first was acknowledged... no: opened after the group window, so it pages on its own.
  const later = T0 + 30 * MINUTE;
  two.recordRun(run(later, ["signup", "forums"]), targets, policy, later);
  two.recordRun(run(later + MINUTE, ["signup", "forums"]), targets, policy, later + MINUTE);
  const outcome = reply(two, PRIMARY, "ACK", later + 2 * MINUTE);
  assert.equal(outcome.changed, false);
  assert.match(outcome.reply ?? "", /^2 incidents are open\. Reply ACK followed by the 6-character code/);
});

void test("SMS: ESC <code> pages the next tier now and says who; ESC on an acknowledged incident or a drill does not", () => {
  const store = newStore();
  const id = openSignup(store);
  const code = store.incident(id)?.ackCode ?? "";
  assert.deepEqual(reply(store, PRIMARY, `ESC ${code}`, T0 + 2 * MINUTE), { reply: "Escalated: now paging Secondary on-call.", changed: true });
  const incident = store.incident(id);
  assert.equal(incident?.escalation?.tierIndex, 1);
  assert.deepEqual(store.incidentEvents(id).filter((event) => event.type === "escalated").map((event) => event.code), ["esc_requested"]);
  assert.deepEqual(reply(store, PRIMARY, "ESC ZZZZZZ", T0 + 3 * MINUTE), { reply: "No open incident has code ZZZZZZ.", changed: false });
  store.acknowledge(id, { name: "Secondary On-call", via: "sms", contactId: "secondary_oncall" }, policy, T0 + 4 * MINUTE);
  assert.deepEqual(
    reply(store, PRIMARY, `esc ${code.toLowerCase()}`, T0 + 5 * MINUTE), { reply: "Already acknowledged by Secondary On-call.", changed: false },
  );
  assert.equal(store.incident(id)?.escalation?.tierIndex, 1, "nothing moved");

  // From the last tier, ESC exhausts paging: everyone is told.
  const last = newStore();
  const lone: EscalationPolicy = { ...policy, maxCycles: 1, tiers: policy.tiers.slice(0, 1) };
  const only = openSignup(last, lone);
  const reached = acknowledgeBySms(last, lone, PRIMARY, `ESC ${last.incident(only)?.ackCode ?? ""}`, T0 + 2 * MINUTE);
  assert.deepEqual(reached, { reply: "Escalated: every tier has now been tried; everyone is being told.", changed: true });
  assert.equal(last.incident(only)?.phase, "exhausted");

  // A drill is never escalated; a bare ACK confirms it.
  const drills = newStore();
  const weekly: EscalationPolicy = { ...policy, drill: { enabled: true, weekday: 3, time: "09:00" } };
  const drill = drills.startDueDrill(weekly, T0) ?? "";
  const drillCode = drills.incident(drill)?.ackCode ?? "";
  assert.deepEqual(acknowledgeBySms(drills, weekly, PRIMARY, `ESC ${drillCode}`, T0 + MINUTE),
    { reply: `This is a test page. Reply ACK ${drillCode} to confirm it reached you.`, changed: false });
  assert.deepEqual(acknowledgeBySms(drills, weekly, PRIMARY, "ack", T0 + MINUTE), { reply: "Drill acknowledged: pages reach you. Thank you.", changed: true });
});

void test("SMS: STOP from a known contact records opted_out and tells the first tier, with no reply; START clears it; unknown numbers stay silent", () => {
  const store = newStore();
  assert.deepEqual(reply(store, "+15555550101", "STOP", T0), { reply: null, changed: true });
  assert.deepEqual(store.contactHealth().map((row) => [row.contactId, row.channel, row.state, row.code]),
    [["secondary_oncall", "sms", "opted_out", "inbound_stop"]]);
  const notices = rows(store).filter((row) => row.kind === "contact_notice").map((row) => [row.contactId, row.detail]).sort();
  assert.deepEqual(notices, [["primary_oncall", "opted_out"], ["secondary_oncall", "opted_out:self"]], "the first tier, and the contact's own email");
  assert.deepEqual(reply(store, "+15555550101", "stop", T0 + MINUTE), { reply: null, changed: false }, "already recorded");
  assert.deepEqual(reply(store, "+15555550101", "START", T0 + 2 * MINUTE), { reply: null, changed: true });
  assert.equal(store.contactHealth()[0]?.state, "ok");
  assert.deepEqual(reply(store, "+15555550199", "STOP", T0), { reply: null, changed: false });
  assert.deepEqual(reply(store, "+15555550199", "ACK K7M2QX", T0), { reply: null, changed: false });
  assert.equal(store.contactHealth().length, 1);
});

void test("SMS: malformed commands from a known contact get help (with the code when only one incident waits); replies are limited per contact", () => {
  const store = newStore();
  const id = openSignup(store);
  const code = store.incident(id)?.ackCode ?? "";
  assert.deepEqual(
    reply(store, PRIMARY, "ack k7m2", T0 + 2 * MINUTE), { reply: `Reply ACK ${code} to acknowledge, or ESC ${code} to escalate.`, changed: false },
  );
  assert.deepEqual(reply(store, "+15555550101", "ack", T0 + 2 * MINUTE).reply, "Nothing is waiting for your acknowledgement.");
  assert.deepEqual(reply(store, "+15555550101", "acknowledged", T0 + 2 * MINUTE).reply,
    "Reply ACK followed by the 6-character code from the page, or ESC and the code to escalate.");
  assert.deepEqual(reply(store, PRIMARY, "thanks, on it", T0 + 2 * MINUTE), { reply: null, changed: false }, "other text: no reply");
  // The primary contact has had 1 reply; REPLY_LIMIT in the window, then silence until the window has passed.
  for (let index = 1; index < REPLY_LIMIT; index += 1) assert.notEqual(reply(store, PRIMARY, "ack?", T0 + 2 * MINUTE + index).reply, null);
  assert.deepEqual(reply(store, PRIMARY, "ack?", T0 + 3 * MINUTE), { reply: null, changed: false });
  assert.notEqual(reply(store, PRIMARY, "ack?", T0 + 2 * MINUTE + REPLY_WINDOW_MS + 1000).reply, null);
  // A limited reply still lets the command act.
  const busy = newStore();
  const incident = openSignup(busy);
  for (let index = 0; index < REPLY_LIMIT; index += 1) busy.allowReply("primary_oncall", T0 + 2 * MINUTE);
  assert.deepEqual(reply(busy, PRIMARY, `ESC ${busy.incident(incident)?.ackCode ?? ""}`, T0 + 2 * MINUTE), { reply: null, changed: true });
  assert.equal(busy.incident(incident)?.escalation?.tierIndex, 1);
});

void test("notices: contact-health emails name the contact only; the channel alert SMS fits one segment", () => {
  const self = contactNoticeEmail("opted_out", "Primary On-call", true, "Acme");
  assert.match(self.text, /text START to the number that sends the alerts/);
  assert.equal(self.subject, "[Acme] Opted out of texts: Primary On-call");
  assert.match(contactNoticeEmail("opted_out", "Primary On-call", false, "Acme").text, /They get no SMS pages until they text START/);
  assert.match(contactNoticeEmail("suppressed", "Primary On-call", false, "Acme").text, /suppression list/);
  for (const problem of ["opted_out", "undeliverable", "suppressed"] as const) {
    assert.doesNotMatch(JSON.stringify(contactNoticeEmail(problem, "Primary On-call", false, "Acme")), /\+1555|@example\.com/);
  }
  const sms = channelNoticeSms("email_daily_limit_exceeded", "https://status.example.com", "Acme");
  assert.match(sms, /^\[Acme\] Alert email is failing \(email_daily_limit_exceeded\)\. status\.example\.com\nPages still go by SMS\./);
  assert.ok(smsSize(sms).segments <= 2);
});

// ---- Delivery routing ----

const twilio: TwilioSettings = {
  accountSid: `AC${"1".repeat(32)}`, username: `AC${"1".repeat(32)}`, password: "auth-token", authToken: "auth-token", authTokenSecondary: null,
  from: "+15555550123", messagingServiceSid: null,
};
const config: MonitorConfig = {
  brandName: "Acme", mode: "standalone", targets, policy, statusPageUrl: "https://status.example.com", twilioWebhookUrl: "https://status.example.com/hooks/twilio", healthKey: null,
  configKey: null, ackSigningKey: "a".repeat(40), twilio, email: { from: "alerts@example.com", fromName: "Acme Status" }, heartbeatUrl: null,
  heartbeatFailUrl: null, dnsSecondaryResolver: null, maintenance: [], deliveryMode: "live", source: { kind: "bootstrap" },
};

void test("delivery: Twilio is asked for status callbacks at STATUS_PAGE_URL/hooks/twilio-status; notices route by kind and channel", async () => {
  const store = newStore();
  const id = openSignup(store);
  const claimed = store.claimDue(T0 + MINUTE);
  const sms = claimed.find(({ row }) => row.channel === "sms");
  assert.ok(sms !== undefined);
  const { fetch, calls } = scriptedFetch(() => jsonResponse({ sid: SID(7) }, 201));
  assert.deepEqual(await deliver(sms.row, sms.incident, { config, fetch, email: null, now: T0 + MINUTE }), { ok: true, providerId: SID(7) });
  const form = new URLSearchParams(typeof calls[0]?.init?.body === "string" ? calls[0].init.body : "");
  assert.equal(form.get("StatusCallback"), "https://status.example.com/hooks/twilio-status");
  assert.equal(form.get("ValidityPeriod"), "600");
  assert.match(form.get("Body") ?? "", /^\[Acme\] DOWN: Signup\. Reply ACK [2-9A-Z]{6} to acknowledge\. status\.example\.com\n/);
  assert.ok(id !== "");

  store.setContactHealth("secondary_oncall", "sms", "opted_out", "inbound_stop", T0);
  store.queueContactNotice("secondary_oncall", "opted_out", policy, T0 + 2 * MINUTE);
  const sent: { to: string; subject: string; text: string }[] = [];
  const email = createEmailSender({
    send: (message) => {
      sent.push(message);
      return Promise.resolve({ messageId: "m" });
    },
  }, config.email ?? { from: "", fromName: "" });
  for (const { row, incident } of store.claimDue(T0 + 2 * MINUTE).filter((item) => item.row.kind === "contact_notice")) {
    assert.equal((await deliver(row, incident, { config, fetch, email, now: T0 + 2 * MINUTE })).ok, true);
  }
  assert.deepEqual(sent.map((message) => [message.to, message.subject]).sort(), [
    ["primary@example.com", "[Acme] Opted out of texts: Secondary On-call"], ["secondary@example.com", "[Acme] Opted out of texts: Secondary On-call"],
  ]);
  const channelRow: OutboxRow = {
    ...sms.row, key: "chn_x:channel_notice:primary_oncall:sms", incidentId: "chn_x", kind: "channel_notice", detail: "email_account_suspended",
  };
  assert.equal((await deliver(channelRow, null, { config, fetch, email, now: T0 })).ok, true);
  const noticeBody = new URLSearchParams(typeof calls[1]?.init?.body === "string" ? calls[1].init.body : "").get("Body") ?? "";
  assert.match(noticeBody, /Alert email is failing \(email_account_suspended\)/);
  // Alert SMS failing account-wide: the first tier hears of it by email.
  assert.equal((await deliver({ ...channelRow, channel: "email", recipient: "primary@example.com", detail: "twilio_30034" }, null,
    { config, fetch, email, now: T0 })).ok, true);
  assert.deepEqual([sent.at(-1)?.to, sent.at(-1)?.subject], ["primary@example.com", "[Acme] Alert texts are failing"]);
  assert.match(sent.at(-1)?.text ?? "", /Alert texts are failing for every contact \(twilio_30034\)/);
  assert.deepEqual(
    await deliver({ ...channelRow, detail: null }, null, { config, fetch, email, now: T0 }), { ok: false, retryable: false, code: "notice_invalid" },
  );
});
