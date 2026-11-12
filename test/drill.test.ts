// Local time and the weekly drill: zone arithmetic across the US DST changes (2026-11-01 and 2027-03-14), the drill
// schedule computed in code from policy.timeZone, the rotation, and the drill's life in the store: paged to one
// contact, acknowledged by SMS or link, or missed (contact health drill_missed and an email to the first tier).
import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeBySms } from "../worker/ack-actions.ts";
import type { EscalationPolicy } from "../worker/config.ts";
import { parsePolicy } from "../worker/config.ts";
import { deliver } from "../worker/deliver.ts";
import { dueDrillSlot, DRILL_GRACE_MS, latestDrillSlot, nextDrillContact, nextDrillSlot } from "../worker/drill.ts";
import { MonitorStore } from "../worker/store.ts";
import { formatAlertTime, isTimeZone, localToUtc, offsetMs } from "../worker/time.ts";
import type { CheckResult } from "../worker/types.ts";
import { countingRandom, examplePolicy, fixtureTargets, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

const NY = "America/New_York";
const HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const utc = (iso: string): number => Date.parse(iso);

void test("time: offsets and wall times across both US transitions", () => {
  assert.equal(offsetMs(NY, utc("2026-10-31T12:00:00Z")), -4 * HOUR);
  assert.equal(offsetMs(NY, utc("2026-11-02T12:00:00Z")), -5 * HOUR);
  assert.equal(localToUtc(NY, 2026, 11, 1, 1, 30), utc("2026-11-01T05:30:00Z"), "the repeated hour resolves to its first occurrence (EDT)");
  assert.equal(localToUtc(NY, 2026, 11, 1, 3, 0), utc("2026-11-01T08:00:00Z"));
  assert.equal(localToUtc(NY, 2027, 3, 14, 2, 30), utc("2027-03-14T07:30:00Z"), "the skipped hour moves forward: 03:30 EDT");
  assert.equal(localToUtc(NY, 2027, 3, 14, 10, 0), utc("2027-03-14T14:00:00Z"));
  assert.equal(localToUtc("UTC", 2027, 3, 14, 10, 0), utc("2027-03-14T10:00:00Z"));
  assert.ok(isTimeZone(NY) && isTimeZone("UTC") && !isTimeZone("Mars/Olympus") && !isTimeZone(""));
});

void test("time: alert times read local first, then UTC", () => {
  assert.equal(formatAlertTime(utc("2026-11-11T08:12:00Z"), NY), "03:12 EST (08:12 UTC)");
  assert.equal(formatAlertTime(utc("2026-07-01T08:12:00Z"), NY), "04:12 EDT (08:12 UTC)");
  assert.equal(formatAlertTime(utc("2026-11-11T08:12:00Z"), "UTC"), "08:12 UTC");
});

void test("drill schedule: Sunday 10:00 New York stays at 10:00 local through both DST changes (never a fixed UTC cron)", () => {
  const sunday = { enabled: true, weekday: 7, time: "10:00" };
  assert.equal(nextDrillSlot(sunday, NY, utc("2026-10-25T14:00:00Z")), utc("2026-11-01T15:00:00Z"), "after fall-back: 15:00 UTC, an hour later in UTC");
  assert.equal(nextDrillSlot(sunday, NY, utc("2026-11-01T15:00:00Z")), utc("2026-11-08T15:00:00Z"));
  assert.equal(nextDrillSlot(sunday, NY, utc("2027-03-07T15:00:00Z")), utc("2027-03-14T14:00:00Z"), "after spring-forward: 14:00 UTC");
  assert.equal(latestDrillSlot(sunday, NY, utc("2027-03-14T13:59:00Z")), utc("2027-03-07T15:00:00Z"));
  assert.equal(latestDrillSlot(sunday, NY, utc("2027-03-14T14:00:00Z")), utc("2027-03-14T14:00:00Z"));
  const early = { enabled: true, weekday: 7, time: "02:30" };
  assert.equal(nextDrillSlot(early, NY, utc("2027-03-10T00:00:00Z")), utc("2027-03-14T07:30:00Z"), "a skipped local time runs right after the gap");
  assert.equal(nextDrillSlot(early, NY, utc("2026-10-28T00:00:00Z")), utc("2026-11-01T07:30:00Z"), "02:30 EST on the fall-back day");
  // Wednesday 2026-11-11 (T0 is 09:00 EST) with a Monday drill: the previous Monday.
  assert.equal(latestDrillSlot({ enabled: true, weekday: 1, time: "09:00" }, NY, T0), utc("2026-11-09T14:00:00Z"));
});

const drillPolicyAt = (drill: { enabled: boolean; weekday: number; time: string }, timeZone = NY): EscalationPolicy => {
  const parsed = parsePolicy({ ...examplePolicy(), timeZone, drill });
  if (parsed === null) throw new Error("drill policy invalid");
  return parsed;
};

void test("drill schedule: due once per slot, within the grace only, never when disabled", () => {
  const policy = drillPolicyAt({ enabled: true, weekday: 3, time: "09:00" });
  assert.equal(dueDrillSlot(policy, null, T0), T0, "T0 is Wednesday 09:00 New York");
  assert.equal(dueDrillSlot(policy, T0, T0 + MINUTE), null, "already run");
  assert.equal(dueDrillSlot(policy, null, T0 + DRILL_GRACE_MS + 1), null, "missed by more than the grace: skipped, not run late");
  assert.equal(dueDrillSlot(policy, T0, T0 + 7 * DAY), T0 + 7 * DAY);
  assert.equal(dueDrillSlot(drillPolicyAt({ enabled: false, weekday: 3, time: "09:00" }), null, T0), null);
});

void test("drill schedule: moving the time or weekday later in a week whose drill already ran waits for next week", () => {
  // The Wednesday 09:00 drill ran at T0. Moved to 09:30 the same day, or to Friday: still one drill this week.
  const later = drillPolicyAt({ enabled: true, weekday: 3, time: "09:30" });
  assert.equal(dueDrillSlot(later, T0, T0 + 31 * MINUTE), null, "same day, later time");
  const friday = drillPolicyAt({ enabled: true, weekday: 5, time: "09:00" });
  assert.equal(dueDrillSlot(friday, T0, T0 + 2 * DAY + MINUTE), null, "same week, later weekday");
  // Sunday ends the ISO week; Monday starts a new one, in the policy's zone.
  const sunday = drillPolicyAt({ enabled: true, weekday: 7, time: "09:00" });
  assert.equal(dueDrillSlot(sunday, T0, T0 + 4 * DAY + MINUTE), null, "Sunday is still the same ISO week");
  assert.equal(dueDrillSlot(later, T0, T0 + 7 * DAY + 31 * MINUTE), T0 + 7 * DAY + 30 * MINUTE, "next week at the new time");
  assert.equal(dueDrillSlot(friday, T0, T0 + 9 * DAY + MINUTE), T0 + 9 * DAY, "next week on the new day");
  // Moving it earlier in the week never skips a week: Monday of next week is a new week.
  const monday = drillPolicyAt({ enabled: true, weekday: 1, time: "09:00" });
  assert.equal(dueDrillSlot(monday, T0, T0 + 5 * DAY + MINUTE), T0 + 5 * DAY);
});

void test("drill rotation: every contact in tier order, then round again; an unknown last contact restarts", () => {
  const policy = examplePolicy();
  const order: string[] = [];
  let last: string | null = null;
  for (let index = 0; index < 5; index += 1) {
    last = nextDrillContact(policy, last)?.contact.id ?? null;
    order.push(last ?? "");
  }
  assert.deepEqual(order, ["primary_oncall", "secondary_oncall", "engineering_lead", "vendor_support", "primary_oncall"]);
  assert.equal(nextDrillContact(policy, "removed_person")?.contact.id, "primary_oncall");
  assert.equal(nextDrillContact(policy, "engineering_lead")?.tier.id, "third_party");
});

function newStore() {
  return new MonitorStore(sqliteStorage(), countingRandom());
}
const WED_9 = drillPolicyAt({ enabled: true, weekday: 3, time: "09:00" });

void test("drill: one [TEST] page to one contact, invisible on the status page, then acknowledged by SMS with a reply", async () => {
  const store = newStore();
  const id = store.startDueDrill(WED_9, T0) ?? "";
  assert.match(id, /^drl_/);
  assert.equal(store.startDueDrill(WED_9, T0 + MINUTE), null, "once per slot");
  const rows = store.notifications();
  assert.deepEqual(rows.map((row) => [row.kind, row.contactId, row.channel]).sort(), [["page", "primary_oncall", "email"], ["page", "primary_oncall", "sms"]]);
  assert.deepEqual(store.incidents(T0), [], "drills never show on the status page");
  const drill = store.incident(id);
  assert.ok(drill?.drill === true && drill.nextAlarmAt === T0 + 5 * MINUTE, "acknowledged within the contact's own tier timeout");

  const claimed = store.claimDue(T0);
  const sms = claimed.find(({ row }) => row.channel === "sms");
  assert.ok(sms !== undefined && sms.incident !== null);
  const fetch = (): Promise<Response> => Promise.reject(new Error("no network in tests"));
  const config = {
    brandName: "Acme", mode: "standalone" as const, targets: fixtureTargets(), policy: WED_9, maintenance: [], statusPageUrl: "https://status.example.com",
    twilioWebhookUrl: "https://status.example.com/hooks/twilio",
    healthKey: null, configKey: null, ackSigningKey: "a".repeat(40), twilio: null, email: null, heartbeatUrl: null, heartbeatFailUrl: null,
    dnsSecondaryResolver: null, deliveryMode: "log" as const, source: { kind: "bootstrap" as const },
  };
  const texts: string[] = [];
  const sender = { send: (message: { body: string }) => {
    texts.push(message.body);
    return Promise.resolve({ ok: true as const, providerId: "SM1" });
  } };
  await deliver(sms.row, sms.incident, { config: { ...config, deliveryMode: "live" }, fetch, email: null, sms: sender, now: T0 });
  assert.match(
    texts[0] ?? "", /^\[Acme\] \[TEST\] Weekly paging drill\. Reply ACK [2-9A-Z]{6} to confirm pages reach you\. status\.example\.com\nNothing is down\.$/,
  );

  const reply = acknowledgeBySms(store, WED_9, "+15555550100", `ACK ${drill.ackCode}`, T0 + 2 * MINUTE);
  assert.deepEqual(reply, { reply: "Drill acknowledged: pages reach you. Thank you.", changed: true });
  const done = store.incident(id);
  assert.deepEqual([done?.closeReason, done?.acknowledgedContact, done?.acknowledgedVia, done?.resolvedAt], ["drill_acknowledged", "primary_oncall", "sms",
    T0 + 2 * MINUTE]);
  assert.equal(store.notifications().filter((row) => row.status === "pending" && row.kind === "page").length, 0, "pending pages cancelled");
  assert.deepEqual(store.unexportedIncidents().map((incident) => incident.id), [id], "the drill goes to the platform's archive");
});

void test("drill: a miss marks the contact drill_missed and emails the first tier; the next drill rotates; an answered drill clears it", () => {
  const store = newStore();
  const id = store.startDueDrill(WED_9, T0) ?? "";
  store.advanceDue(WED_9, T0 + 5 * MINUTE);
  const missed = store.incident(id);
  assert.equal(missed?.closeReason, "drill_missed");
  assert.deepEqual(store.contactHealth().map((row) => [row.contactId, row.channel, row.state]), [
    ["primary_oncall", "email", "drill_missed"], ["primary_oncall", "sms", "drill_missed"],
  ]);
  const notices = store.notifications().filter((row) => row.kind === "drill_missed");
  assert.deepEqual(notices.map((row) => [row.recipient, row.channel, row.detail]), [["primary@example.com", "email", "Primary On-call"]]);
  assert.equal(store.reportDue(T0 + 5 * MINUTE, Number.MAX_SAFE_INTEGER), true, "contact health changed: report at the next run");

  const next = store.startDueDrill(WED_9, T0 + 7 * DAY) ?? "";
  assert.equal(store.incident(next)?.escalation?.paged[0], "secondary_oncall", "rotates to the next contact");
  assert.equal(store.incident(next)?.nextAlarmAt, T0 + 7 * DAY + 10 * MINUTE, "the secondary tier's timeout");
  store.acknowledge(next, { name: "Secondary On-call", via: "email", contactId: "secondary_oncall" }, WED_9, T0 + 7 * DAY + MINUTE);

  store.setMeta("drill_last_contact", "vendor_support");
  const again = store.startDueDrill(WED_9, T0 + 14 * DAY) ?? "";
  assert.equal(store.incident(again)?.escalation?.paged[0], "primary_oncall");
  store.acknowledge(again, { name: "Primary On-call", via: "email", contactId: "primary_oncall" }, WED_9, T0 + 14 * DAY + MINUTE);
  assert.ok(store.contactHealth().every((row) => row.state === "ok"), "answering a later drill clears drill_missed");
});

void test("drill: a miss never overwrites a delivery problem, and a later answered drill leaves that problem in place", () => {
  const store = newStore();
  store.setContactHealth("primary_oncall", "sms", "opted_out", "twilio_21610", T0 - DAY);
  const id = store.startDueDrill(WED_9, T0) ?? "";
  store.advanceDue(WED_9, T0 + 5 * MINUTE);
  assert.equal(store.incident(id)?.closeReason, "drill_missed");
  assert.deepEqual(store.contactHealth().map((row) => [row.channel, row.state, row.code]), [
    ["email", "drill_missed", "drill_missed"], ["sms", "opted_out", "twilio_21610"],
  ], "the opt-out (and its START instruction) stays; only the working channel records the miss");
  // START still clears the opt-out, because it was never replaced.
  assert.equal(acknowledgeBySms(store, WED_9, "+15555550100", "START", T0 + 6 * MINUTE).changed, true);
  assert.equal(store.contactHealthState("primary_oncall", "sms"), "ok");
  // Opted out again; then a drill answered by email clears only the drill marker.
  store.setContactHealth("primary_oncall", "sms", "opted_out", "twilio_21610", T0 + 7 * MINUTE);
  store.setMeta("drill_last_contact", "vendor_support");
  const again = store.startDueDrill(WED_9, T0 + 7 * DAY) ?? "";
  store.acknowledge(again, { name: "Primary On-call", via: "email", contactId: "primary_oncall" }, WED_9, T0 + 7 * DAY + MINUTE);
  assert.deepEqual([store.contactHealthState("primary_oncall", "email"), store.contactHealthState("primary_oncall", "sms")], ["ok", "opted_out"]);
});

void test("drill: never joins a real incident's group, is never closed as a removed component, and real incidents page on their own", () => {
  const store = newStore();
  const id = store.startDueDrill(WED_9, T0) ?? "";
  const run = (at: number, down: boolean): CheckResult[] => fixtureTargets().components.map((component) => ({
    checkId: `${component.id}_http`, componentId: component.id, type: "http", status: down && component.id === "signup" ? "down" : "ok",
    inconclusive: false, latencyMs: 5, detail: "x", observedAt: at, data: null,
  }));
  store.recordRun(run(T0, true), fixtureTargets(), WED_9, T0);
  const [real = ""] = store.recordRun(run(T0 + MINUTE, true), fixtureTargets(), WED_9, T0 + MINUTE).opened;
  assert.equal(store.incident(real)?.phase, "paging", "a carrier of its own, not grouped under the drill");
  assert.notEqual(store.incident(real)?.ackCode, store.incident(id)?.ackCode);
  assert.equal(store.incident(id)?.resolvedAt, null, "the drill (component '') is not an orphan of the targets");
});
