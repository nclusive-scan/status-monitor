// The escalation state machine. PURE: no clock, no I/O, no randomness. Given the policy, an incident's escalation
// state, the time and one event, it returns the next state, the notifications to send and when to wake up next.
//
// Paging walks the tiers in order. Each tier has an acknowledgement timeout counted from the moment it was paged.
//   - A tier times out unacknowledged: page the next tier AND tell everyone already paged that the incident is still
//     unacknowledged and who it has now gone to ("backpedalling").
//   - The last tier times out: start the next cycle back at the first tier (same notices), up to policy.maxCycles.
//   - The last tier of the last cycle times out: send everyone in every tier a final "unacknowledged after N cycles"
//     message on every channel they have, then stop paging. The incident stays open.
//   - While it stays exhausted and unresolved, remind everyone in every tier on every channel each
//     policy.reminderMinutes (0: never), each reminder a step with a stable id ("reminder-<n>").
//   - An "escalate" event (a responder's ESC, or every channel of every contact in the current tier failed) takes the
//     next step now instead of at the tier's deadline.
//   - Any acknowledgement stops paging and tells everyone already paged who acknowledged.
//   - Resolution tells everyone already paged.
// One alarm tick advances at most one step, and the step that follows starts from the tick, not from the missed
// deadline, so a late alarm never bursts several tiers at once.
//
// Idempotency: every step has a stable id (recorded in state.steps) and every send a stable key derived from the
// incident, the step, the contact and the channel. Replaying an event against the state it already produced yields no
// sends; replaying it against the earlier state yields the same keys, which the outbox stores at most once.
import type { Contact, EscalationPolicy, Tier } from "./config.ts";

export type Channel = "sms" | "email";
export type Phase = "paging" | "acknowledged" | "exhausted" | "resolved";
export type SendKind = "page" | "escalation_notice" | "cycle_notice" | "exhausted" | "reminder" | "acknowledged" | "resolved";
export type AckVia = "sms" | "email" | "operator";

export interface EscalationState {
  readonly incidentId: string;
  readonly phase: Phase;
  /** 1-based cycle number. */
  readonly cycle: number;
  /** Index into policy.tiers of the tier currently waiting to acknowledge. */
  readonly tierIndex: number;
  /** When the current tier was paged (epoch ms). */
  readonly stepStartedAt: number;
  /** Contact ids that have been paged, in order, without repeats. */
  readonly paged: readonly string[];
  /** Tier ids that have been paged at least once. */
  readonly pagedTiers: readonly string[];
  /** Step ids already taken (idempotency). */
  readonly steps: readonly string[];
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: number | null;
  readonly resolvedAt: number | null;
}

export interface Send {
  /** Stable idempotency key: incident, step, contact and channel. */
  readonly key: string;
  readonly kind: SendKind;
  readonly contactId: string;
  readonly channel: Channel;
  readonly tierId: string | null;
  readonly cycle: number;
  /** The tier now being paged, and the names (never numbers or addresses) of its contacts. */
  readonly target: { readonly tierName: string; readonly contactNames: readonly string[] } | null;
  readonly acknowledgedBy: string | null;
}

export type EscalationEvent =
  | { readonly type: "tick" }
  /** Take the next step now, without waiting for the current tier's deadline (paging phase only). */
  | { readonly type: "escalate" }
  | { readonly type: "ack"; readonly by: string; readonly via: AckVia }
  | { readonly type: "resolve" };

export interface Transition {
  readonly state: EscalationState;
  readonly sends: readonly Send[];
  /** When to call stepEscalation with a tick next; null when nothing is pending. */
  readonly nextAlarmAt: number | null;
}

const MINUTE = 60_000;

/** A tier index that survives a policy edit that removed tiers mid-incident. */
const tierAt = (policy: EscalationPolicy, index: number): Tier => {
  const tier = policy.tiers[Math.min(Math.max(index, 0), policy.tiers.length - 1)];
  if (tier === undefined) throw new Error("ESCALATION_POLICY_EMPTY");
  return tier;
};

const channelsOf = (contact: Contact): Channel[] => [...(contact.sms === null ? [] : ["sms" as const]), ...(contact.email === null ? [] : ["email" as const])];

const contactsById = (policy: EscalationPolicy): Map<string, Contact> =>
  new Map(policy.tiers.flatMap((tier) => tier.contacts.map((contact) => [contact.id, contact] as const)));

export function nextAlarmAt(policy: EscalationPolicy, state: EscalationState): number | null {
  if (state.phase === "exhausted") return policy.reminderMinutes > 0 ? state.stepStartedAt + policy.reminderMinutes * MINUTE : null;
  if (state.phase !== "paging") return null;
  return state.stepStartedAt + tierAt(policy, state.tierIndex).ackTimeoutMinutes * MINUTE;
}

