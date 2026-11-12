// Email-only alerting, for a component with alert "email" (for example a staging environment). When its incident
// opens, each email contact of the FIRST tier gets one informational email; when it resolves, the same people get one
// resolved email. Nothing else: no SMS, no acknowledgement code, no escalation timer, no reminder, no early escalation,
// no repeat cycle. Its outbox kinds are not paging kinds (store ACTION_KINDS), so a failed email never fails over to
// SMS, never escalates and never counts in paging health; a failure is still recorded like any other email (outbox,
// timeline, contact health); an account-level email failure is recorded for the email_channel_failing warning, but the
// first tier is not texted about it (store failFinally). A component with alert "none" opens and records incidents but
// notifies nobody. When the component's alert setting changes while its incident is open, the incident follows the new
// setting at the next run (store changeAlertMode).
//
// Incidents of these modes never join or carry a paging group (store.openIncident): each one is its own group.
import type { AlertMode, Contact, EscalationPolicy } from "./config.ts";

export const EMAIL_ALERT_KINDS = ["email_alert", "email_alert_resolved"] as const;
export type EmailAlertKind = (typeof EMAIL_ALERT_KINDS)[number];
export const isEmailAlertKind = (kind: string): kind is EmailAlertKind => EMAIL_ALERT_KINDS.some((item) => item === kind);

/** The phase an incident of a non-paging mode holds while open (paging incidents use the escalation phases). */
export const UNPAGED_PHASE: Readonly<Record<Exclude<AlertMode, "page">, string>> = { email: "email_only", none: "no_alert" };

/** The recipients of an email-only alert: every contact of the first tier with an email address. */
export const firstTierEmailContacts = (policy: EscalationPolicy): Contact[] => (policy.tiers[0]?.contacts ?? []).filter((contact) => contact.email !== null);

/** The stored alert mode of an incident; anything unexpected reads as "page", the mode every older incident had. */
export const alertModeOf = (value: string | null): AlertMode => (value === "email" || value === "none" ? value : "page");
