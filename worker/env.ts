// Bindings, vars and secrets (wrangler.jsonc lists them). Secrets are optional here because loadConfig validates
// them and refuses to run without the ones it needs.
import type { MonitorObject } from "./monitor-object.ts";

export interface Env {
  readonly MONITOR_STATE: DurableObjectNamespace<MonitorObject>;
  readonly MONITOR_TARGETS: unknown;
  readonly STATUS_PAGE_URL: string;
  readonly TWILIO_WEBHOOK_URL: string;
  /** Optional, default "Status": "[<brand>]" on every SMS and email subject, "<brand> status" on the pages (brand.ts). */
  readonly BRAND_NAME?: string;
  /** The ALERT_EMAIL binding's allowed sender; required when a contact has an email address. */
  readonly ALERT_EMAIL_FROM?: string;
  /** Optional email From name (default "<BRAND_NAME> Status"); a platform document's senders.emailFromName wins. */
  readonly ALERT_EMAIL_FROM_NAME?: string;
  readonly ESCALATION_POLICY?: string;
  /** Signs the deep check (health counts only). >= 32 bytes; must differ from MONITOR_CONFIG_KEY. */
  readonly MONITOR_HEALTH_KEY?: string;
  /** Signs the config pull and the report (contact details, report write). >= 32 bytes. */
  readonly MONITOR_CONFIG_KEY?: string;
  readonly STATUS_VIEW_KEY?: string;
  /** Cloudflare Access team domain, "<team>.cloudflareaccess.com": with ACCESS_AUD, /api/private accepts an Access sign-in (access.ts). */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience (AUD) tag, 64 hex characters. */
  readonly ACCESS_AUD?: string;
  readonly ACK_SIGNING_KEY?: string;
  readonly TWILIO_ACCOUNT_SID?: string;
  readonly TWILIO_AUTH_TOKEN?: string;
  /** Optional: also accepted for inbound webhook signatures while the auth token is being rotated. */
  readonly TWILIO_AUTH_TOKEN_SECONDARY?: string;
  readonly TWILIO_API_KEY_SID?: string;
  readonly TWILIO_API_KEY_SECRET?: string;
  readonly TWILIO_FROM?: string;
  readonly TWILIO_MESSAGING_SERVICE_SID?: string;
  readonly HEARTBEAT_URL?: string;
  /** Optional Healthchecks-style failure URL, pinged instead of HEARTBEAT_URL while paging is failing. */
  readonly HEARTBEAT_FAIL_URL?: string;
  /** Comma-separated hosts a deep check may call (default: PLATFORM_CONFIG_URL's host). */
  readonly DEEP_CHECK_HOSTS?: string;
  /** Optional second DoH JSON resolver, e.g. https://dns.google/resolve. */
  readonly DNS_SECONDARY_RESOLVER?: string;
  /**
   * Optional: where the platform-managed configuration is pulled from (https://<host>/api/v2/monitor/config). Unset
   * means standalone mode: MONITOR_TARGETS and ESCALATION_POLICY are the whole configuration, nothing is pulled or reported.
   */
  readonly PLATFORM_CONFIG_URL?: string;
  /** "live" (default) or "log": log records deliveries without contacting Twilio or sending email. */
  readonly DELIVERY_MODE?: string;
  /** "true" only under `wrangler dev`, with DELIVERY_MODE "log": skips the jurisdiction the local runtime lacks (monitor-id.ts). */
  readonly LOCAL_DEV?: string;
  /** Cloudflare Email Service send_email binding, restricted to the alert sender address (ALERT_EMAIL_FROM). */
  readonly ALERT_EMAIL?: SendEmail;
}

/** The env as a plain record for loadConfig (which takes no Workers types so it runs under the Node tests). */
export const envRecord = (env: Env): Readonly<Record<string, unknown>> => ({ ...env });
