// Turns one claimed outbox row into a provider call. SMS and email are independent rows, so Twilio being down never
// holds up email and Email Service being down never holds up SMS; a failed row is retried with backoff by the store,
// and one that fails for good fails over and may escalate early (store.failFinally). Every Twilio send asks for status
// callbacks at STATUS_PAGE_URL/hooks/twilio-status. Notices: config_change, drill_missed, monitor_notice and
// contact_notice go by email only; channel_notice goes by SMS when alert email is failing, by email when alert SMS is.
// An email-only incident's email_alert and email_alert_resolved go by email only (email-alert.ts).
// In DELIVERY_MODE "log" nothing leaves the Worker: the row is logged (recipient masked) and marked sent as "log:...".
import { createAckToken } from "./ack.ts";
import type { MonitorConfig } from "./config.ts";
import type { EmailSender } from "./notify/email.ts";
import { twilioStatusUrl } from "./config.ts";
import { isEmailAlertKind } from "./email-alert.ts";
import {
  channelNoticeSms, configChangeEmail, contactNoticeEmail, drillMissedEmail, emailAlertContent, emailContent, monitorNoticeEmail, smsChannelNoticeEmail,
  smsText,
} from "./notify/messages.ts";
import type { ContactProblem, MessageContext } from "./notify/messages.ts";
import type { DeliveryResult } from "./notify/result.ts";
import type { SmsSender } from "./notify/sms.ts";
import { createTwilioSmsSender } from "./notify/sms.ts";
import { maskRecipient } from "./redact.ts";
import type { IncidentRow, OutboxRow } from "./store.ts";
import type { FetchLike } from "./types.ts";

export interface DeliveryDeps {
  readonly config: MonitorConfig;
  readonly fetch: FetchLike;
  /** Null when the ALERT_EMAIL binding is absent. */
  readonly email: EmailSender | null;
  /** The SMS channel; when absent, Twilio from config.twilio (null config.twilio: not configured). */
  readonly sms?: SmsSender | null;
  readonly now: number;
}

const NOTICE_KINDS = ["config_change", "drill_missed", "monitor_notice", "contact_notice", "channel_notice"] as const;
type NoticeKind = (typeof NOTICE_KINDS)[number];
const isNotice = (kind: OutboxRow["kind"]): kind is NoticeKind => NOTICE_KINDS.some((notice) => notice === kind);
const PROBLEMS: readonly ContactProblem[] = ["opted_out", "undeliverable", "suppressed"];

/** The SMS channel: deps.sms when given, else Twilio from the config (asking for status callbacks), else null. */
function smsSender(deps: DeliveryDeps): SmsSender | null {
  if (deps.sms !== undefined) return deps.sms;
  return deps.config.twilio === null ? null : createTwilioSmsSender(deps.config.twilio, deps.fetch, twilioStatusUrl(deps.config.statusPageUrl));
}

function sendSmsText(row: OutboxRow, deps: DeliveryDeps, body: string): Promise<DeliveryResult> {
  if (deps.config.deliveryMode === "log") return Promise.resolve(logged(row));
  const sms = smsSender(deps);
  if (sms === null) return Promise.resolve({ ok: false, retryable: false, code: "twilio_not_configured" });
  return sms.send({ to: row.recipient, body, key: row.key });
}

export async function messageContext(
  row: OutboxRow,
  incident: IncidentRow,
  deps: DeliveryDeps,
  alsoAffected: readonly string[] = [],
): Promise<MessageContext> {
  const { config, now } = deps;
  const nameOf = (id: string): string => config.targets.components.find((component) => component.id === id)?.name ?? id;
  const componentName = nameOf(incident.componentId);
  const expires = now + config.policy.ackLinkTtlMinutes * 60_000;
  const ackUrl = row.channel === "email"
    ? `${config.statusPageUrl}/ack/${await createAckToken(config.ackSigningKey, incident.id, row.contactId, expires)}`
    : null;
  // Notice and email-alert rows never reach here (deliver routes them first), so the kind is always an escalation send.
  const kind = isNotice(row.kind) || isEmailAlertKind(row.kind) ? "page" : row.kind;
  return {
    brand: config.brandName, kind, componentName, incidentTitle: incident.title, openedAt: incident.openedAt, ackCode: incident.ackCode,
    statusPageUrl: config.statusPageUrl, cycle: row.cycle, maxCycles: config.policy.maxCycles, targetTierName: row.target?.tierName ?? null,
    targetContactNames: row.target?.contactNames ?? [], acknowledgedBy: row.acknowledgedBy, now, ackUrl,
    alsoAffected: alsoAffected.map(nameOf), closeReason: incident.closeReason, drill: incident.drill, timeZone: config.policy.timeZone,
  };
}