interface Fanout {
  readonly incidentId: string;
  readonly stepId: string;
  readonly kind: SendKind;
  readonly cycle: number;
  readonly tierId: string | null;
  readonly target: Send["target"];
  readonly acknowledgedBy: string | null;
}

function fanout(contacts: readonly Contact[], spec: Fanout, channels: (contact: Contact) => Channel[] = channelsOf): Send[] {
  return contacts.flatMap((contact) =>
    channels(contact).map((channel) => ({
      key: `${spec.incidentId}:${spec.stepId}:${contact.id}:${channel}`,
      kind: spec.kind,
      contactId: contact.id,
      channel,
      tierId: spec.tierId,
      cycle: spec.cycle,
      target: spec.target,
      acknowledgedBy: spec.acknowledgedBy,
    }))
  );
}

export const pageStepId = (cycle: number, tierIndex: number): string => `page-c${String(cycle)}-t${String(tierIndex)}`;

/** Pages policy.tiers[tierIndex] in the given cycle and tells everyone already paged where the incident went. */
function pageTier(policy: EscalationPolicy, state: EscalationState, cycle: number, tierIndex: number, now: number): Transition {
  const stepId = pageStepId(cycle, tierIndex);
  if (state.steps.includes(stepId)) return { state, sends: [], nextAlarmAt: nextAlarmAt(policy, state) };
  const tier = tierAt(policy, tierIndex);
  const target = { tierName: tier.name, contactNames: tier.contacts.map((contact) => contact.name) };
  const base = { incidentId: state.incidentId, cycle, tierId: tier.id, target, acknowledgedBy: null };
  const pages = fanout(tier.contacts, { ...base, stepId, kind: "page" });
  // Everyone paged before (any tier, any cycle) who is not in the tier being paged now.
  const tierContactIds = new Set(tier.contacts.map((contact) => contact.id));
  const byId = contactsById(policy);
  const earlier = state.paged.filter((id) => !tierContactIds.has(id)).flatMap((id) => {
    const contact = byId.get(id);
    return contact === undefined ? [] : [contact];
  });
  const noticeKind = tierIndex === 0 && cycle > 1 ? "cycle_notice" : "escalation_notice";
  const notices = fanout(earlier, { ...base, stepId: `${stepId}-notice`, kind: noticeKind });
  const next: EscalationState = {
    ...state,
    phase: "paging",
    cycle,
    tierIndex,
    stepStartedAt: now,
    paged: [...state.paged, ...tier.contacts.map((contact) => contact.id).filter((id) => !state.paged.includes(id))],
    pagedTiers: state.pagedTiers.includes(tier.id) ? state.pagedTiers : [...state.pagedTiers, tier.id],
    steps: [...state.steps, stepId],
  };
  return { state: next, sends: [...pages, ...notices], nextAlarmAt: nextAlarmAt(policy, next) };
}

/** Opens escalation for a new incident: pages the first tier. */
export function startEscalation(policy: EscalationPolicy, incidentId: string, now: number): Transition {
  const initial: EscalationState = {
    incidentId,
    phase: "paging",
    cycle: 1,
    tierIndex: 0,
    stepStartedAt: now,
    paged: [],
    pagedTiers: [],
    steps: [],
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedAt: null,
  };
  return pageTier(policy, initial, 1, 0, now);
}

/** Reminds everyone in every tier, on every channel, that the exhausted incident is still open and unacknowledged. */
function remind(policy: EscalationPolicy, state: EscalationState, now: number): Transition {
  const stepId = `reminder-${String(state.steps.filter((step) => step.startsWith("reminder-")).length + 1)}`;
  const sends = fanout(policy.tiers.flatMap((tier) => tier.contacts), {
    incidentId: state.incidentId, stepId, kind: "reminder", cycle: state.cycle, tierId: null, target: null, acknowledgedBy: null,
  });
  const next: EscalationState = { ...state, stepStartedAt: now, steps: [...state.steps, stepId] };
  return { state: next, sends, nextAlarmAt: nextAlarmAt(policy, next) };
}

function tick(policy: EscalationPolicy, state: EscalationState, now: number): Transition {
  const due = nextAlarmAt(policy, state);
  if (due === null || now < due) return { state, sends: [], nextAlarmAt: due };
  if (state.phase === "exhausted") return remind(policy, state, now);
  return advance(policy, state, now);
}

