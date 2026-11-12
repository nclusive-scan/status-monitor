// SMS through the Twilio Messages REST API: POST /2010-04-01/Accounts/{AccountSid}/Messages.json, form encoded,
// HTTP Basic auth (API key SID + secret, or Account SID + auth token), From number or MessagingServiceSid.
//
// Every send asks for delivery confirmation: StatusCallback names the status page's /hooks/twilio-status, where
// Twilio posts each status change (queued, sent, delivered, undelivered, failed) with an ErrorCode on failure; a 201
// only means queued. ValidityPeriod=600 makes Twilio drop a page it could not hand to a carrier within 10 minutes
// instead of the default 10 hours: a page that late is worse than a failed one, which fails over and escalates.
//
// A refused send (4xx) carries a JSON error body. Only its integer `code` is read
// (https://www.twilio.com/docs/usage/twilios-response); the message, which can echo the number or the text, never is.
import { readCapped } from "../body.ts";
import type { TwilioSettings } from "../config.ts";
import { base64, utf8 } from "../crypto.ts";
import type { FetchLike } from "../types.ts";
import { isRecord } from "../types.ts";
import type { DeliveryResult } from "./result.ts";
import { failure, thrown } from "./result.ts";

/** Seconds Twilio may hold a message in its queue before giving up on it. */
export const VALIDITY_PERIOD_S = 600;
export const SEND_TIMEOUT_MS = 15_000;
/** An error body is read up to this many bytes; a larger one is abandoned (the stream cancelled) unparsed. */
const MAX_ERROR_BYTES = 4096;

/** Twilio error codes with a meaning of their own here (https://www.twilio.com/docs/api/errors). */
export const TWILIO_CODES: Readonly<Record<number, string>> = {
  21610: "twilio_recipient_opted_out",
  21211: "twilio_invalid_number",
  21614: "twilio_not_sms_capable",
  21408: "twilio_region_not_enabled",
};

/** The delivery code for a Twilio error code: a named one, or twilio_<code>. */
export const twilioCode = (code: number): string => TWILIO_CODES[code] ?? `twilio_${String(code)}`;

export const twilioMessagesUrl = (accountSid: string): string =>
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;

export function twilioRequest(settings: TwilioSettings, to: string, body: string, statusCallbackUrl: string | null = null): { url: string; init: RequestInit } {
  const form = new URLSearchParams({ To: to, Body: body, ValidityPeriod: String(VALIDITY_PERIOD_S) });
  if (settings.messagingServiceSid !== null) form.set("MessagingServiceSid", settings.messagingServiceSid);
  else if (settings.from !== null) form.set("From", settings.from);
  if (statusCallbackUrl !== null) form.set("StatusCallback", statusCallbackUrl);
  return {
    url: twilioMessagesUrl(settings.accountSid),
    init: {
      method: "POST",
      headers: {
        authorization: `Basic ${base64(utf8(`${settings.username}:${settings.password}`))}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      // Created here, inside the delivery limiter's slot (deliver runs within it), so it times the request itself.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    },
  };
}

/**
 * The integer `code` of a Twilio error body, or null (no body, not JSON, too large, no integer code). Read through a
 * byte cap, so a body without a Content-Length (chunked, compressed) is never buffered whole.
 */
export async function twilioErrorCode(response: Response): Promise<number | null> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ERROR_BYTES) {
    await response.body?.cancel();
    return null;
  }
  let text: string | null;
  try {
    text = await readCapped(response, MAX_ERROR_BYTES);
  } catch {
    return null;
  }
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const code = isRecord(parsed) ? parsed["code"] : null;
  return typeof code === "number" && Number.isInteger(code) && code > 0 && code < 1_000_000 ? code : null;
}

export async function sendSms(
  settings: TwilioSettings,
  to: string,
  body: string,
  fetch: FetchLike,
  statusCallbackUrl: string | null = null,
): Promise<DeliveryResult> {
  const { url, init } = twilioRequest(settings, to, body, statusCallbackUrl);
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return thrown("twilio", error);
  }
  if (!response.ok) {
    const generic = failure("twilio", response.status);
    if (response.status < 400 || response.status >= 500) {
      await response.body?.cancel();
      return generic;
    }
    const code = await twilioErrorCode(response);
    return code === null || generic.ok ? generic : { ok: false, retryable: generic.retryable, code: twilioCode(code) };
  }
  const answer: unknown = await response.json().catch(() => null);
  const sid = isRecord(answer) ? answer["sid"] : null;
  return typeof sid === "string" && /^(?:SM|MM)[0-9a-f]{32}$/.test(sid) ? { ok: true, providerId: sid } : { ok: true, providerId: "twilio:unknown" };
}
