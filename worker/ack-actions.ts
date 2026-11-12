// Acknowledgement and escalation decisions, kept out of the Durable Object class so they are testable against the real
// store. Only someone in the current policy can act: a link (or a number) stops working as soon as its contact is
// removed, even inside the link's TTL.
//
// SMS replies (inbound.ts has the grammar): unknown numbers and unrelated text get none; every reply to a known contact
// passes the per-contact limiter (store.allowReply: 5 in 10 minutes), so an auto-responder can never start a loop.
import type { Contact, EscalationPolicy } from "./config.ts";
import { contactById, contactByPhone, parseInbound } from "./inbound.ts";
import type { AckOutcome, EscalateOutcome, IncidentRow, MonitorStore } from "./store.ts";

export interface AckPageView {
  readonly title: string;
  readonly openedAt: number;
  readonly acknowledged: boolean;
  readonly resolved: boolean;
  /** A weekly drill: nothing to escalate. */
  readonly drill: boolean;
  /** policy.timeZone, for the "open since" time. */
  readonly timeZone: string;
}

/** What the confirm page shows for a verified link: the group it would acknowledge, or null (invalid link). */
export function ackPageView(store: MonitorStore, policy: EscalationPolicy, incidentId: string, contactId: string): AckPageView | null {
  if (contactById(policy, contactId) === null) return null;
  const incident = store.incident(incidentId);
  if (incident === null) return null;
  const carrier = store.carrierFor(incident);
  const base = { drill: incident.drill, timeZone: policy.timeZone };
  if (carrier === null) {
    return {
      ...base, title: incident.title, openedAt: incident.openedAt, acknowledged: incident.acknowledgedAt !== null, resolved: incident.resolvedAt !== null,
    };
  }
  const others = store.alsoAffected(carrier).length;
  return {
    ...base,
    title: others === 0 ? carrier.title : `${carrier.title} (and ${String(others)} more)`,
    openedAt: carrier.openedAt,
    acknowledged: carrier.acknowledgedAt !== null,
    resolved: false,
  };
}

export function acknowledgeByLink(store: MonitorStore, policy: EscalationPolicy, incidentId: string, contactId: string, now: number): AckOutcome {
  const contact = contactById(policy, contactId);
  if (contact === null) return "not_found";
  return store.acknowledge(incidentId, { name: contact.name, via: "email", contactId: contact.id }, policy, now);
}

/** The escalate button on the confirm page (POST only, like the acknowledgement). */
export function escalateByLink(store: MonitorStore, policy: EscalationPolicy, incidentId: string, contactId: string, now: number): EscalateOutcome {
  const contact = contactById(policy, contactId);
  if (contact === null) return { outcome: "not_found", tierName: null };
  return store.escalateNow(incidentId, { name: contact.name, via: "email", contactId: contact.id }, policy, now);
}

export interface SmsOutcome {
  /** The reply to send (null: none). */
  readonly reply: string | null;
  /** Whether anything changed that may have queued messages (the caller wakes the delivery alarm). */
  readonly changed: boolean;
}

const HELP_GENERIC = "Reply ACK followed by the 6-character code from the page, or ESC and the code to escalate.";

function helpFor(store: MonitorStore, contact: Contact): string {
  const waiting = store.openGroupsPagedTo(contact.id).filter((incident) => incident.acknowledgedAt === null);
  const [only] = waiting;
  if (waiting.length !== 1 || only === undefined) return HELP_GENERIC;
  return only.drill ? `Reply ACK ${only.ackCode} to confirm the test page.` : `Reply ACK ${only.ackCode} to acknowledge, or ESC ${only.ackCode} to escalate.`;
}

function acknowledgeIncident(store: MonitorStore, policy: EscalationPolicy, contact: Contact, incident: IncidentRow, now: number): SmsOutcome {
  const outcome = store.acknowledge(incident.id, { name: contact.name, via: "sms", contactId: contact.id }, policy, now);
  // A drill sends no acknowledgement notice, so the reply is the confirmation.
  if (incident.drill && outcome === "acknowledged") return { reply: "Drill acknowledged: pages reach you. Thank you.", changed: true };
  if (outcome === "already_acknowledged") {
    const by = store.carrierFor(incident)?.acknowledgedBy ?? incident.acknowledgedBy ?? "someone";
    return { reply: `Already acknowledged by ${by}.`, changed: false };
  }
  if (outcome === "resolved") return { reply: "Already resolved. Nothing to acknowledge.", changed: false };
  // "acknowledged": everyone paged, this contact included, gets the acknowledgement notice; no second reply.
  return { reply: null, changed: outcome === "acknowledged" };
}

