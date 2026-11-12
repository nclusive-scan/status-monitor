// Typed load and validation of the monitor's configuration. Any problem is fatal: loadConfig returns the list of
// problems and the caller runs nothing (no checks, no pages, no heartbeat), so the external dead-man's switch fires
// instead of the monitor running half-configured. See README "Failure modes".
import { brandNameProblem, DEFAULT_BRAND_NAME, withNoun } from "./brand.ts";
import { byteLength } from "./crypto.ts";
import type {
  ConfigResult, ConfigSource, DeliveryMode, EmailSettings, MonitorMode, PlatformSections, Senders, TargetsConfig, TwilioSettings,
} from "./config-types.ts";
import { CONFIG_PATH, E164, EMAIL, MESSAGING_SERVICE_SID, MIN_KEY_BYTES } from "./config-types.ts";
import { httpsUrl, isEmailFromName, parsePolicy, parseTargets, Problems } from "./config-parse.ts";

const text = (env: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

/**
 * A signing key, used byte for byte as stored (never trimmed): the platform reads its copy untrimmed, so a trimmed key
 * would sign with different bytes whenever the secret was stored with a trailing newline. A key with surrounding
 * whitespace is refused outright, so that mistake shows as a config error, not as signed requests being refused.
 */
export function keyOf(env: Readonly<Record<string, unknown>>, name: string, problems: Problems): string | null {
  const raw = env[name];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw;
  if (value !== value.trim()) problems.add(name, "has leading or trailing whitespace (store it without a newline, e.g. with printf)");
  if (byteLength(value) < MIN_KEY_BYTES) problems.add(name, `must be at least ${String(MIN_KEY_BYTES)} bytes`);
  return value;
}

/**
 * MONITOR_HEALTH_KEY and MONITOR_CONFIG_KEY. They have separate purposes (a leaked health key reads only counts; the
 * config key reads contact details and writes reports), so the Worker refuses to run with the same value in both.
 */
export function signingKeys(env: Readonly<Record<string, unknown>>, problems: Problems): { readonly health: string | null; readonly config: string | null } {
  const health = keyOf(env, "MONITOR_HEALTH_KEY", problems);
  const config = keyOf(env, "MONITOR_CONFIG_KEY", problems);
  if (health !== null && config !== null && health === config) problems.add("MONITOR_CONFIG_KEY", "must differ from MONITOR_HEALTH_KEY");
  return { health, config };
}

/**
 * "platform" when PLATFORM_CONFIG_URL is set (even to an unusable value, which the pull then records as
 * config_url_invalid), otherwise "standalone": the env settings are the whole configuration, nothing is pulled and no
 * report is sent.
 */
export function monitorMode(env: Readonly<Record<string, unknown>>): MonitorMode {
  return text(env, "PLATFORM_CONFIG_URL") === null ? "standalone" : "platform";
}

/**
 * PLATFORM_CONFIG_URL, or null when it is unset (standalone) or not an https URL of exactly the config path with no
 * query. The report goes to the same origin, and its host is the default deep-check host.
 */
export function platformConfigUrl(env: Readonly<Record<string, unknown>>): string | null {
  const raw = text(env, "PLATFORM_CONFIG_URL");
  if (raw === null) return null;
  const problems = new Problems();
  const url = httpsUrl(raw, "PLATFORM_CONFIG_URL", problems);
  if (problems.list.length > 0 || new URL(url).pathname !== CONFIG_PATH || raw.includes("?") || raw.includes("#")) return null;
  return url;
}

// A host name of at most 253 characters with at least one dot and a letter TLD (a single-label name such as "localhost"
// or "intranet" is no host a Cloudflare Worker can call), and an optional port.
const AUTHORITY = /^(?=[^:]{1,253}(?::|$))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/;

/**
 * "host[:port]" as URL.host spells it (and as a protocol server reads its allowed authorities, spec/PROTOCOL.md):
 * lowercase, the default port :443 dropped. Null when it is not a host name with an optional port, or is a single label.
 */
export function canonicalAuthority(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (!AUTHORITY.test(lower)) return null;
  const [host = "", port] = lower.split(":");
  if (port === undefined || port === "443") return host;
  return Number(port) >= 1 && Number(port) <= 65535 && !port.startsWith("0") ? `${host}:${port}` : null;
}

/**
 * The hosts a deep check may call (DEEP_CHECK_HOSTS, comma-separated "host" or "host:port"; default the host of
 * PLATFORM_CONFIG_URL). Each entry is read like a protocol server reads its allowed authorities (trimmed, then
 * canonicalAuthority: case-insensitive, ":443" dropped), and an empty entry (a stray comma) makes the whole value
 * unusable there as here. So a value both sides accept means the same hosts on both; the one difference is that this
 * side also refuses a single-label host, which a Worker cannot call. Every deep check, bootstrap or platform-saved, must
 * use one of them: the deep check carries a signature for its host, and the allowlist keeps a platform edit from aiming it
 * anywhere else. Null when the setting is unusable (then no deep check is allowed).
 */
export function deepCheckHosts(env: Readonly<Record<string, unknown>>): ReadonlySet<string> | null {
  const configured = env["DEEP_CHECK_HOSTS"];
  if (typeof configured === "string" && configured.trim() !== "") {
    const hosts = configured.split(",").map((host) => canonicalAuthority(host.trim()));
    return hosts.every((host) => host !== null) ? new Set(hosts) : null;
  }
  const url = platformConfigUrl(env);
  return url === null ? null : new Set([new URL(url).host]);
}

/** Problems for every deep check whose host is not allowed. */
export function checkDeepHosts(targets: TargetsConfig, hosts: ReadonlySet<string> | null, problems: Problems): void {
  for (const check of targets.checks) {
    if (check.type !== "deep" || !URL.canParse(check.url) || (hosts !== null && hosts.has(new URL(check.url).host))) continue;
    problems.add(`targets.checks.${check.id}.url`, hosts === null
      ? "a deep check needs DEEP_CHECK_HOSTS (or a valid PLATFORM_CONFIG_URL) to name its host"
      : `host must be one of DEEP_CHECK_HOSTS (${[...hosts].join(", ")})`);
  }
}

/**
 * Twilio credentials always come from secrets. The sender comes from the platform's senders when it names one (a
 * number or a Messaging Service), otherwise from TWILIO_FROM / TWILIO_MESSAGING_SERVICE_SID.
 */
function twilioSettings(env: Readonly<Record<string, unknown>>, senders: Senders | null, problems: Problems): TwilioSettings | null {
  const accountSid = text(env, "TWILIO_ACCOUNT_SID");
  const apiKey = text(env, "TWILIO_API_KEY_SID");
  const apiSecret = text(env, "TWILIO_API_KEY_SECRET");
  const authToken = text(env, "TWILIO_AUTH_TOKEN");
  const platformSender = senders !== null && (senders.smsFrom !== null || senders.smsMessagingServiceSid !== null);
  const from = platformSender ? senders.smsFrom : text(env, "TWILIO_FROM");
  const messagingServiceSid = platformSender ? senders.smsMessagingServiceSid : text(env, "TWILIO_MESSAGING_SERVICE_SID");
  if (accountSid === null && authToken === null) return null;
  if (accountSid === null || !/^AC[0-9a-f]{32}$/.test(accountSid)) problems.add("TWILIO_ACCOUNT_SID", "must be an AC... account SID");
  // The auth token is required even with an API key: Twilio signs inbound webhooks with it.
  if (authToken === null) problems.add("TWILIO_AUTH_TOKEN", "is required (it validates the inbound SMS webhook)");
  if ((apiKey === null) !== (apiSecret === null)) problems.add("TWILIO_API_KEY_SID", "and TWILIO_API_KEY_SECRET go together");
  if (from === null && messagingServiceSid === null) problems.add("TWILIO_FROM", "or TWILIO_MESSAGING_SERVICE_SID is required");
  if (from !== null && !E164.test(from)) problems.add("TWILIO_FROM", "must be an E.164 number");
  if (messagingServiceSid !== null && !MESSAGING_SERVICE_SID.test(messagingServiceSid)) problems.add("TWILIO_MESSAGING_SERVICE_SID", "must be MG...");
  const rawSecondary = env["TWILIO_AUTH_TOKEN_SECONDARY"];
  const authTokenSecondary = typeof rawSecondary === "string" && rawSecondary.trim() !== "" ? rawSecondary : null;
  if (authTokenSecondary !== null && authTokenSecondary !== authTokenSecondary.trim()) {
    problems.add("TWILIO_AUTH_TOKEN_SECONDARY", "has leading or trailing whitespace (store it without a newline, e.g. with printf)");
  }
  return {
    accountSid: accountSid ?? "",
    username: apiKey ?? accountSid ?? "",
    password: apiSecret ?? authToken ?? "",
    authToken: authToken ?? "",
    authTokenSecondary,
    from: messagingServiceSid === null ? from : null,
    messagingServiceSid,
  };
}

function deliveryMode(env: Readonly<Record<string, unknown>>, problems: Problems): DeliveryMode {
  const value = text(env, "DELIVERY_MODE") ?? "live";
  if (value !== "live" && value !== "log") problems.add("DELIVERY_MODE", "must be live or log");
  return value === "log" ? "log" : "live";
}

/** ALERT_EMAIL_FROM, lowercase; null when unset. An address that is not one adds a problem (and reads as null). */
export function alertEmailFrom(env: Readonly<Record<string, unknown>>, problems: Problems = new Problems()): string | null {
  const value = text(env, "ALERT_EMAIL_FROM");
  if (value === null) return null;
  if (!EMAIL.test(value)) {
    problems.add("ALERT_EMAIL_FROM", "must be an email address (the ALERT_EMAIL binding's allowed sender)");
    return null;
  }
  return value.toLowerCase();
}

/** BRAND_NAME, trimmed (default "Status"); an invalid value adds a problem. */
function brandName(env: Readonly<Record<string, unknown>>, problems: Problems): string {
  const value = text(env, "BRAND_NAME");
  if (value === null) return DEFAULT_BRAND_NAME;
  const problem = brandNameProblem(value);
  if (problem !== null) problems.add("BRAND_NAME", problem);
  return problem === null ? value : DEFAULT_BRAND_NAME;
}

/** ALERT_EMAIL_FROM_NAME, or null when unset; an invalid value adds a problem. */
function emailFromName(env: Readonly<Record<string, unknown>>, problems: Problems): string | null {
  const value = text(env, "ALERT_EMAIL_FROM_NAME");
  if (value === null) return null;
  if (!isEmailFromName(value)) problems.add("ALERT_EMAIL_FROM_NAME", "must be 1 to 60 characters without line breaks, quotes or angle brackets");
  return value;
}

/** True when env carries a send_email binding (an object with a send method). */
const hasEmailBinding = (env: Readonly<Record<string, unknown>>): boolean => {
  const binding = env["ALERT_EMAIL"];
  return typeof binding === "object" && binding !== null && typeof Reflect.get(binding, "send") === "function";
};

/**
 * Loads everything the scheduled run and the notifier need. Secrets are read here and nowhere else.
 *
 * In standalone mode (PLATFORM_CONFIG_URL unset) the caller passes no platform sections, and the env is the whole
 * configuration: MONITOR_TARGETS and ESCALATION_POLICY (resolveConfig in platform-config.ts).
 *
 * The effective configuration is the stored platform revision (last known good) section by section over the env
 * bootstrap: a platform policy replaces ESCALATION_POLICY (which is then optional and not read), platform targets
 * replace MONITOR_TARGETS, and platform senders replace the Twilio sender vars. With neither a platform policy nor
 * ESCALATION_POLICY the run refuses, as before.
 */
export function loadConfig(env: Readonly<Record<string, unknown>>, platform: PlatformSections | null = null): ConfigResult {
  const problems = new Problems();
  const brand = brandName(env, problems);
  const targets = platform?.targets ?? parseTargets(env["MONITOR_TARGETS"] ?? null, problems);
  const policy = platform?.policy ?? parsePolicy(env["ESCALATION_POLICY"] ?? null, problems);
  const senders = platform?.senders ?? null;
  const maintenance = platform?.maintenance ?? [];
  const statusPageUrl = httpsUrl(text(env, "STATUS_PAGE_URL") ?? "", "STATUS_PAGE_URL", problems).replace(/\/$/, "");
  const twilioWebhookUrl = httpsUrl(text(env, "TWILIO_WEBHOOK_URL") ?? "", "TWILIO_WEBHOOK_URL", problems);
  const keys = signingKeys(env, problems);
  const ackSigningKey = keyOf(env, "ACK_SIGNING_KEY", problems);
  if (ackSigningKey === null) problems.add("ACK_SIGNING_KEY", "is required");
  if (targets !== null) {
    if (targets.checks.some((check) => check.type === "deep") && keys.health === null) problems.add("MONITOR_HEALTH_KEY", "is required by the deep check");
    checkDeepHosts(targets, deepCheckHosts(env), problems);
  }
  const mode = deliveryMode(env, problems);
  const twilio = twilioSettings(env, senders, problems);
  const from = alertEmailFrom(env, problems);
  // ALERT_EMAIL_FROM_NAME is validated even while a platform name wins over it, so a bad value never waits to surface.
  const envFromName = emailFromName(env, problems);
  const fromName = senders?.emailFromName ?? envFromName ?? withNoun(brand, "Status");
  // A platform emailFrom is accepted only when it equals ALERT_EMAIL_FROM (parseSenders), so from is the one address.
  const email: EmailSettings | null = hasEmailBinding(env) && from !== null ? { from, fromName } : null;
  const contacts = policy?.tiers.flatMap((tier) => tier.contacts) ?? [];
  // In log mode nothing is sent, so no provider is needed.
  if (mode === "live" && contacts.some((contact) => contact.sms !== null) && twilio === null) {
    problems.add("TWILIO_*", "required: a contact has an sms channel");
  }
  if (mode === "live" && contacts.some((contact) => contact.email !== null)) {
    if (!hasEmailBinding(env)) problems.add("ALERT_EMAIL", "send_email binding required: a contact has an email channel");
    if (text(env, "ALERT_EMAIL_FROM") === null) problems.add("ALERT_EMAIL_FROM", "required: a contact has an email channel");
  }
  // HEARTBEAT_URL is optional so that monitoring never stops for want of it; a live Worker without one carries the
  // persistent heartbeat_missing warning instead (warnings.ts).
  const optionalUrl = (name: string): string | null => {
    const value = text(env, name);
    return value === null ? null : httpsUrl(value, name, problems);
  };
  const heartbeatUrl = optionalUrl("HEARTBEAT_URL");
  const heartbeatFailUrl = optionalUrl("HEARTBEAT_FAIL_URL");
  const dnsSecondaryResolver = optionalUrl("DNS_SECONDARY_RESOLVER");
  if (dnsSecondaryResolver !== null && /[?#]/.test(dnsSecondaryResolver)) problems.add("DNS_SECONDARY_RESOLVER", "must have no query or fragment");
  if (problems.list.length > 0 || targets === null || policy === null || ackSigningKey === null) {
    return { ok: false, errors: problems.list.length > 0 ? problems.list : ["config: invalid"] };
  }
  const source: ConfigSource = platform === null ? { kind: "bootstrap" } : { kind: "platform", revision: platform.revision };
  return {
    ok: true,
    config: {
      brandName: brand, mode: monitorMode(env), targets, policy, maintenance, statusPageUrl, twilioWebhookUrl, healthKey: keys.health,
      configKey: keys.config, ackSigningKey, twilio, email, heartbeatUrl, heartbeatFailUrl, dnsSecondaryResolver, deliveryMode: mode, source,
    },
  };
}

/** STATUS_VIEW_KEY gates only the private view; when absent or short the private view is disabled. */
export function statusViewKey(env: Readonly<Record<string, unknown>>): string | null {
  const value = text(env, "STATUS_VIEW_KEY");
  return value !== null && byteLength(value) >= MIN_KEY_BYTES ? value : null;
}

export { checkStorable, httpsUrl, isEmailFromName, parsePolicy, parseSenders, parseTargets, Problems } from "./config-parse.ts";
export {
  ALERT_MODES, CONFIG_PATH, DEEP_PATH, E164, EMAIL, EMAIL_FROM_NAME_MAX_CHARS, isPlainLine, LIMITS, MIN_KEY_BYTES, TWILIO_STATUS_PATH, twilioStatusUrl,
} from "./config-types.ts";
export type {
  AlertMode, CheckConfig, ComponentConfig, ConfigResult, ConfigSource, Contact, DeepCheckConfig, DeliveryMode, DnsCheckConfig, EmailSettings, EscalationPolicy,
  HttpCheckConfig, MonitorConfig, MonitorMode, PlatformSections, Senders, TargetsConfig, Tier, TwilioSettings,
} from "./config-types.ts";
