// The escalation state machine, step by step and exhaustively: every tier and cycle, acknowledgement at every point,
// resolution in every phase, replays (alarm retries), late alarms, and degenerate policies.
import assert from "node:assert/strict";
import test from "node:test";
import type { EscalationPolicy } from "../worker/config.ts";
import { nextAlarmAt, parseEscalationState, startEscalation, stepEscalation } from "../worker/escalation.ts";
import type { EscalationState, Send, Transition } from "../worker/escalation.ts";
import { examplePolicy, MINUTE, T0 } from "./support/fakes.ts";

const policy = examplePolicy();
// primary: primary_oncall (sms+email) 5 min; secondary: secondary_oncall (sms+email), engineering_lead (email) 10 min;
// third_party: vendor_support (sms+email) 15 min; maxCycles 3.
const PRIMARY = ["primary_oncall"], SECONDARY = ["secondary_oncall", "engineering_lead"], THIRD = ["vendor_support"];
const ALL = [...PRIMARY, ...SECONDARY, ...THIRD];

const who = (sends: readonly Send[], kind: Send["kind"]): string[] =>
  [...new Set(sends.filter((send) => send.kind === kind).map((send) => send.contactId))].sort();
const channels = (sends: readonly Send[], contactId: string): string[] =>
  sends.filter((send) => send.contactId === contactId).map((send) => send.channel).sort();
const tick = (current: Transition, at: number, using: EscalationPolicy = policy): Transition => stepEscalation(using, current.state, { type: "tick" }, at);

/** Ticks exactly at every deadline until paging ends (exhaustion; reminders follow it); returns every transition. */
function runToEnd(start: Transition, using: EscalationPolicy = policy): Transition[] {
  const steps = [start];
  let current = start;
  for (let guard = 0; guard < 100 && current.nextAlarmAt !== null && current.state.phase === "paging"; guard += 1) {
    current = tick(current, current.nextAlarmAt, using);
    steps.push(current);
  }
  return steps;
}

void test("opening pages every primary contact on each of their channels and waits the primary timeout", () => {
  const start = startEscalation(policy, "inc_1", T0);
  assert.equal(start.state.phase, "paging");
  assert.deepEqual(who(start.sends, "page"), PRIMARY);
  assert.deepEqual(channels(start.sends, "primary_oncall"), ["email", "sms"]);
  assert.equal(start.sends.filter((send) => send.kind !== "page").length, 0, "nobody earlier to notify yet");
  assert.equal(start.nextAlarmAt, T0 + 5 * MINUTE);
  assert.deepEqual(start.sends[0]?.target, { tierName: "Primary on-call", contactNames: ["Primary On-call"] });
});

void test("a tick before the deadline changes nothing and sends nothing", () => {
  const start = startEscalation(policy, "inc_1", T0);
  const early = tick(start, T0 + 5 * MINUTE - 1);
  assert.deepEqual(early.state, start.state);
  assert.deepEqual(early.sends, []);
  assert.equal(early.nextAlarmAt, start.nextAlarmAt);
});

void test("primary timeout pages secondary and backpedals to primary with who it went to", () => {
  const second = tick(startEscalation(policy, "inc_1", T0), T0 + 5 * MINUTE);
  assert.deepEqual(who(second.sends, "page"), SECONDARY.slice().sort());
  assert.deepEqual(channels(second.sends, "engineering_lead"), ["email"], "an email-only contact gets email only");
  assert.deepEqual(who(second.sends, "escalation_notice"), PRIMARY);
  const notice = second.sends.find((send) => send.kind === "escalation_notice");
  assert.deepEqual(notice?.target, { tierName: "Secondary on-call", contactNames: ["Secondary On-call", "Engineering Lead"] });
  assert.equal(second.nextAlarmAt, T0 + 15 * MINUTE);
  assert.equal(second.state.tierIndex, 1);
});

void test("secondary timeout pages third party and re-notifies primary and secondary", () => {
  const start = startEscalation(policy, "inc_1", T0);
  const third = tick(tick(start, T0 + 5 * MINUTE), T0 + 15 * MINUTE);
  assert.deepEqual(who(third.sends, "page"), THIRD);
  assert.deepEqual(who(third.sends, "escalation_notice"), [...PRIMARY, ...SECONDARY].sort());
  assert.equal(third.nextAlarmAt, T0 + 30 * MINUTE);
});