function bareAck(store: MonitorStore, policy: EscalationPolicy, contact: Contact, now: number): SmsOutcome {
  const paged = store.openGroupsPagedTo(contact.id);
  const waiting = paged.filter((incident) => incident.acknowledgedAt === null);
  const [only] = waiting;
  if (waiting.length === 1 && only !== undefined) return acknowledgeIncident(store, policy, contact, only, now);
  if (waiting.length > 1) return { reply: `${String(waiting.length)} incidents are open. ${HELP_GENERIC}`, changed: false };
  const [acknowledged] = paged;
  if (paged.length === 1 && acknowledged !== undefined) {
    return { reply: `Already acknowledged by ${acknowledged.acknowledgedBy ?? "someone"}.`, changed: false };
  }
  return { reply: "Nothing is waiting for your acknowledgement.", changed: false };
}

function escalate(store: MonitorStore, policy: EscalationPolicy, contact: Contact, code: string, now: number): SmsOutcome {
  const incident = store.openIncidentByCode(code);
  if (incident === null) return { reply: `No open incident has code ${code}.`, changed: false };
  const { outcome, tierName } = store.escalateNow(incident.id, { name: contact.name, via: "sms", contactId: contact.id }, policy, now);
  switch (outcome) {
    case "escalated":
      const reply = tierName === null ? "Escalated: every tier has now been tried; everyone is being told." : `Escalated: now paging ${tierName}.`;
      return { reply, changed: true };
    case "drill":
      return { reply: `This is a test page. Reply ACK ${incident.ackCode} to confirm it reached you.`, changed: false };
    case "already_acknowledged":
      return { reply: `Already acknowledged by ${store.carrierFor(incident)?.acknowledgedBy ?? "someone"}.`, changed: false };
    case "exhausted":
      return { reply: `Paging already went through every tier. Reply ACK ${code} to acknowledge.`, changed: false };
    case "resolved":
    case "not_found":
      return { reply: `No open incident has code ${code}.`, changed: false };
  }
}

/** Decides what an inbound SMS does, before the reply limiter. */
function decide(store: MonitorStore, policy: EscalationPolicy, contact: Contact, body: string, now: number): SmsOutcome {
  const command = parseInbound(body);
  switch (command.type) {
    case "opt_out": {
      // Twilio blocks the number and answers the opt-out itself; the monitor records it and tells the first tier.
      const changed = store.setContactHealth(contact.id, "sms", "opted_out", "inbound_stop", now);
      if (changed) store.queueContactNotice(contact.id, "opted_out", policy, now);
      return { reply: null, changed };
    }
    case "opt_in": {
      const changed = store.contactHealthState(contact.id, "sms") === "opted_out" && store.setContactHealth(contact.id, "sms", "ok", "inbound_start", now);
      return { reply: null, changed };
    }
    case "ack": {
      const incident = store.openIncidentByCode(command.code);
      if (incident === null) return { reply: `No open incident has code ${command.code}.`, changed: false };
      return acknowledgeIncident(store, policy, contact, incident, now);
    }
    case "ack_bare":
      return bareAck(store, policy, contact, now);
    case "esc":
      return escalate(store, policy, contact, command.code, now);
    case "malformed":
      return { reply: helpFor(store, contact), changed: false };
    case "other":
      return { reply: null, changed: false };
  }
}

/** The SMS reply to send (null: none) and whether anything changed. Unknown numbers and unrelated texts get no reply. */
export function acknowledgeBySms(store: MonitorStore, policy: EscalationPolicy, from: string, body: string, now: number): SmsOutcome {
  const contact = contactByPhone(policy, from);
  if (contact === null) return { reply: null, changed: false };
  const outcome = decide(store, policy, contact, body, now);
  if (outcome.reply === null || store.allowReply(contact.id, now)) return outcome;
  return { reply: null, changed: outcome.changed };
}
