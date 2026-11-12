// Parsing and validation of the monitor configuration's sections: targets, escalation policy and senders, each from
// the env bootstrap or a stored platform revision (config.ts). Every problem is collected; a section with any is refused.
// A platform that serves the configuration should validate with the same rules and messages (spec/PROTOCOL.md).
import type { DrillSchedule } from "./drill.ts";
import { DEFAULT_DRILL, DRILL_TIME } from "./drill.ts";
import { isTimeZone } from "./time.ts";
import { isRecord } from "./types.ts";
import type { CheckConfig, ComponentConfig, Contact, EscalationPolicy, Senders, TargetsConfig } from "./config-types.ts";
import {
  ALERT_MODES, DEEP_PATH, E164, EMAIL, EMAIL_FROM_NAME_MAX_CHARS, HOSTNAME, ID, isPlainLine, LIMITS, MESSAGING_SERVICE_SID, UNSTORABLE,
} from "./config-types.ts";

export class Problems {
  readonly list: string[] = [];
  add(path: string, message: string): void {
    this.list.push(`${path}: ${message}`);
  }
}

/** Adds one problem per string (or key) holding U+0000 or an unpaired surrogate, anywhere in a parsed JSON value. */
export function checkStorable(value: unknown, path: string, problems: Problems, depth = 0): void {
  if (typeof value === "string") {
    if (UNSTORABLE.test(value)) problems.add(path, "must not contain U+0000 or an unpaired surrogate");
    return;
  }
  if (depth > 16 || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      checkStorable(item, `${path}[${String(index)}]`, problems, depth + 1);
    });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (UNSTORABLE.test(key)) problems.add(path, "must not contain a key with U+0000 or an unpaired surrogate");
    checkStorable(item, `${path}.${key}`, problems, depth + 1);
  }
}

function parseJson(value: unknown, path: string, problems: Problems): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    problems.add(path, "is not valid JSON");
    return null;
  }
}

function str(record: Readonly<Record<string, unknown>>, key: string, path: string, problems: Problems, pattern?: RegExp): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    problems.add(`${path}.${key}`, "must be a non-empty string");
    return "";
  }
  if (pattern !== undefined && !pattern.test(value)) problems.add(`${path}.${key}`, `must match ${pattern.source}`);
  return value;
}

/** A display label (tier, component or contact name): 1 to 60 printable characters on one line. */
function label(record: Readonly<Record<string, unknown>>, key: string, path: string, problems: Problems): string {
  const value = str(record, key, path, problems);
  if (value !== "" && (value.length > LIMITS.labelChars || !isPlainLine(value))) {
    problems.add(`${path}.${key}`, `must be at most ${String(LIMITS.labelChars)} printable characters on one line`);
  }
  return value;
}

function optionalStr(record: Readonly<Record<string, unknown>>, key: string, path: string, problems: Problems, pattern: RegExp): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    problems.add(`${path}.${key}`, `must match ${pattern.source}`);
    return null;
  }
  return value;
}

function int(record: Readonly<Record<string, unknown>>, key: string, path: string, problems: Problems, range: [number, number, number]): number {
  const [min, max, fallback] = range;
  const value = record[key] ?? fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.add(`${path}.${key}`, `must be an integer from ${String(min)} to ${String(max)}`);
    return fallback;
  }
  return value;
}

/** An https URL without credentials, returned canonical (as the URL parser prints it); its canonical form must fit 2048. */
export function httpsUrl(value: string, path: string, problems: Problems): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") problems.add(path, "must be an https URL without credentials");
    if (url.href.length > LIMITS.urlChars) problems.add(path, `must be at most ${String(LIMITS.urlChars)} characters (as normalised)`);
    return url.href;
  } catch {
    problems.add(path, "must be an https URL");
    return value;
  }
}

/** A URL field: a non-empty string whose canonical form is a valid https URL (the raw text is not length-limited). */
function urlField(record: Readonly<Record<string, unknown>>, key: string, path: string, problems: Problems): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    problems.add(`${path}.${key}`, "must be a non-empty string");
    return "";
  }
  return httpsUrl(value, `${path}.${key}`, problems);
}

function records(value: unknown, path: string, problems: Problems, max: number): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    problems.add(path, `must be a non-empty array of at most ${String(max)} entries`);
    return [];
  }
  return value.flatMap((item: unknown, index) => {
    if (isRecord(item)) return [item];
    problems.add(`${path}[${String(index)}]`, "must be an object");
    return [];
  });
}

