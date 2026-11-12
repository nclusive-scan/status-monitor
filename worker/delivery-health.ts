// What a delivery failure says about a contact or a channel. PURE: codes in, decisions out.
//
// Contact level, recorded in contact health and told to the first tier by email:
//   opted_out      the number replied STOP (Twilio 21610, synchronously or in a status callback, or an inbound keyword)
//   undeliverable  not a valid or SMS-capable mobile number, a region not enabled, or an unknown/landline destination
//   suppressed     Email Service refuses the address (suppression list: earlier bounce or complaint)
// Channel level: alert email as a whole failing (an SMS to the first tier, at most hourly per code, and a monitor
// warning), or alert SMS as a whole failing (an email to the first tier, likewise, and a monitor warning).
//
// Early escalation (every channel of the paged tier failed) counts only failures about the contact: a provider- or
// account-level failure fails every tier the same way, and escalating on it would run through every tier and cycle to
// "exhausted" in seconds, leaving nobody paged once the provider recovers.
import type { ContactProblem } from "./notify/messages.ts";

const PROBLEMS: Readonly<Record<string, ContactProblem>> = {
  twilio_recipient_opted_out: "opted_out",
  twilio_21610: "opted_out",
  twilio_invalid_number: "undeliverable",
  twilio_21211: "undeliverable",
  twilio_not_sms_capable: "undeliverable",
  twilio_21614: "undeliverable",
  twilio_region_not_enabled: "undeliverable",
  twilio_21408: "undeliverable",
  // Status callback codes: unknown destination handset, landline or unreachable carrier.
  twilio_30005: "undeliverable",
  twilio_30006: "undeliverable",
  email_recipient_suppressed: "suppressed",
};

/** The contact-health problem a final delivery failure code means for that channel, or null (not the contact's fault). */
export function contactProblemFor(channel: "sms" | "email", code: string): ContactProblem | null {
  const problem = PROBLEMS[code] ?? null;
  if (problem === null) return null;
  return (problem === "suppressed") === (channel === "email") ? problem : null;
}

/**
 * Carrier delivery codes from a Twilio status callback that are about this handset or number: unreachable handset
 * (30003), blocked by the recipient's side (30004), unknown destination (30005), landline (30006).
 */
const CONTACT_DELIVERY_CODES: readonly string[] = ["twilio_30003", "twilio_30004", "twilio_30005", "twilio_30006"];

/**
 * True when a final failure means this contact cannot be reached on this channel (opted out, invalid, suppressed,
 * unreachable handset): what early escalation counts. Account, provider and retry-exhausted failures are not.
 */
export const isContactFailure = (channel: "sms" | "email", code: string): boolean =>
  contactProblemFor(channel, code) !== null || (channel === "sms" && CONTACT_DELIVERY_CODES.includes(code));

/**
 * Twilio codes that mean alert SMS is failing for everyone, not one recipient: bad credentials (20003, HTTP 401/403), a
 * From number that is invalid or not the account's (21212, 21606), an invalid Messaging Service (21705), an unverified
 * toll-free number (30032), an unregistered 10DLC number (30034), or no Twilio settings at all.
 */
export const SMS_CHANNEL_CODES: readonly string[] = [
  "twilio_20003", "twilio_21212", "twilio_21606", "twilio_21705", "twilio_30032", "twilio_30034", "twilio_http_401", "twilio_http_403",
  "twilio_not_configured",
];

export const isSmsChannelProblem = (code: string): boolean => SMS_CHANNEL_CODES.includes(code);

/** The monitor warning for a failing SMS channel: sms_channel_failing:<code> (the code starts with a letter, as the platform requires). */
export const smsChannelWarning = (code: string): string => `sms_channel_failing:${code}`;

/** Email Service codes that mean alert email is failing for everyone, not one recipient. */
export const EMAIL_CHANNEL_CODES: readonly string[] = [
  "email_account_suspended", "email_daily_limit_exceeded", "email_sender_not_verified", "email_sender_domain_not_available",
];

export const isEmailChannelProblem = (code: string): boolean => EMAIL_CHANNEL_CODES.includes(code);

/** The monitor warning for a failing email channel: email_channel_failing:<code without the email_ prefix>. */
export const emailChannelWarning = (code: string): string => `email_channel_failing:${code.replace(/^email_/, "")}`;

/** Twilio MessageStatus values (https://www.twilio.com/docs/messaging/api/message-resource#message-status-values). */
export const TWILIO_STATUSES: readonly string[] = [
  "queued", "sending", "sent", "accepted", "scheduled", "delivered", "undelivered", "failed", "canceled", "read", "partially_delivered",
  "receiving", "received",
];
/** Final statuses that mean the message will not arrive. */
export const FAILED_STATUSES: readonly string[] = ["failed", "undelivered", "canceled"];
export const isFinalStatus = (status: string): boolean => status === "delivered" || status === "read" || FAILED_STATUSES.includes(status);
/** Statuses still on the way: after UNKNOWN_AFTER_MS in one of these (or none), a send is marked "unknown". */
export const PENDING_STATUSES: readonly string[] = ["queued", "sending", "sent", "accepted", "scheduled"];
/** No final status this long after the send: "unknown" (surfaced in the private view and a warning; no failover). */
export const UNKNOWN_AFTER_MS = 10 * 60_000;