function logged(row: OutboxRow): DeliveryResult {
  console.log(JSON.stringify({ event: "delivery_logged", key: row.key, kind: row.kind, channel: row.channel, to: maskRecipient(row.channel, row.recipient) }));
  return { ok: true, providerId: `log:${row.channel}` };
}

function sendEmail(row: OutboxRow, deps: DeliveryDeps, content: { subject: string; text: string }): Promise<DeliveryResult> {
  if (deps.config.deliveryMode === "log") return Promise.resolve(logged(row));
  if (deps.email === null) return Promise.resolve({ ok: false, retryable: false, code: "email_not_configured" });
  return deps.email.send({ to: row.recipient, subject: content.subject, text: content.text, key: row.key });
}

export async function deliver(
  row: OutboxRow,
  incident: IncidentRow | null,
  deps: DeliveryDeps,
  alsoAffected: readonly string[] = [],
): Promise<DeliveryResult> {
  if (row.kind === "config_change") {
    // Informational and email only: a config change never pages.
    if (row.channel !== "email" || row.configChange === null) return { ok: false, retryable: false, code: "config_notice_invalid" };
    return sendEmail(row, deps, configChangeEmail(row.configChange, deps.config.brandName));
  }
  if (row.kind === "monitor_notice" || row.kind === "drill_missed") {
    // Informational, email only, to the first tier.
    if (row.channel !== "email" || row.detail === null) return { ok: false, retryable: false, code: "notice_invalid" };
    const { brandName } = deps.config;
    return sendEmail(row, deps, row.kind === "drill_missed" ? drillMissedEmail(row.detail, brandName) : monitorNoticeEmail(row.detail, brandName));
  }
  if (row.kind === "contact_notice") {
    // Informational, email only: a contact's channel stopped working (opted out, undeliverable, suppressed).
    const [problem, self] = (row.detail ?? "").split(":");
    const known = PROBLEMS.find((item) => item === problem);
    if (row.channel !== "email" || known === undefined) return { ok: false, retryable: false, code: "notice_invalid" };
    return sendEmail(row, deps, contactNoticeEmail(known, row.about ?? "A contact", self === "self", deps.config.brandName));
  }
  if (row.kind === "channel_notice") {
    // One channel is failing account-wide: the first tier hears of it on the other one.
    if (row.detail === null) return { ok: false, retryable: false, code: "notice_invalid" };
    if (row.channel === "sms") return sendSmsText(row, deps, channelNoticeSms(row.detail, deps.config.statusPageUrl, deps.config.brandName));
    return sendEmail(row, deps, smsChannelNoticeEmail(row.detail, deps.config.brandName));
  }
  if (incident === null) return { ok: false, retryable: false, code: "incident_missing" };
  if (isEmailAlertKind(row.kind)) {
    // Informational and email only: an email-only incident never sends SMS and asks nobody to acknowledge.
    if (row.channel !== "email") return { ok: false, retryable: false, code: "notice_invalid" };
    const { config, now } = deps;
    const componentName = config.targets.components.find((item) => item.id === incident.componentId)?.name ?? incident.componentId;
    return sendEmail(row, deps, emailAlertContent({
      brand: config.brandName, opened: row.kind === "email_alert", componentName,
      incidentTitle: incident.title, openedAt: incident.openedAt, now, statusPageUrl: config.statusPageUrl, closeReason: incident.closeReason,
      timeZone: config.policy.timeZone,
    }));
  }
  const context = await messageContext(row, incident, deps, alsoAffected);
  if (row.channel === "sms") return sendSmsText(row, deps, smsText(context));
  return sendEmail(row, deps, emailContent(context));
}
