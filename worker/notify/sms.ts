// The SMS channel as the delivery code sees it: one interface, whatever the provider. Twilio is the only
// implementation today (twilio.ts: StatusCallback, ValidityPeriod and error-code parsing). A second provider would go
// behind this interface without touching deliver.ts.
import type { TwilioSettings } from "../config.ts";
import type { FetchLike } from "../types.ts";
import type { DeliveryResult } from "./result.ts";
import { sendSms } from "./twilio.ts";

export interface SmsMessage {
  readonly to: string;
  readonly body: string;
  /** The outbox row key (stable per send): for provider-side de-duplication or logging, never sent to the recipient. */
  readonly key: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<DeliveryResult>;
}

/** `statusCallbackUrl`: where Twilio posts delivery status changes (null: no callback, e.g. in tests). */
export function createTwilioSmsSender(settings: TwilioSettings, fetch: FetchLike, statusCallbackUrl: string | null = null): SmsSender {
  return { send: (message) => sendSms(settings, message.to, message.body, fetch, statusCallbackUrl) };
}