void test("last tier timeout walks back to primary for the next cycle and tells everyone else", () => {
  const steps = runToEnd(startEscalation(policy, "inc_1", T0));
  const cycle2 = steps[3];
  assert.ok(cycle2 !== undefined);
  assert.equal(cycle2.state.cycle, 2);
  assert.equal(cycle2.state.tierIndex, 0);
  assert.deepEqual(who(cycle2.sends, "page"), PRIMARY);
  assert.ok(cycle2.sends.every((send) => send.kind !== "page" || send.cycle === 2));
  assert.deepEqual(who(cycle2.sends, "cycle_notice"), [...SECONDARY, ...THIRD].sort());
  // Cycle 2, secondary: everyone paged so far who is not secondary hears it (primary and third party).
  assert.deepEqual(who(steps[4]?.sends ?? [], "escalation_notice"), [...PRIMARY, ...THIRD].sort());
});

void test("the worked timeline: every step lands on the documented minute", () => {
  const steps = runToEnd(startEscalation(policy, "inc_1", T0));
  const minutes = steps.map((step) => (step.state.stepStartedAt - T0) / MINUTE);
  // Primary, secondary, third party; three cycles; then the final message at minute 90 (which restarts the clock for
  // the first reminder, an hour later).
  assert.deepEqual(minutes, [0, 5, 15, 30, 35, 45, 60, 65, 75, 90]);
  const last = steps.at(-1);
  assert.ok(last !== undefined);
  assert.equal(last.state.phase, "exhausted");
  assert.equal(last.nextAlarmAt, T0 + 150 * MINUTE, "the first reminder");
  // The exhausted step fires at the third-party deadline of cycle 3: minute 75 + 15 = 90.
  assert.equal(steps.at(-2)?.nextAlarmAt, T0 + 90 * MINUTE);
});

void test("exhaustion pages each tier maxCycles times, then sends one final all-tiers message and stops", () => {
  const steps = runToEnd(startEscalation(policy, "inc_1", T0));
  const all = steps.flatMap((step) => step.sends);
  for (const id of ALL) {
    const pages = all.filter((send) => send.kind === "page" && send.contactId === id && send.channel === (id === "engineering_lead" ? "email" : "sms"));
    assert.equal(pages.length, 3, `${id} paged once per cycle`);
  }
  const final = all.filter((send) => send.kind === "exhausted");
  assert.deepEqual([...new Set(final.map((send) => send.contactId))].sort(), ALL.slice().sort(), "everyone in every tier");
  const channels = (id: string): string[] => final.filter((send) => send.contactId === id).map((send) => send.channel).sort();
  assert.deepEqual(channels("primary_oncall"), ["email", "sms"], "on every channel they have, not email first");
  assert.deepEqual(channels("engineering_lead"), ["email"]);
  const after = tick(steps.at(-1) ?? steps[0] ?? startEscalation(policy, "x", T0), T0 + 1000 * MINUTE);
  assert.deepEqual(after.sends.filter((send) => send.kind !== "reminder"), [], "no paging after exhaustion, only reminders");
  assert.equal(after.state.phase, "exhausted");
});

void test("every send key in a full run is unique, so the outbox can never hold a step twice", () => {
  const all = runToEnd(startEscalation(policy, "inc_1", T0)).flatMap((step) => step.sends);
  assert.equal(new Set(all.map((send) => send.key)).size, all.length);
  assert.ok(all.every((send) => send.key.startsWith("inc_1:")));
});

void test("replaying a tick is idempotent: same keys from the old state, nothing from the new one", () => {
  const start = startEscalation(policy, "inc_1", T0);
  const first = tick(start, T0 + 5 * MINUTE);
  const retried = tick(start, T0 + 5 * MINUTE + 30_000);
  assert.deepEqual(retried.sends.map((send) => send.key), first.sends.map((send) => send.key));
  const again = tick(first, T0 + 5 * MINUTE);
  assert.deepEqual(again.sends, []);
  assert.deepEqual(again.state, first.state);
});

void test("a late alarm advances one step only and restarts the timeout from the tick", () => {
  const start = startEscalation(policy, "inc_1", T0);
  const late = tick(start, T0 + 60 * MINUTE);
  assert.equal(late.state.tierIndex, 1);
  assert.equal(late.state.cycle, 1);
  assert.equal(late.nextAlarmAt, T0 + 70 * MINUTE);
});