/** The step after the current tier: the next tier, the next cycle, or exhaustion. */
function advance(policy: EscalationPolicy, state: EscalationState, now: number): Transition {
  const lastTier = state.tierIndex >= policy.tiers.length - 1;
  if (!lastTier) return pageTier(policy, state, state.cycle, state.tierIndex + 1, now);
  if (state.cycle < policy.maxCycles) return pageTier(policy, state, state.cycle + 1, 0, now);
  if (state.steps.includes("exhausted")) return { state, sends: [], nextAlarmAt: null };
  // Everyone in every tier hears it, paged or not, so nobody assumes someone else has it.
  const everyone = policy.tiers.flatMap((tier) => tier.contacts);
  // Every channel: email is the beta channel, and this is the last word before paging stops.
  const sends = fanout(
    everyone,
    { incidentId: state.incidentId, stepId: "exhausted", kind: "exhausted", cycle: state.cycle, tierId: null, target: null, acknowledgedBy: null },
  );
  // stepStartedAt now counts toward the first reminder.
  const next: EscalationState = { ...state, phase: "exhausted", stepStartedAt: now, steps: [...state.steps, "exhausted"] };
  return { state: next, sends, nextAlarmAt: nextAlarmAt(policy, next) };
}

function pagedContacts(policy: EscalationPolicy, state: EscalationState): Contact[] {
  const byId = contactsById(policy);
  return state.paged.flatMap((id) => {
    const contact = byId.get(id);
    return contact === undefined ? [] : [contact];
  });
}

function acknowledge(policy: EscalationPolicy, state: EscalationState, by: string, now: number): Transition {
  if ((state.phase !== "paging" && state.phase !== "exhausted") || state.steps.includes("ack")) {
    return { state, sends: [], nextAlarmAt: nextAlarmAt(policy, state) };
  }
  const sends = fanout(pagedContacts(policy, state), {
    incidentId: state.incidentId, stepId: "ack", kind: "acknowledged", cycle: state.cycle, tierId: null, target: null, acknowledgedBy: by,
  });
  const next: EscalationState = { ...state, phase: "acknowledged", acknowledgedBy: by, acknowledgedAt: now, steps: [...state.steps, "ack"] };
  return { state: next, sends, nextAlarmAt: null };
}

function resolve(policy: EscalationPolicy, state: EscalationState, now: number): Transition {
  if (state.phase === "resolved" || state.steps.includes("resolved")) return { state, sends: [], nextAlarmAt: null };
  const sends = fanout(pagedContacts(policy, state), {
    incidentId: state.incidentId, stepId: "resolved", kind: "resolved", cycle: state.cycle, tierId: null, target: null,
    acknowledgedBy: state.acknowledgedBy,
  });
  const next: EscalationState = { ...state, phase: "resolved", resolvedAt: now, steps: [...state.steps, "resolved"] };
  return { state: next, sends, nextAlarmAt: null };
}

export function stepEscalation(policy: EscalationPolicy, state: EscalationState, event: EscalationEvent, now: number): Transition {
  switch (event.type) {
    case "tick":
      return tick(policy, state, now);
    case "escalate":
      return state.phase === "paging" ? advance(policy, state, now) : { state, sends: [], nextAlarmAt: nextAlarmAt(policy, state) };
    case "ack":
      return acknowledge(policy, state, event.by, now);
    case "resolve":
      return resolve(policy, state, now);
  }
}

/** Parses a stored state, refusing anything that is not exactly an EscalationState. */
export function parseEscalationState(value: unknown): EscalationState | null {
  if (typeof value !== "object" || value === null) return null;
  const get = (key: string): unknown => Reflect.get(value, key);
  const strings = (key: string): string[] | null => {
    const item = get(key);
    return Array.isArray(item) && item.every((entry) => typeof entry === "string") ? item.map(String) : null;
  };
  const numberOrNull = (key: string): number | null | undefined => {
    const item = get(key);
    return item === null ? null : typeof item === "number" ? item : undefined;
  };
  const phase = get("phase");
  const incidentId = get("incidentId"), cycle = get("cycle"), tierIndex = get("tierIndex"), stepStartedAt = get("stepStartedAt");
  const acknowledgedBy = get("acknowledgedBy");
  const paged = strings("paged"), pagedTiers = strings("pagedTiers"), steps = strings("steps");
  const acknowledgedAt = numberOrNull("acknowledgedAt"), resolvedAt = numberOrNull("resolvedAt");
  if (phase !== "paging" && phase !== "acknowledged" && phase !== "exhausted" && phase !== "resolved") return null;
  if (typeof incidentId !== "string" || typeof cycle !== "number" || typeof tierIndex !== "number" || typeof stepStartedAt !== "number") return null;
  if (paged === null || pagedTiers === null || steps === null || acknowledgedAt === undefined || resolvedAt === undefined) return null;
  if (acknowledgedBy !== null && typeof acknowledgedBy !== "string") return null;
  return { incidentId, phase, cycle, tierIndex, stepStartedAt, paged, pagedTiers, steps, acknowledgedBy, acknowledgedAt, resolvedAt };
}
