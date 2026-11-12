// The monitor configuration's types and shared constants (config.ts loads and validates it, config-parse.ts parses
// the targets, policy and senders sections). config.ts re-exports everything public here.
import type { DrillSchedule } from "./drill.ts";
import type { MaintenanceWindow } from "./maintenance.ts";
import type { Status } from "./types.ts";

/**
 * How a component's incidents notify: "page" (SMS and email with acknowledgement and escalation), "email" (one
 * informational email to the first tier's email contacts when it opens and one when it resolves; never SMS, never
 * escalated) or "none" (recorded and shown privately, nobody notified).
 */
export type AlertMode = "page" | "email" | "none";
export const ALERT_MODES: readonly AlertMode[] = ["page", "email", "none"];

export interface ComponentConfig {
  readonly id: string;
  readonly name: string;
  /** The status at or above which a run counts as failing (and so can open an incident). */
  readonly pageOn: Exclude<Status, "ok">;
  /** Default "page". */
  readonly alert: AlertMode;
  /** Shown on the public status page (/api/status). Default true; false keeps it to the private view and reports. */
  readonly public: boolean;
}

interface CheckBase {
  readonly id: string;
  readonly component: string;
  readonly timeoutMs: number;
}

export interface HttpCheckConfig extends CheckBase {
  readonly type: "http";
  readonly url: string;
  readonly method: "GET" | "HEAD";
  readonly expectStatus: { readonly min: number; readonly max: number };
  readonly maxRedirects: number;
  readonly bodyIncludes: string | null;
  readonly latencyDegradedMs: number;
}

export interface DnsCheckConfig extends CheckBase {
  readonly type: "dns";
  readonly hostname: string;
  /** The host must be DNS-only (grey cloud): no A/AAAA answer may sit inside Cloudflare's proxy ranges. */
  readonly dnsOnly: boolean;
}

export interface DeepCheckConfig extends CheckBase {
  readonly type: "deep";
  readonly url: string;
  readonly latencyDegradedMs: number;
  /** Deep sub-check id -> component id. Unmapped sub-checks count toward this check's own component. */
  readonly componentMap: Readonly<Record<string, string>>;
}

export type CheckConfig = HttpCheckConfig | DnsCheckConfig | DeepCheckConfig;

export interface TargetsConfig {
  readonly version: 1;
  readonly openAfterFailures: number;
  readonly resolveAfterPasses: number;
  readonly components: readonly ComponentConfig[];
  readonly checks: readonly CheckConfig[];
}

export interface Contact {
  readonly id: string;
  readonly name: string;
  readonly sms: string | null;
  readonly email: string | null;
}

export interface Tier {
  readonly id: string;
  readonly name: string;
  readonly ackTimeoutMinutes: number;
  readonly contacts: readonly Contact[];
}

export interface EscalationPolicy {
  readonly version: 1;
  readonly maxCycles: number;
  readonly ackLinkTtlMinutes: number;
  /** IANA zone for message times and the drill schedule (default "UTC"). */
  readonly timeZone: string;
  /** While an incident is exhausted and unresolved, remind everyone on every channel this often; 0 is off (default 60). */
  readonly reminderMinutes: number;
  readonly drill: DrillSchedule;
  readonly tiers: readonly Tier[];
}

export interface TwilioSettings {
  readonly accountSid: string;
  /** Basic auth user: an API key SID (SK...) or the Account SID. */
  readonly username: string;
  readonly password: string;
  /** Validates X-Twilio-Signature on the inbound webhooks (Twilio signs with the auth token, never an API key). */
  readonly authToken: string;
  /**
   * TWILIO_AUTH_TOKEN_SECONDARY, optional: also accepted for webhook signatures during an auth-token rotation.
   * Twilio signs with the primary token until the secondary is promoted; holding both covers the moment of promotion.
   */
  readonly authTokenSecondary: string | null;
  readonly from: string | null;
  readonly messagingServiceSid: string | null;
}

/** The sender identity of alert email (Cloudflare Email Service, the ALERT_EMAIL send_email binding). */
export interface EmailSettings {
  readonly from: string;
  readonly fromName: string;
}

/**
 * Sender identities from the platform document. Both SMS fields null means the env TWILIO_FROM /
 * TWILIO_MESSAGING_SERVICE_SID. emailFrom, when set, equals ALERT_EMAIL_FROM (the only address the binding may send
 * from); null means ALERT_EMAIL_FROM. emailFromName null means ALERT_EMAIL_FROM_NAME or its default.
 */
export interface Senders {
  readonly smsFrom: string | null;
  readonly smsMessagingServiceSid: string | null;
  readonly emailFrom: string | null;
  readonly emailFromName: string | null;
}