// Acknowledge after k timeouts, for every k through exhaustion.
const fullRun = runToEnd(startEscalation(policy, "inc_1", T0));
for (const [index, before] of fullRun.entries()) {
  void test(`acknowledgement after ${String(index)} timeouts stops paging and tells everyone paged so far`, () => {
    const at = before.state.stepStartedAt + MINUTE;
    const acked = stepEscalation(policy, before.state, { type: "ack", by: "Secondary On-call", via: "sms" }, at);
    assert.equal(acked.state.phase, "acknowledged");
    assert.equal(acked.state.acknowledgedBy, "Secondary On-call");
    assert.equal(acked.state.acknowledgedAt, at);
    assert.equal(acked.nextAlarmAt, null);
    assert.ok(acked.sends.every((send) => send.kind === "acknowledged" && send.acknowledgedBy === "Secondary On-call"));
    assert.deepEqual(who(acked.sends, "acknowledged"), before.state.paged.slice().sort());
    const later = tick(acked, at + 1000 * MINUTE);
    assert.deepEqual(later.sends, [], "no further pages after acknowledgement");
    const twice = stepEscalation(policy, acked.state, { type: "ack", by: "Primary On-call", via: "email" }, at + MINUTE);
    assert.deepEqual(twice.sends, [], "a second acknowledgement sends nothing");
    assert.equal(twice.state.acknowledgedBy, "Secondary On-call", "the first acknowledgement stands");
  });
}

void test("only contacts already paged hear the acknowledgement", () => {
  const start = startEscalation(policy, "inc_1", T0);
  const acked = stepEscalation(policy, start.state, { type: "ack", by: "Vendor Support", via: "sms" }, T0 + MINUTE);
  assert.deepEqual(who(acked.sends, "acknowledged"), PRIMARY, "vendor acknowledged before being paged; only primary was paged");
});

for (const phase of ["paging", "acknowledged", "exhausted"] as const) {
  void test(`resolution while ${phase} tells everyone paged and stops everything`, () => {
    let current = startEscalation(policy, "inc_1", T0);
    current = tick(current, T0 + 5 * MINUTE);
    if (phase === "acknowledged") current = stepEscalation(policy, current.state, { type: "ack", by: "Primary On-call", via: "email" }, T0 + 6 * MINUTE);
    if (phase === "exhausted") current = runToEnd(current).at(-1) ?? current;
    assert.equal(current.state.phase, phase);
    const resolved = stepEscalation(policy, current.state, { type: "resolve" }, T0 + 200 * MINUTE);
    assert.equal(resolved.state.phase, "resolved");
    assert.equal(resolved.state.resolvedAt, T0 + 200 * MINUTE);
    assert.equal(resolved.nextAlarmAt, null);
    assert.deepEqual(who(resolved.sends, "resolved"), current.state.paged.slice().sort());
    assert.deepEqual(stepEscalation(policy, resolved.state, { type: "resolve" }, T0 + 201 * MINUTE).sends, [], "resolve twice: nothing");
    assert.deepEqual(stepEscalation(policy, resolved.state, { type: "ack", by: "x", via: "sms" }, T0 + 201 * MINUTE).sends, [], "ack after resolve");
    assert.deepEqual(tick({ ...resolved }, T0 + 999 * MINUTE).sends, [], "tick after resolve");
  });
}

void test("acknowledging after exhaustion still records it and tells everyone paged", () => {
  const exhausted = runToEnd(startEscalation(policy, "inc_1", T0)).at(-1);
  assert.ok(exhausted !== undefined);
  const acked = stepEscalation(policy, exhausted.state, { type: "ack", by: "Vendor Support", via: "email" }, T0 + 120 * MINUTE);
  assert.equal(acked.state.phase, "acknowledged");
  assert.deepEqual(who(acked.sends, "acknowledged"), ALL.slice().sort());
});

void test("maxCycles 1 exhausts right after the last tier's first timeout", () => {
  const once: EscalationPolicy = { ...policy, maxCycles: 1 };
  const steps = runToEnd(startEscalation(once, "inc_1", T0), once);
  assert.deepEqual(steps.map((step) => step.state.phase), ["paging", "paging", "paging", "exhausted"]);
  assert.equal(steps.flatMap((step) => step.sends).filter((send) => send.kind === "cycle_notice").length, 0);
});

void test("a single-tier policy repeats the tier each cycle, with no one else to notify", () => {
  const single: EscalationPolicy = { ...policy, maxCycles: 2, tiers: policy.tiers.slice(0, 1) };
  const steps = runToEnd(startEscalation(single, "inc_1", T0), single);
  assert.deepEqual(steps.map((step) => [step.state.cycle, step.state.phase]), [[1, "paging"], [2, "paging"], [2, "exhausted"]]);
  const sends = steps.flatMap((step) => step.sends);
  assert.equal(sends.filter((send) => send.kind === "cycle_notice" || send.kind === "escalation_notice").length, 0);
});