function uniqueIds(ids: readonly string[], path: string, problems: Problems): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) problems.add(path, `duplicate id ${id}`);
    seen.add(id);
  }
}

// alert and public are optional (stored revisions and older documents stay valid); a platform should validate both with
// the same rules and messages.
function parseComponent(raw: Readonly<Record<string, unknown>>, path: string, problems: Problems): ComponentConfig {
  const pageOn = raw["pageOn"] ?? "down";
  if (pageOn !== "down" && pageOn !== "degraded") problems.add(`${path}.pageOn`, "must be down or degraded");
  const alert = ALERT_MODES.find((mode) => mode === (raw["alert"] ?? "page"));
  if (alert === undefined) problems.add(`${path}.alert`, "must be page, email or none");
  const shown = raw["public"] ?? true;
  if (typeof shown !== "boolean") problems.add(`${path}.public`, "must be true or false");
  return {
    id: str(raw, "id", path, problems, ID), name: label(raw, "name", path, problems), pageOn: pageOn === "degraded" ? "degraded" : "down",
    alert: alert ?? "page", public: shown !== false,
  };
}

function parseExpectStatus(value: unknown, path: string, problems: Problems): { min: number; max: number } {
  const valid = (code: unknown): code is number => typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599;
  if (value === undefined) return { min: 200, max: 299 };
  if (valid(value)) return { min: value, max: value };
  if (Array.isArray(value) && value.length === 2 && valid(value[0]) && valid(value[1]) && value[0] <= value[1]) return { min: value[0], max: value[1] };
  problems.add(path, "must be a status code or a [min, max] pair");
  return { min: 200, max: 299 };
}

function parseCheck(raw: Readonly<Record<string, unknown>>, path: string, problems: Problems): CheckConfig | null {
  const base = {
    id: str(raw, "id", path, problems, ID),
    component: str(raw, "component", path, problems, ID),
    timeoutMs: int(raw, "timeoutMs", path, problems, [1000, 30000, 10000]),
  };
  const type = raw["type"];
  if (type === "http") {
    const method = raw["method"] ?? "GET";
    if (method !== "GET" && method !== "HEAD") problems.add(`${path}.method`, "must be GET or HEAD");
    // The only free text a check carries (shown in the private view): held to the label rules.
    const bodyIncludes = raw["bodyIncludes"];
    if (bodyIncludes !== undefined && (typeof bodyIncludes !== "string" || bodyIncludes.length === 0 || bodyIncludes.length > LIMITS.labelChars
      || !isPlainLine(bodyIncludes))) {
      problems.add(`${path}.bodyIncludes`, `must be 1 to ${String(LIMITS.labelChars)} printable characters on one line`);
    }
    return {
      ...base,
      type,
      url: urlField(raw, "url", path, problems),
      method: method === "HEAD" ? "HEAD" : "GET",
      expectStatus: parseExpectStatus(raw["expectStatus"], `${path}.expectStatus`, problems),
      maxRedirects: int(raw, "maxRedirects", path, problems, [0, 10, 5]),
      bodyIncludes: typeof bodyIncludes === "string" && bodyIncludes.length > 0 ? bodyIncludes : null,
      latencyDegradedMs: int(raw, "latencyDegradedMs", path, problems, [100, 30000, 3000]),
    };
  }
  if (type === "dns") {
    const dnsOnly = raw["dnsOnly"] ?? true;
    if (typeof dnsOnly !== "boolean") problems.add(`${path}.dnsOnly`, "must be a boolean");
    return { ...base, type, hostname: str(raw, "hostname", path, problems, HOSTNAME), dnsOnly: dnsOnly !== false };
  }
  if (type === "deep") {
    const url = urlField(raw, "url", path, problems);
    if (URL.canParse(url) && new URL(url).pathname !== DEEP_PATH) problems.add(`${path}.url`, `path must be ${DEEP_PATH}`);
    // Signed requests carry no query (the server refuses any "?"), and a fragment is never sent.
    if (URL.canParse(url) && (url.includes("?") || url.includes("#"))) problems.add(`${path}.url`, "must have no query or fragment");
    const map = raw["componentMap"] ?? {};
    const componentMap: Record<string, string> = {};
    if (!isRecord(map)) problems.add(`${path}.componentMap`, "must be an object");
    else {
      for (const [key, value] of Object.entries(map)) {
        if (!ID.test(key) || typeof value !== "string" || !ID.test(value)) problems.add(`${path}.componentMap.${key}`, "must map an id to an id");
        else componentMap[key] = value;
      }
    }
    return { ...base, type, url, latencyDegradedMs: int(raw, "latencyDegradedMs", path, problems, [100, 30000, 5000]), componentMap };
  }
  problems.add(`${path}.type`, "must be http, dns or deep");
  return null;
}

