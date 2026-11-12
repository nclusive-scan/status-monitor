// Inbound SMS from a number that belongs to a contact in the escalation policy (GoAlert-style grammar). The whole
// message, case-insensitive, surrounding spaces and a final "." or "!" ignored:
//   ACK <code>     acknowledge the incident with that code
//   ACK  or  A     acknowledge, when exactly one open incident has paged this contact
//   ESC <code>     escalate that incident to the next tier now
//   STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT   opt-out keywords: Twilio blocks the number
//                  and answers itself; the monitor records it and tells the first tier
//   START, UNSTOP, YES   opt back in
// Text that starts like a command but is not one ("ACK K7M2Q", "esc") gets help; anything else, and anything from an
// unknown number, gets no reply at all.
import type { Contact, EscalationPolicy } from "./config.ts";

/** Twilio's default opt-out keywords (REVOKE and OPTOUT since 2025-05-13), matched as the whole message. */
export const OPT_OUT_KEYWORDS: readonly string[] = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"];
export const OPT_IN_KEYWORDS: readonly string[] = ["START", "UNSTOP", "YES"];

export type InboundCommand =
  | { readonly type: "ack"; readonly code: string }
  | { readonly type: "ack_bare" }
  | { readonly type: "esc"; readonly code: string }
  | { readonly type: "opt_out" }
  | { readonly type: "opt_in" }
  /** Looks like an ACK or ESC but is not one: answered with help. */
  | { readonly type: "malformed" }
  | { readonly type: "other" };

const CODE = "([2-9a-z]{6})";

export function parseInbound(body: string): InboundCommand {
  const text = body.trim().replace(/\s+/g, " ").replace(/\s*[.!]$/, "");
  const upper = text.toUpperCase();
  if (OPT_OUT_KEYWORDS.includes(upper)) return { type: "opt_out" };
  if (OPT_IN_KEYWORDS.includes(upper)) return { type: "opt_in" };
  if (upper === "ACK" || upper === "A") return { type: "ack_bare" };
  const ack = new RegExp(`^ack ${CODE}$`, "i").exec(text);
  if (ack?.[1] !== undefined) return { type: "ack", code: ack[1].toUpperCase() };
  const esc = new RegExp(`^esc(?:alate)? ${CODE}$`, "i").exec(text);
  if (esc?.[1] !== undefined) return { type: "esc", code: esc[1].toUpperCase() };
  if (/^(?:ack|esc)/i.test(text)) return { type: "malformed" };
  return { type: "other" };
}

/** The code of an "ACK <code>" reply, or null. */
export function parseAckReply(body: string): string | null {
  const command = parseInbound(body);
  return command.type === "ack" ? command.code : null;
}

export function contactByPhone(policy: EscalationPolicy, phone: string): Contact | null {
  for (const tier of policy.tiers) for (const contact of tier.contacts) if (contact.sms !== null && contact.sms === phone) return contact;
  return null;
}

export function contactById(policy: EscalationPolicy, id: string): Contact | null {
  for (const tier of policy.tiers) for (const contact of tier.contacts) if (contact.id === id) return contact;
  return null;
}