void test("an sms-only contact gets the final message by SMS (nobody is left without it)", () => {
  const primary = policy.tiers[0];
  if (primary === undefined) throw new Error("example policy has no tiers");
  const smsOnly: EscalationPolicy = {
    ...policy, maxCycles: 1, tiers: [{ ...primary, contacts: [{ id: "pager", name: "Pager", sms: "+15555550199", email: null }] }],
  };
  const final = runToEnd(startEscalation(smsOnly, "inc_1", T0), smsOnly).flatMap((step) => step.sends).filter((send) => send.kind === "exhausted");
  assert.deepEqual(final.map((send) => [send.contactId, send.channel]), [["pager", "sms"]]);
});

void test("a policy edited mid-incident (tiers removed) keeps working from the last remaining tier", () => {
  const third = tick(tick(startEscalation(policy, "inc_1", T0), T0 + 5 * MINUTE), T0 + 15 * MINUTE);
  const shrunk: EscalationPolicy = { ...policy, tiers: policy.tiers.slice(0, 1) };
  assert.equal(nextAlarmAt(shrunk, third.state), T0 + 20 * MINUTE, "uses the remaining tier's timeout");
  const next = tick(third, T0 + 20 * MINUTE, shrunk);
  assert.equal(next.state.cycle, 2);
  assert.deepEqual(who(next.sends, "page"), PRIMARY);
});

void test("invariants hold at every point of every run with an acknowledgement or resolution injected anywhere", () => {
  for (let stop = 0; stop < fullRun.length; stop += 1) {
    for (const event of [{ type: "ack", by: "Someone", via: "operator" }, { type: "resolve" }] as const) {
      const before = fullRun[stop];
      assert.ok(before !== undefined);
      const after = stepEscalation(policy, before.state, event, before.state.stepStartedAt + 1);
      const tail = runToEnd(after);
      const everything = [...fullRun.slice(0, stop + 1), ...tail].flatMap((step) => step.sends);
      assert.equal(new Set(everything.map((send) => send.key)).size, everything.length, "no key twice");
      for (const step of tail) assert.equal(step.nextAlarmAt === null, step.state.phase !== "paging");
      assert.ok(tail.slice(1).every((step) => step.sends.length === 0), "nothing after the terminal event");
    }
  }
});

void test("stored state round-trips and malformed state is refused", () => {
  const state: EscalationState = startEscalation(policy, "inc_1", T0).state;
  assert.deepEqual(parseEscalationState(JSON.parse(JSON.stringify(state))), state);
  assert.equal(parseEscalationState({ ...state, phase: "sleeping" }), null);
  assert.equal(parseEscalationState({ ...state, paged: [1] }), null);
  assert.equal(parseEscalationState(null), null);
});

void test("exhausted and unresolved: everyone in every tier is reminded on every channel each reminderMinutes, under stable step ids", () => {
  const exhausted = runToEnd(startEscalation(policy, "inc_1", T0)).at(-1);
  assert.ok(exhausted !== undefined && exhausted.state.phase === "exhausted");
  const at = exhausted.state.stepStartedAt;
  assert.equal(exhausted.nextAlarmAt, at + 60 * MINUTE, "the default reminderMinutes is 60");
  assert.deepEqual(tick(exhausted, at + 59 * MINUTE).sends, [], "not before it is due");
  const first = tick(exhausted, at + 60 * MINUTE);
  assert.deepEqual(who(first.sends, "reminder"), ALL.slice().sort(), "everyone in every tier, paged or not");
  assert.deepEqual(channels(first.sends, "primary_oncall"), ["email", "sms"], "on every channel (unlike the final notice)");
  assert.ok(first.sends.every((send) => send.key.includes(":reminder-1:")));
  assert.equal(first.nextAlarmAt, at + 120 * MINUTE);
  const second = tick(first, at + 120 * MINUTE);
  assert.ok(second.sends.every((send) => send.key.includes(":reminder-2:")));
  assert.deepEqual(tick(exhausted, at + 60 * MINUTE).sends.map((send) => send.key), first.sends.map((send) => send.key), "a replay yields the same keys");
  assert.deepEqual(stepEscalation(policy, second.state, { type: "ack", by: "Vendor Support", via: "sms" }, at + 130 * MINUTE).nextAlarmAt, null,
    "an acknowledgement ends the reminders");
  const off: EscalationPolicy = { ...policy, reminderMinutes: 0 };
  const quiet = runToEnd(startEscalation(off, "inc_1", T0), off).at(-1);
  assert.equal(quiet?.state.phase, "exhausted");
  assert.equal(quiet.nextAlarmAt, null, "reminderMinutes 0: no reminders");
});