/** "log" records every delivery in the outbox without contacting Twilio or sending email (local development). */
export type DeliveryMode = "live" | "log";

/**
 * "standalone" (PLATFORM_CONFIG_URL unset): the env settings are the whole configuration; nothing is pulled or reported.
 * "platform": the configuration is pulled from PLATFORM_CONFIG_URL and the monitor reports back to its origin.
 */
export type MonitorMode = "standalone" | "platform";

/** Where the policy and targets came from: a stored platform revision (last known good) or the env bootstrap. */
export type ConfigSource = { readonly kind: "platform"; readonly revision: number } | { readonly kind: "bootstrap" };

/** The validated sections of a stored platform revision; a null section falls back to the env bootstrap. */
export interface PlatformSections {
  readonly revision: number;
  readonly policy: EscalationPolicy | null;
  readonly targets: TargetsConfig | null;
  readonly senders: Senders | null;
  /** Maintenance windows (empty on the bootstrap and at revision 0). */
  readonly maintenance: readonly MaintenanceWindow[];
}

export interface MonitorConfig {
  /** BRAND_NAME (default "Status"): the "[<brand>]" prefix of every SMS and email subject, and the pages' title. */
  readonly brandName: string;
  readonly mode: MonitorMode;
  readonly targets: TargetsConfig;
  readonly policy: EscalationPolicy;
  readonly maintenance: readonly MaintenanceWindow[];
  readonly statusPageUrl: string;
  readonly twilioWebhookUrl: string;
  /** MONITOR_HEALTH_KEY: signs the deep check only (it can read the health counts and nothing else). */
  readonly healthKey: string | null;
  /** MONITOR_CONFIG_KEY: signs the config pull and the report (it reads contacts and writes the report). */
  readonly configKey: string | null;
  readonly ackSigningKey: string;
  readonly twilio: TwilioSettings | null;
  /** Null when the ALERT_EMAIL binding or ALERT_EMAIL_FROM is absent. */
  readonly email: EmailSettings | null;
  readonly heartbeatUrl: string | null;
  /** Optional Healthchecks-style failure URL, pinged instead of heartbeatUrl while paging is failing. */
  readonly heartbeatFailUrl: string | null;
  /** Optional second DNS-over-HTTPS resolver (JSON API), tried when the first one fails. */
  readonly dnsSecondaryResolver: string | null;
  readonly deliveryMode: DeliveryMode;
  readonly source: ConfigSource;
}

export type ConfigResult = { readonly ok: true; readonly config: MonitorConfig } | { readonly ok: false; readonly errors: readonly string[] };

export const MIN_KEY_BYTES = 32;
/** Limits a platform's validator must share (spec/PROTOCOL.md, "The configuration document"); keep both identical. */
export const LIMITS = Object.freeze({
  labelChars: 60,
  textChars: 2048,
  urlChars: 2048,
  timeZoneChars: 64,
  reminderMinutes: [15, 1440, 60],
} as const);
export const DEEP_PATH = "/api/v2/monitor/health";
/** Twilio's delivery status callback, on the status page (forwarded to the monitor at the same path). */
export const TWILIO_STATUS_PATH = "/hooks/twilio-status";
/** The exact public URL Twilio posts status callbacks to and signs: STATUS_PAGE_URL + /hooks/twilio-status. */
export const twilioStatusUrl = (statusPageUrl: string): string => `${statusPageUrl.replace(/\/$/, "")}${TWILIO_STATUS_PATH}`;
export const CONFIG_PATH = "/api/v2/monitor/config";
/** The longest email From name (ALERT_EMAIL_FROM_NAME, senders.emailFromName). */
export const EMAIL_FROM_NAME_MAX_CHARS = 60;
export const ID = /^[a-z][a-z0-9_]{0,47}$/;
export const E164 = /^\+[1-9]\d{6,14}$/;
export const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/;
export const EMAIL = /^[^\s@<>"',;\r\n]+@[^\s@<>"',;\r\n]+\.[A-Za-z]{2,}$/;
export const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// What JSON can carry but a database text column (and a sane message) cannot: U+0000 and a UTF-16 surrogate without
// its pair. Refused in every string of a document, keys included (the platform refuses the same).
export const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
// Control characters and the Unicode line and paragraph separators: a label is one printable line.
const NOT_PLAIN = /[\p{Cc}\u2028\u2029]/u;

/** True for a string that is one printable line (no control characters or line breaks, no unpaired surrogates). */
export const isPlainLine = (value: string): boolean => !NOT_PLAIN.test(value) && !UNSTORABLE.test(value);
