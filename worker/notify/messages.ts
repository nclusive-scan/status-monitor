// Message text. Short, no secrets, no internal URLs or error bodies: the component's public name, what happened,
// how to acknowledge, and the status page link. Email adds a per-recipient acknowledgement link.
//
// SMS: the first line carries what a responder needs to act, the headline, the ACK code and the short status link;
// the detail follows on the next line and is what gets cut when the text would exceed two segments (sms-text.ts).
// Times read in policy.timeZone with UTC after them, "03:12 EST (08:12 UTC)"; storage stays UTC.
//
// Every message is signed with the brand (BRAND_NAME, brand.ts): "[<brand>]" leads each SMS and email subject, and
// "Sent by the <brand> status monitor." closes each email.
import { withNoun } from "../brand.ts";
import type { SendKind } from "../escalation.ts";
import { formatAlertTime } from "../time.ts";
import { composeSms } from "./sms-text.ts";

export interface MessageContext {
  /** BRAND_NAME (config.brandName). */
  readonly brand: string;
  readonly kind: SendKind;
  readonly componentName: string;
  readonly incidentTitle: string;
  readonly openedAt: number;
  readonly ackCode: string;
  readonly statusPageUrl: string;
  readonly cycle: number;
  readonly maxCycles: number;
  readonly targetTierName: string | null;
  readonly targetContactNames: readonly string[];
  readonly acknowledgedBy: string | null;
  readonly now: number;
  /** Email only. */
  readonly ackUrl: string | null;
  /** Public names of the other components still open in this incident's group (one escalation for all of them). */
  readonly alsoAffected?: readonly string[];
  /** Why a resolved incident closed: "recovered" (default) or "component_removed". */
  readonly closeReason?: string | null;
  /** A weekly drill page: "[TEST]", asks only for an acknowledgement. */
  readonly drill?: boolean;
  /** policy.timeZone (IANA); message times are local with UTC in parentheses. Default "UTC". */
  readonly timeZone?: string;
}

/** "[<brand>]": the start of every SMS and email subject. */
export const brandPrefix = (brand: string): string => `[${brand}]`;
/** The closing line of every email: "Sent by the <brand> status monitor." plus any extra sentence. */
const signature = (brand: string, extra = ""): string => `Sent by the ${withNoun(brand, "status")} monitor.${extra === "" ? "" : ` ${extra}`}`;
const minutes = (ms: number): string => `${String(Math.max(1, Math.round(ms / 60000)))} min`;
const names = (list: readonly string[]): string => (list.length === 0 ? "nobody" : list.join(", "));
const SHOWN_NAMES = 6;
const shortList = (list: readonly string[]): string =>
  list.length <= SHOWN_NAMES ? list.join(", ") : `${list.slice(0, SHOWN_NAMES).join(", ")} and ${String(list.length - SHOWN_NAMES)} more`;

