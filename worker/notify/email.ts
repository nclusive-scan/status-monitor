// Email through Cloudflare Email Service: the Worker's send_email binding ALERT_EMAIL, restricted in wrangler.jsonc to
// one sender (allowed_sender_addresses), which ALERT_EMAIL_FROM must name. No API key or token exists for it: the
// binding is the credential. The binding throws an Error with a `code` (E_RATE_LIMIT_EXCEEDED, E_SENDER_NOT_VERIFIED, ...); only that
// code leaves this module, never the message, which can echo addresses.
//
// Message-ID is set by the platform (a header of that name is refused), so the outbox key travels in an X- header
// instead: a resend of the same outbox row is still recognisable in a mailbox.
import type { EmailSettings } from "../config.ts";
import type { DeliveryResult } from "./result.ts";

/** The part of the Workers SendEmail binding this sender uses (declared here so the Node tests need no Workers types). */
export interface EmailBinding {
  send(message: {
    from: { email: string; name: string };
    to: string;
    subject: string;
    text: string;
    headers: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** The outbox row key, sent as X-Status-Monitor-Outbox-Key. */
  readonly key: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<DeliveryResult>;
}

/** Email Service error codes worth retrying (temporary); every other code is a request or setup problem. */
export const RETRYABLE_EMAIL_CODES: readonly string[] = ["E_RATE_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"];
const SEND_TIMEOUT_MS = 20_000;

const headerSafe = (value: string): string => value.replace(/[\r\n]+/g, " ").slice(0, 200);

/** Maps a thrown binding error to a short code; an error without an Email Service code is treated as transient. */
export function emailFailure(error: unknown): DeliveryResult {
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  if (typeof code === "string" && /^E_[A-Z_]{1,48}$/.test(code)) {
    return { ok: false, retryable: RETRYABLE_EMAIL_CODES.includes(code), code: `email_${code.slice(2).toLowerCase()}` };
  }
  if (error instanceof Error && error.name === "TimeoutError") return { ok: false, retryable: true, code: "email_timeout" };
  return { ok: false, retryable: true, code: "email_error" };
}

export function createEmailSender(binding: EmailBinding, settings: EmailSettings, timeoutMs = SEND_TIMEOUT_MS): EmailSender {
  return {
    async send(message) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DOMException("email send timed out", "TimeoutError"));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([
          binding.send({
            from: { email: settings.from, name: settings.fromName },
            to: message.to,
            subject: headerSafe(message.subject),
            text: message.text,
            headers: { "Auto-Submitted": "auto-generated", "X-Status-Monitor-Outbox-Key": message.key.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 200) },
          }),
          timeout,
        ]);
        const id = typeof result.messageId === "string" ? result.messageId.replace(/[^A-Za-z0-9._@<>-]/g, "").slice(0, 64) : "";
        return { ok: true, providerId: id === "" ? "cfemail:unknown" : `cfemail:${id}` };
      } catch (error) {
        return emailFailure(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