export function parseTargets(value: unknown, problems: Problems = new Problems()): TargetsConfig | null {
  const raw = parseJson(value, "targets", problems);
  if (!isRecord(raw)) {
    problems.add("targets", "must be an object");
    return null;
  }
  checkStorable(raw, "targets", problems);
  if (raw["version"] !== 1) problems.add("targets.version", "must be 1");
  // Never page on a single blip: at least two failing runs open an incident.
  const openAfterFailures = int(raw, "openAfterFailures", "targets", problems, [2, 10, 2]);
  const resolveAfterPasses = int(raw, "resolveAfterPasses", "targets", problems, [1, 30, 3]);
  const components = records(raw["components"], "targets.components", problems, 50).map((item, index) =>
    parseComponent(item, `targets.components[${String(index)}]`, problems)
  );
  const checks = records(raw["checks"], "targets.checks", problems, 100).flatMap((item, index) => {
    const check = parseCheck(item, `targets.checks[${String(index)}]`, problems);
    return check === null ? [] : [check];
  });
  uniqueIds(components.map((item) => item.id), "targets.components", problems);
  uniqueIds(checks.map((item) => item.id), "targets.checks", problems);
  if (checks.filter((check) => check.type === "deep").length > 1) problems.add("targets.checks", "at most one deep check");
  const known = new Set(components.map((item) => item.id));
  for (const check of checks) {
    if (!known.has(check.component)) problems.add(`targets.checks.${check.id}.component`, `unknown component ${check.component}`);
    if (check.type !== "deep") continue;
    for (const [sub, component] of Object.entries(check.componentMap)) {
      if (!known.has(component)) problems.add(`targets.checks.${check.id}.componentMap.${sub}`, `unknown component ${component}`);
    }
  }
  return problems.list.length > 0 ? null : { version: 1, openAfterFailures, resolveAfterPasses, components, checks };
}

function parseContact(raw: Readonly<Record<string, unknown>>, path: string, problems: Problems): Contact {
  const contact = {
    id: str(raw, "id", path, problems, ID),
    name: label(raw, "name", path, problems),
    sms: optionalStr(raw, "sms", path, problems, E164),
    email: optionalStr(raw, "email", path, problems, EMAIL),
  };
  if (contact.sms === null && contact.email === null) problems.add(path, "needs at least one channel (sms or email)");
  return contact;
}

export function parsePolicy(value: unknown, problems: Problems = new Problems()): EscalationPolicy | null {
  const raw = parseJson(value, "policy", problems);
  if (!isRecord(raw)) {
    problems.add("policy", "must be an object");
    return null;
  }
  checkStorable(raw, "policy", problems);
  if (raw["version"] !== 1) problems.add("policy.version", "must be 1");
  const maxCycles = int(raw, "maxCycles", "policy", problems, [1, 10, 3]);
  const ackLinkTtlMinutes = int(raw, "ackLinkTtlMinutes", "policy", problems, [15, 10080, 1440]);
  const timeZone = parseTimeZone(raw["timeZone"], problems);
  const reminderMinutes = parseReminderMinutes(raw["reminderMinutes"], problems);
  const drill = parseDrill(raw["drill"], problems);
  const tiers = records(raw["tiers"], "policy.tiers", problems, 10).map((tier, index) => {
    const path = `policy.tiers[${String(index)}]`;
    return {
      id: str(tier, "id", path, problems, ID),
      name: label(tier, "name", path, problems),
      ackTimeoutMinutes: int(tier, "ackTimeoutMinutes", path, problems, [1, 1440, 5]),
      contacts: records(tier["contacts"], `${path}.contacts`, problems, 20).map((contact, at) =>
        parseContact(contact, `${path}.contacts[${String(at)}]`, problems)
      ),
    };
  });
  uniqueIds(tiers.map((tier) => tier.id), "policy.tiers", problems);
  // A person belongs to one tier, so "who was paged" and "who acknowledged" are unambiguous.
  uniqueIds(tiers.flatMap((tier) => tier.contacts.map((contact) => contact.id)), "policy.contacts", problems);
  return problems.list.length > 0 ? null : { version: 1, maxCycles, ackLinkTtlMinutes, timeZone, reminderMinutes, drill, tiers };
}

