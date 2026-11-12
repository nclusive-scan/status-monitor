// Non-blocking warnings: shown in the private view and, with a platform, sent in the report.
// None of them stops monitoring. Each is a code, optionally with the id it is about ("contact_single_channel:<id>").
//   contact_single_channel:<contactId>  a contact with only one channel (one failure and they never hear of it)
//   tier_single_contact:<tierId>        a tier with only one contact
//   drill_disabled                      the weekly paging drill is off
//   heartbeat_missing                   DELIVERY_MODE=live without HEARTBEAT_URL: nothing outside notices if the monitor stops
//   email_alert_no_recipient            a component alerts by email only, but the first tier has no contact with an email
//                                       address: its incidents would reach nobody
//   dns_inconclusive                    every DNS result has been inconclusive for over 15 minutes (the resolver is failing)
//   incidents_pruned_unexported         retention dropped incidents the platform never archived
//   email_channel_failing:<code>        alert email fails account-wide (suspended, daily limit, sender or domain not
//                                       verified) since the last email that went out; the first tier was told by SMS
//   sms_channel_failing:<code>          alert SMS fails for everyone (bad credentials, a From number or Messaging Service
//                                       the account cannot send from, unregistered 10DLC or toll-free) since the last
//                                       SMS confirmed delivered; the first tier was told by email
//   sms_delivery_unknown                an SMS in the last 24 h got no final delivery status within 10 minutes
//   report_incidents_refused            (report only) the platform refused the last report carrying incidents as invalid,
//                                       so this one carries the state without them
//   contact_health_truncated            (report only) the report had to leave out some contact-health problems to fit
//   newer_revision_refused:<code>       (report only) while the stored revision no longer works, the Worker also refused a
//                                       newer saved one (config_unusable, config_invalid, ...): the admin's fix did not take
//
// Every warning fits inside the platform's MONITOR_WARNING (^[a-z0-9_]{1,48}(?::[a-z0-9_]{1,48})?$; here a letter first
// in both parts as well), or it is dropped here rather than have the platform refuse the whole report.
//
// At most MAX_WARNINGS (the platform's own limit) go out, the per-contact and per-tier advice last: a large roster can
// produce one contact_single_channel per contact, and that must never push out a failing channel or a stuck archive.
import type { MonitorConfig } from "./config.ts";
import { emailChannelWarning, smsChannelWarning } from "./delivery-health.ts";
import { firstTierEmailContacts } from "./email-alert.ts";

export const DNS_INCONCLUSIVE_NOTICE_MS = 15 * 60_000;
/** The platform's limit (monitorState.warnings max(200)). */
export const MAX_WARNINGS = 200;
export const WARNING = /^[a-z][a-z0-9_]{0,47}(?::[a-z][a-z0-9_]{0,47})?$/;
/** The per-contact and per-tier advice: one per contact or tier, so it goes after everything else. */
const ROSTER_ADVICE = /^(?:contact_single_channel|tier_single_contact):/;

/** What the configuration itself warrants. */
export function configWarnings(config: MonitorConfig): string[] {
  const warnings: string[] = [];
  for (const tier of config.policy.tiers) {
    if (tier.contacts.length === 1) warnings.push(`tier_single_contact:${tier.id}`);
    for (const contact of tier.contacts) if (contact.sms === null || contact.email === null) warnings.push(`contact_single_channel:${contact.id}`);
  }
  if (!config.policy.drill.enabled) warnings.push("drill_disabled");
  if (config.deliveryMode === "live" && config.heartbeatUrl === null) warnings.push("heartbeat_missing");
  const emailOnly = config.targets.components.some((component) => component.alert === "email");
  if (emailOnly && firstTierEmailContacts(config.policy).length === 0) warnings.push("email_alert_no_recipient");
  return warnings;
}

export interface RuntimeSignals {
  readonly dnsInconclusiveSince: number | null;
  readonly prunedUnexported: number;
  /** Account-level email failure codes since the last email that went out (store.emailChannelProblems). */
  readonly emailChannelProblems?: readonly string[];
  /** Account-level SMS failure codes since the last SMS confirmed delivered (store.smsChannelProblems). */
  readonly smsChannelProblems?: readonly string[];
  /** SMS that ended "unknown" in the last 24 h (store.unknownDeliveries). */
  readonly unknownDeliveries?: number;
}

/** The runtime signals as the store holds them. */
export const storeSignals = (store: {
  dnsInconclusiveSince(): number | null;
  prunedUnexported(): { readonly count: number };
  emailChannelProblems(): string[];
  smsChannelProblems(): string[];
  unknownDeliveries(now: number): number;
}, now: number): RuntimeSignals => ({
  dnsInconclusiveSince: store.dnsInconclusiveSince(), prunedUnexported: store.prunedUnexported().count,
  emailChannelProblems: store.emailChannelProblems(), smsChannelProblems: store.smsChannelProblems(), unknownDeliveries: store.unknownDeliveries(now),
});

/** What the monitor's own state warrants. */
export function runtimeWarnings(signals: RuntimeSignals, now: number): string[] {
  return [
    ...(signals.dnsInconclusiveSince !== null && now - signals.dnsInconclusiveSince >= DNS_INCONCLUSIVE_NOTICE_MS ? ["dns_inconclusive"] : []),
    ...(signals.prunedUnexported > 0 ? ["incidents_pruned_unexported"] : []),
    ...(signals.emailChannelProblems ?? []).map(emailChannelWarning),
    ...(signals.smsChannelProblems ?? []).map(smsChannelWarning),
    ...((signals.unknownDeliveries ?? 0) > 0 ? ["sms_delivery_unknown"] : []),
  ];
}

/**
 * The warnings to send or show: deduplicated, only those the platform accepts, every other warning before the
 * per-contact and per-tier advice (whatever order the lists come in), and at most MAX_WARNINGS.
 */
export function allWarnings(lists: readonly (readonly string[])[]): string[] {
  const valid = [...new Set(lists.flat())].filter((warning) => WARNING.test(warning));
  return [...valid.filter((warning) => !ROSTER_ADVICE.test(warning)), ...valid.filter((warning) => ROSTER_ADVICE.test(warning))].slice(0, MAX_WARNINGS);
}