/** The status page link without its scheme: phones still link it, and it costs fewer characters. */
export const shortUrl = (url: string): string => url.replace(/^https:\/\//, "").replace(/\/$/, "");

interface Lines {
  readonly headline: string;
  /** The acknowledgement instruction ("Reply ACK K7M2QX to acknowledge"), or null when nothing is asked. */
  readonly ack: string | null;
  readonly detail: string;
}

function lines(context: MessageContext): Lines {
  const others = context.alsoAffected ?? [];
  const component = others.length === 0 ? context.componentName : `${context.componentName} +${String(others.length)}`;
  const { ackCode } = context;
  const at = (ms: number): string => formatAlertTime(ms, context.timeZone ?? "UTC");
  const reply = `Reply ACK ${ackCode} ${others.length === 0 ? "to acknowledge" : `to acknowledge all ${String(others.length + 1)}`}`;
  const also = others.length === 0 ? "" : ` Also affected: ${shortList(others)}.`;
  const target = `${context.targetTierName ?? "next tier"} (${names(context.targetContactNames)})`;
  const cycleNote = context.cycle > 1 ? ` [cycle ${String(context.cycle)}/${String(context.maxCycles)}]` : "";
  if (context.drill === true) {
    return context.kind === "page"
      ? { headline: "[TEST] Weekly paging drill", ack: `Reply ACK ${ackCode} to confirm pages reach you`, detail: "Nothing is down." }
      : { headline: "[TEST] Weekly paging drill", ack: null, detail: "Drill closed." };
  }
  switch (context.kind) {
    case "page":
      return { headline: `DOWN: ${component}${cycleNote}`, ack: reply, detail: `${context.incidentTitle} since ${at(context.openedAt)}.${also}` };
    case "escalation_notice":
      return {
        headline: `UNACKNOWLEDGED: ${component}`, ack: reply,
        detail: `Still unacknowledged after ${minutes(context.now - context.openedAt)}.${also} Now paging ${target}.`,
      };
    case "cycle_notice":
      return { headline: `UNACKNOWLEDGED: ${component}${cycleNote}`, ack: reply, detail: `No tier acknowledged.${also} Starting over at ${target}.` };
    case "exhausted":
      return {
        headline: `UNACKNOWLEDGED after ${String(context.maxCycles)} cycles: ${component}`, ack: reply,
        detail: `Paging has stopped; the incident is still open. Down since ${at(context.openedAt)}.${also}`,
      };
    case "reminder":
      return {
        headline: `STILL UNACKNOWLEDGED: ${component}`, ack: reply,
        detail: `Open for ${minutes(context.now - context.openedAt)}; paging stopped after ${String(context.maxCycles)} cycles.${also}`,
      };
    case "acknowledged":
      return { headline: `ACKNOWLEDGED: ${component}`, ack: null, detail: `Acknowledged by ${context.acknowledgedBy ?? "someone"}.${also} Paging stopped.` };
    case "resolved": {
      const closed = context.closeReason === "component_removed"
        ? "Closed: no longer monitored (removed from the configuration)."
        : `Recovered after ${minutes(context.now - context.openedAt)}.`;
      const still = others.length === 0 ? "" : ` Still affected: ${shortList(others)}.`;
      return { headline: `RESOLVED: ${context.componentName}`, ack: null, detail: `${closed}${still}` };
    }
  }
}

/**
 * The SMS: "[<brand>] <headline>. Reply ACK <code> .... <status link>" on the first line, the detail on the second,
 * GSM-7 friendly and at most two segments (the detail is cut first).
 */
export function smsText(context: MessageContext): string {
  const { headline, ack, detail } = lines(context);
  const keep = `${ack === null ? "" : `${ack}. `}${shortUrl(context.statusPageUrl)}`;
  return composeSms(`${brandPrefix(context.brand)} ${headline}.`, keep, detail);
}

export function emailContent(context: MessageContext): { subject: string; text: string } {
  const { headline, ack, detail } = lines(context);
  const action = ack !== null;
  const text = [
    action ? `${detail} ${ack} by SMS, or use the link below.` : detail,
    "",
    ...(action && context.ackUrl !== null
      ? [context.drill === true
        ? "Acknowledge (opens a confirmation page):"
        : "Acknowledge (opens a confirmation page; the same page can escalate to the next tier now):", context.ackUrl, ""]
      : []),
    `Status: ${context.statusPageUrl}`,
    "",
    signature(context.brand),
  ].join("\n");
  return { subject: `${brandPrefix(context.brand)} ${headline}`, text };
}

/** What an email-only alert (a component with alert "email") says; see email-alert.ts. */
export interface EmailAlertContext {
  readonly brand: string;
  readonly opened: boolean;
  readonly componentName: string;
  readonly incidentTitle: string;
  readonly openedAt: number;
  readonly now: number;
  readonly statusPageUrl: string;
  readonly closeReason: string | null;
  readonly timeZone: string;
}

/**
 * The email-only alert: informational, no acknowledgement and no escalation. The status link goes to the operator view,
 * since a component that alerts by email is usually not on the public page.
 */
export function emailAlertContent(context: EmailAlertContext): { subject: string; text: string } {
  const detail = context.opened
    ? `${context.incidentTitle} since ${formatAlertTime(context.openedAt, context.timeZone)}. `
      + "Nothing to acknowledge; you will get one more email when it recovers."
    : context.closeReason === "component_removed"
    ? "Closed: no longer monitored (removed from the configuration)."
    : `Recovered after ${minutes(context.now - context.openedAt)}.`;
  const footer = signature(context.brand, "This is not a page.");
  const text = [detail, "", `Details: the operator view of ${context.statusPageUrl}`, "", footer].join("\n");
  return { subject: `${brandPrefix(context.brand)} ${context.opened ? context.incidentTitle : `RESOLVED: ${context.componentName}`}`, text };
}

/** The drill-missed notice to the first tier (email only): the contact did not acknowledge the weekly test page. */
export function drillMissedEmail(contactName: string, brand: string): { subject: string; text: string } {
  const text = [
    `${contactName} did not acknowledge this week's test page in time.`,
    "",
    "Real pages may not be reaching them. Check their mobile number and email address in the escalation policy,",
    "and that their phone lets alert texts through.",
    "",
    signature(brand, "Nothing is down."),
  ].join("\n");
  return { subject: `${brandPrefix(brand)} [TEST] Drill missed`, text };
}

const NOTICES: Readonly<Record<string, string>> = {
  dns_inconclusive: "The monitor's DNS resolver has failed for over 15 minutes, so DNS checks prove nothing either way. HTTP checks still run.",
};

/** A monitor-health notice (email only, never a page) to the first tier. */
export function monitorNoticeEmail(code: string, brand: string): { subject: string; text: string } {
  const text = [
    NOTICES[code] ?? `Monitor health notice: ${code}.`,
    "",
    "See the operator view of the status page for details.",
    "",
    signature(brand),
  ].join("\n");
  return { subject: `${brandPrefix(brand)} Monitor health notice`, text };
}

/** Contact-health problems that warrant telling people (contact health states other than ok and drill_missed). */
export type ContactProblem = "opted_out" | "undeliverable" | "suppressed";

/**
 * A contact-health notice (email, never a page) to the first tier's email contacts, and for an SMS opt-out also to the
 * contact's own email address (`toSelf`). Names only, never numbers or addresses.
 */
export function contactNoticeEmail(problem: ContactProblem, contactName: string, toSelf: boolean, brand: string): { subject: string; text: string } {
  const body: Record<ContactProblem, { subject: string; lines: string[] }> = {
    opted_out: {
      subject: `Opted out of texts: ${contactName}`,
      lines: toSelf
        ? [
          "You replied STOP (or another opt-out word) to the alert number, so every alert text to you is now blocked, real pages included.",
          "To get pages by text again, text START to the number that sends the alerts.",
        ]
        : [
          `${contactName} replied STOP (or another opt-out word) to the alert number, or Twilio reports the number as opted out.`,
          "They get no SMS pages until they text START to the alert number. Email pages still reach them if they have an email address.",
        ],
    },
    undeliverable: {
      subject: `Texts are not reaching ${contactName}`,
      lines: [
        `Alert texts to ${contactName}'s mobile number are refused (not a valid or SMS-capable mobile number, or not reachable).`,
        "Check the number in the escalation policy.",
      ],
    },
    suppressed: {
      subject: `Alert email is not reaching ${contactName}`,
      lines: [
        `Email Service refuses to send to ${contactName}'s address: it is on the suppression list (an earlier bounce or spam complaint).`,
        "Pages still go to their mobile number if they have one. Check the address, then remove it from the Email Service suppression list.",
      ],
    },
  };
  const { subject, lines: text } = body[problem];
  return { subject: `${brandPrefix(brand)} ${subject}`, text: [...text, "", signature(brand, "This is not a page.")].join("\n") };
}

/**
 * The channel-health alert, by SMS to the first tier when alert email itself is failing for an account-level
 * reason (suspended, daily limit, sender not verified, sending domain unavailable). At most once an hour per code.
 */
export function channelNoticeSms(code: string, statusPageUrl: string, brand: string): string {
  return composeSms(`${brandPrefix(brand)} Alert email is failing (${code}).`, shortUrl(statusPageUrl),
    "Pages still go by SMS. Check Cloudflare Email Service for the account. This is not a page.");
}

/**
 * The channel-health alert for SMS, by email to the first tier when alert texts fail for everyone (bad Twilio
 * credentials, a sender the account cannot use, unregistered 10DLC or toll-free). At most once an hour per code.
 */
export function smsChannelNoticeEmail(code: string, brand: string): { subject: string; text: string } {
  const text = [
    `Alert texts are failing for every contact (${code}).`,
    "",
    "Pages still go by email to contacts who have an address; contacts with only a mobile number are not reached.",
    "Check the Twilio account: its credentials, the sending number or Messaging Service, and its 10DLC or toll-free",
    "registration.",
    "",
    signature(brand, "This is not a page."),
  ].join("\n");
  return { subject: `${brandPrefix(brand)} Alert texts are failing`, text };
}

/** What a config-change notice says (contact names only, never numbers or addresses). */
export interface ConfigChangeContext {
  readonly revision: number;
  readonly updatedBy: string | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/**
 * The informational tamper signal sent when an accepted platform revision changes who gets paged. It goes by email
 * only, to every email contact of the old and the new policy, and asks nobody to acknowledge anything.
 */
export function configChangeEmail(change: ConfigChangeContext, brand: string): { subject: string; text: string } {
  const revision = String(change.revision);
  const listed = (label: string, list: readonly string[]): string[] => (list.length === 0 ? [] : [`${label}: ${list.join(", ")}`]);
  const text = [
    `The status monitor's alert contacts changed in configuration revision ${revision}, saved by ${change.updatedBy ?? "an unknown editor"}.`,
    "",
    ...listed("Added", change.added),
    ...listed("Removed", change.removed),
    ...listed("Changed", change.changed),
    "",
    "You get this because you are an email contact in the previous or the new configuration. It is informational: nobody is being paged.",
    "If you did not expect this change, check the configuration's revision history on the platform that serves it.",
    "",
    signature(brand),
  ].join("\n");
  return { subject: `${brandPrefix(brand)} Alert contacts changed (revision ${revision})`, text };
}