function parseTimeZone(value: unknown, problems: Problems): string {
  if (value === undefined || value === null) return "UTC";
  if (typeof value !== "string" || value === "" || value.length > LIMITS.timeZoneChars || !isPlainLine(value) || !isTimeZone(value)) {
    problems.add("policy.timeZone", "must be an IANA time zone name such as America/New_York");
    return "UTC";
  }
  return value;
}

function parseReminderMinutes(value: unknown, problems: Problems): number {
  const [min, max, fallback] = LIMITS.reminderMinutes;
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || (value !== 0 && (value < min || value > max))) {
    problems.add("policy.reminderMinutes", `must be 0 (off) or an integer from ${String(min)} to ${String(max)}`);
    return fallback;
  }
  return value;
}

function parseDrill(value: unknown, problems: Problems): DrillSchedule {
  if (value === undefined || value === null) return DEFAULT_DRILL;
  if (!isRecord(value)) {
    problems.add("policy.drill", "must be an object");
    return DEFAULT_DRILL;
  }
  const enabled = value["enabled"] ?? DEFAULT_DRILL.enabled;
  const weekday = value["weekday"] ?? DEFAULT_DRILL.weekday;
  const time = value["time"] ?? DEFAULT_DRILL.time;
  if (typeof enabled !== "boolean") problems.add("policy.drill.enabled", "must be a boolean");
  if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    problems.add("policy.drill.weekday", "must be an ISO weekday from 1 (Monday) to 7 (Sunday)");
  }
  if (typeof time !== "string" || !DRILL_TIME.test(time)) problems.add("policy.drill.time", "must be HH:MM (24-hour)");
  return typeof enabled === "boolean" && typeof weekday === "number" && typeof time === "string" ? { enabled, weekday, time } : DEFAULT_DRILL;
}

/** True for a usable email From name: 1 to 60 printable characters on one line, without quotes or angle brackets. */
export const isEmailFromName = (value: string): boolean =>
  value.trim() !== "" && value.length <= EMAIL_FROM_NAME_MAX_CHARS && !/[<>"]/.test(value) && isPlainLine(value);

/**
 * The platform's sender identities (the "senders" section of /api/v2/monitor/config). `alertEmailFrom` is
 * ALERT_EMAIL_FROM (lowercase), the one address the ALERT_EMAIL binding may send from: emailFrom is accepted only when
 * it names that address, since the binding refuses any other sender and a different one would silently stop every alert
 * email. With ALERT_EMAIL_FROM unset, no emailFrom is accepted.
 */
export function parseSenders(value: unknown, problems: Problems = new Problems(), alertEmailFrom: string | null = null): Senders | null {
  if (!isRecord(value)) {
    problems.add("senders", "must be an object");
    return null;
  }
  checkStorable(value, "senders", problems);
  const smsFrom = optionalStr(value, "smsFrom", "senders", problems, E164);
  const smsMessagingServiceSid = optionalStr(value, "smsMessagingServiceSid", "senders", problems, MESSAGING_SERVICE_SID);
  if (smsFrom !== null && smsMessagingServiceSid !== null) problems.add("senders", "smsFrom and smsMessagingServiceSid: at most one may be set");
  const emailFrom = optionalStr(value, "emailFrom", "senders", problems, EMAIL)?.toLowerCase() ?? null;
  if (emailFrom !== null && emailFrom !== alertEmailFrom) {
    problems.add("senders.emailFrom", alertEmailFrom === null
      ? "must be null: the Worker has no ALERT_EMAIL_FROM"
      : `must be the ALERT_EMAIL binding's allowed sender, ALERT_EMAIL_FROM (${alertEmailFrom})`);
  }
  const name = value["emailFromName"];
  let emailFromName: string | null = null;
  if (name !== undefined && name !== null) {
    if (typeof name !== "string" || !isEmailFromName(name)) {
      problems.add("senders.emailFromName", "must be 1 to 60 characters without line breaks, quotes or angle brackets");
    } else emailFromName = name.trim();
  }
  return problems.list.length > 0 ? null : { smsFrom, smsMessagingServiceSid, emailFrom, emailFromName };
}
