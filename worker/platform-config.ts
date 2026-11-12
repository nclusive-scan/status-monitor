// Platform-managed configuration (optional; spec/PROTOCOL.md). With PLATFORM_CONFIG_URL set, the escalation policy,
// the check targets and the sender identities are edited in the platform the monitor watches, whose database is the
// source of truth. The Worker has no inbound admin surface, so it PULLS GET /api/v2/monitor/config on every run, signed
// with protocol v2 (signature.ts) and the CONFIG key (MONITOR_CONFIG_KEY, separate from the deep check's HEALTH key),
// in parallel with the checks and never in their way.
//
// Without PLATFORM_CONFIG_URL the monitor runs standalone: MONITOR_TARGETS and ESCALATION_POLICY are the whole
// configuration, nothing is pulled, nothing is reported, and a platform revision stored by an earlier deployment is
// ignored (resolveConfig).
//
// A document is accepted only when it validates with the same parsers as the env bootstrap, would leave the monitor
// with a usable configuration, and carries a revision above the stored one. The accepted revision is the last known
// good (LKG) copy in the Durable Object's SQLite: a platform outage or a bad document never stops monitoring, which
// keeps running on the LKG, or on the env bootstrap (MONITOR_TARGETS, ESCALATION_POLICY) until a first revision is
// stored. Once a revision is stored the bootstrap never stands in for it: a stored copy that a later Worker no longer
// validates refuses the run (the dead-man's switch fires) until a new revision is saved.
//
// The deep check's URL is platform-editable, and the Worker sends it a freshly signed request, so its host must be on
// the Worker's own allowlist (DEEP_CHECK_HOSTS, default PLATFORM_CONFIG_URL's host). The document also carries the
// maintenance windows (maintenance.ts), validated against the effective components.
//
// When an accepted revision changes who gets paged, every email contact of the old and the new policy gets an
// informational email (the tamper signal), never an SMS or a page, and incident sends still queued are re-pointed at
// the new contacts (store.ts, reconcileRecipients).
import type { ConfigResult, Contact, EscalationPolicy, PlatformSections, Senders, TargetsConfig } from "./config.ts";
import {
  alertEmailFrom, checkDeepHosts, checkStorable, deepCheckHosts, loadConfig, monitorMode, parsePolicy, parseSenders, parseTargets, platformConfigUrl,
  Problems, signingKeys,
} from "./config.ts";
import { readCapped } from "./body.ts";
import { byteLength, systemRandom } from "./crypto.ts";
import type { RandomSource } from "./crypto.ts";
import type { MaintenanceWindow } from "./maintenance.ts";
import { parseMaintenance } from "./maintenance.ts";
import { signRequest } from "./signature.ts";
import type { AcceptOutcome, ConfigChange, ConfigNotices, MonitorStore, StoredPlatformConfig } from "./store.ts";
import type { Clock, FetchLike } from "./types.ts";
import { isRecord, USER_AGENT } from "./types.ts";

/** The same limit the platform enforces on what it stores. */
export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const CONFIG_FETCH_TIMEOUT_MS = 5000;

export interface PlatformDocument {
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  readonly sections: PlatformSections;
  /** The sections as received, re-serialized: what the store keeps and compares. */
  readonly body: string;
}

export type ParsedDocument =
  | { readonly ok: true; readonly document: PlatformDocument }
  | { readonly ok: false; readonly code: string; readonly errors: readonly string[]; readonly revision: number | null };

const invalid = (code: string, errors: readonly string[] = [], revision: number | null = null): ParsedDocument => ({ ok: false, code, errors, revision });

/** What validating a document needs from the Worker's env. */
export interface DocumentContext {
  /** deepCheckHosts(env): the hosts a deep check may call (null: none). */
  readonly deepHosts: ReadonlySet<string> | null;
  /** The component ids of the built-in MONITOR_TARGETS, which maintenance windows name while the targets are null. */
  readonly builtinComponents: ReadonlySet<string>;
  /** ALERT_EMAIL_FROM (lowercase; null when unset): the only senders.emailFrom accepted. */
  readonly alertEmailFrom: string | null;
}

export function documentContext(env: Readonly<Record<string, unknown>>): DocumentContext {
  const builtin = parseTargets(env["MONITOR_TARGETS"] ?? null);
  return {
    deepHosts: deepCheckHosts(env), builtinComponents: new Set(builtin?.components.map((component) => component.id) ?? []),
    alertEmailFrom: alertEmailFrom(env),
  };
}

const contextKey = (context: DocumentContext): string =>
  `${[...(context.deepHosts ?? [])].join(",")}|${context.deepHosts === null ? "none" : "set"}|${[...context.builtinComponents].join(",")}|${
    context.alertEmailFrom ?? ""}`;

function optionalText(value: unknown, max: number, path: string, problems: Problems): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    problems.add(path, "must be a string or null");
    return null;
  }
  // Shown in the private view and named in the config-change email: printable, one line, bounded.
  const cleaned = value.replace(/\p{Cc}+/gu, " ").trim().slice(0, max);
  return cleaned === "" ? null : cleaned;
}

/** Validates the body of GET /api/v2/monitor/config with the Worker's own parsers. */
export function parsePlatformDocument(body: string, context: DocumentContext): ParsedDocument {
  if (byteLength(body) > MAX_DOCUMENT_BYTES) return invalid("config_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return invalid("config_invalid_json");
  }
  if (!isRecord(raw)) return invalid("config_invalid", ["config: must be an object"]);
  const problems = new Problems();
  if (raw["schema"] !== 1) problems.add("schema", "must be 1");
  const revision = raw["revision"];
  const validRevision = typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0;
  if (!validRevision) problems.add("revision", "must be a non-negative integer");
  checkStorable(raw["updatedAt"], "updatedAt", problems);
  checkStorable(raw["updatedBy"], "updatedBy", problems);
  const updatedAt = optionalText(raw["updatedAt"], 40, "updatedAt", problems);
  const updatedBy = optionalText(raw["updatedBy"], 120, "updatedBy", problems);
  const rawPolicy = raw["policy"] ?? null, rawTargets = raw["targets"] ?? null, rawSenders = raw["senders"] ?? null;
  const rawMaintenance = raw["maintenance"] ?? null;
  let policy: EscalationPolicy | null = null, targets: TargetsConfig | null = null, senders: Senders | null = null;
  let maintenance: MaintenanceWindow[] = [];
  if (revision === 0) {
    if (rawPolicy !== null || rawTargets !== null || rawSenders !== null || rawMaintenance !== null) {
      problems.add("revision", "0 (nothing saved) must carry no sections");
    }
  } else {
    // Sections must be objects: the env parsers also accept a JSON string, which the platform never sends.
    if (!isRecord(rawPolicy)) problems.add("policy", "must be an object");
    else policy = parsePolicy(rawPolicy, problems);
    if (rawTargets !== null) {
      if (!isRecord(rawTargets)) problems.add("targets", "must be an object or null");
      else targets = parseTargets(rawTargets, problems);
      if (targets !== null) checkDeepHosts(targets, context.deepHosts, problems);
    }
    if (rawSenders !== null) senders = parseSenders(rawSenders, problems, context.alertEmailFrom);
    checkStorable(rawMaintenance, "maintenance", problems);
    const known = targets !== null ? new Set(targets.components.map((component) => component.id)) : rawTargets === null ? context.builtinComponents : null;
    maintenance = parseMaintenance(rawMaintenance, known, problems);
  }
  if (problems.list.length > 0 || !validRevision) return invalid("config_invalid", problems.list, validRevision ? revision : null);
  return {
    ok: true,
    document: {
      revision, updatedAt, updatedBy,
      sections: { revision, policy, targets, senders, maintenance },
      body: JSON.stringify({ policy: rawPolicy, targets: rawTargets, senders: rawSenders, maintenance: rawMaintenance }),
    },
  };
}

export type StoredSections = { readonly ok: true; readonly sections: PlatformSections } | { readonly ok: false; readonly errors: readonly string[] };

/** The stored body as JSON, or null when it is not an object. */
function storedBody(stored: StoredPlatformConfig): Readonly<Record<string, unknown>> | null {
  try {
    const body: unknown = JSON.parse(stored.body);
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** Re-validates a stored LKG body under the Worker's current parsers, which may be stricter than when it was stored. */
export function sectionsFromStored(stored: StoredPlatformConfig, context: DocumentContext): StoredSections {
  const body = storedBody(stored);
  if (body === null) return { ok: false, errors: ["config: stored body is not a JSON object"] };
  const document = {
    schema: 1, revision: stored.revision, policy: body["policy"], targets: body["targets"], senders: body["senders"], maintenance: body["maintenance"],
  };
  const parsed = parsePlatformDocument(JSON.stringify(document), context);
  return parsed.ok ? { ok: true, sections: parsed.document.sections } : { ok: false, errors: parsed.errors.length > 0 ? parsed.errors : [parsed.code] };
}

/** Memoizes the re-validated LKG by revision, so the object does not re-validate it on every status read. */
export class SectionsCache {
  private entry: { readonly revision: number; readonly body: string; readonly context: string; readonly result: StoredSections } | null = null;

  get(stored: StoredPlatformConfig, context: DocumentContext): StoredSections {
    const key = contextKey(context);
    if (this.entry?.revision !== stored.revision || this.entry.body !== stored.body || this.entry.context !== key) {
      this.entry = { revision: stored.revision, body: stored.body, context: key, result: sectionsFromStored(stored, context) };
    }
    return this.entry.result;
  }
}

/**
 * The effective configuration: the stored platform revision over the env bootstrap (see loadConfig). In standalone
 * mode (no PLATFORM_CONFIG_URL) the env alone, whatever is stored. Otherwise the bootstrap stands in only while
 * nothing is stored. A stored revision that no longer validates (a later Worker tightened a rule)
 * refuses the run instead of quietly reviving whatever MONITOR_TARGETS and ESCALATION_POLICY still hold; the platform
 * keeps serving that revision, so only saving a new one recovers.
 */
export function resolveConfig(env: Readonly<Record<string, unknown>>, stored: StoredPlatformConfig | null, cache = new SectionsCache()): ConfigResult {
  if (stored === null || monitorMode(env) === "standalone") return loadConfig(env, null);
  const revalidated = cache.get(stored, documentContext(env));
  if (revalidated.ok) return loadConfig(env, revalidated.sections);
  const revision = String(stored.revision);
  return {
    ok: false,
    errors: [`platform revision ${revision}: the stored copy no longer validates; save a new revision`, ...revalidated.errors.slice(0, 5)],
  };
}

export type FetchSettings = { readonly ok: true; readonly url: string; readonly key: string } | { readonly ok: false; readonly code: string };

/**
 * PLATFORM_CONFIG_URL and MONITOR_CONFIG_KEY, which signs this pull and the report. "standalone" when
 * PLATFORM_CONFIG_URL is unset: there is nothing to pull or report to, and that is not an error.
 */
export function platformFetchSettings(env: Readonly<Record<string, unknown>>): FetchSettings {
  if (monitorMode(env) === "standalone") return { ok: false, code: "standalone" };
  const url = platformConfigUrl(env);
  if (url === null) return { ok: false, code: "config_url_invalid" };
  const problems = new Problems();
  const { config: key } = signingKeys(env, problems);
  if (key === null) return { ok: false, code: "config_key_missing" };
  if (problems.list.length > 0) return { ok: false, code: "config_key_invalid" };
  return { ok: true, url, key };
}

export interface ConfigFetchDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly random?: RandomSource;
  readonly timeoutMs?: number;
}

export type FetchOutcome = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly code: string };

/** One signed GET. Like the deep check, 401/403/404 mean "refused or not deployed" (the server hides which). */
export async function fetchPlatformConfig(settings: { readonly url: string; readonly key: string }, deps: ConfigFetchDeps): Promise<FetchOutcome> {
  // Called bare, never as deps.fetch(...): the Workers fetch throws "Illegal invocation" when called as a method.
  const { fetch } = deps;
  let response: Response;
  try {
    response = await fetch(settings.url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(deps.timeoutMs ?? CONFIG_FETCH_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(await signRequest(settings.key, { method: "GET", url: settings.url, body: "" }, deps.clock.now(), deps.random ?? systemRandom)),
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, code: name === "TimeoutError" || name === "AbortError" ? "config_timeout" : "config_network" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { ok: false, code: [401, 403, 404].includes(response.status) ? "config_rejected_or_missing" : `config_status_${String(response.status)}` };
  }
  try {
    const body = await readCapped(response, MAX_DOCUMENT_BYTES);
    return body === null ? { ok: false, code: "config_too_large" } : { ok: true, body };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, code: name === "TimeoutError" || name === "AbortError" ? "config_timeout" : "config_network" };
  }
}

const contactMap = (policy: EscalationPolicy | null): Map<string, Contact> =>
  new Map((policy?.tiers ?? []).flatMap((tier) => tier.contacts.map((contact) => [contact.id, contact] as const)));

/** Who was added, removed, or had a channel changed between two policies (by contact id; names only in the result). */
export function contactChanges(before: EscalationPolicy | null, after: EscalationPolicy | null): Omit<ConfigChange, "revision" | "updatedBy"> {
  const old = contactMap(before), now = contactMap(after);
  const added = [...now.values()].filter((contact) => !old.has(contact.id)).map((contact) => contact.name);
  const removed = [...old.values()].filter((contact) => !now.has(contact.id)).map((contact) => contact.name);
  const changed = [...now.values()].flatMap((contact) => {
    const previous = old.get(contact.id);
    if (previous === undefined) return [];
    const parts = [...(previous.sms === contact.sms ? [] : ["mobile"]), ...(previous.email === contact.email ? [] : ["email"])];
    return parts.length === 0 ? [] : [`${contact.name}: ${parts.join(" and ")} changed`];
  });
  return { added, removed, changed };
}

/** The tamper-signal emails for a policy change, or null when the contact set is unchanged. */
export function configNotices(
  before: EscalationPolicy | null,
  after: EscalationPolicy | null,
  revision: number,
  updatedBy: string | null,
): ConfigNotices | null {
  const changes = contactChanges(before, after);
  if (changes.added.length === 0 && changes.removed.length === 0 && changes.changed.length === 0) return null;
  const seen = new Set<string>();
  const recipients = [...contactMap(before).values(), ...contactMap(after).values()].flatMap((contact) => {
    if (contact.email === null || seen.has(contact.email.toLowerCase())) return [];
    seen.add(contact.email.toLowerCase());
    return [{ contactId: contact.id, contactName: contact.name, email: contact.email }];
  });
  return { change: { revision, updatedBy, ...changes }, recipients };
}

export interface ApplyResult {
  readonly outcome: AcceptOutcome | "invalid" | "unusable";
  /** Set when the document was not taken (invalid, unusable, lower or conflicting revision). */
  readonly code: string | null;
  readonly notices: number;
}

const bootstrapPolicy = (env: Readonly<Record<string, unknown>>): EscalationPolicy | null => parsePolicy(env["ESCALATION_POLICY"] ?? null);

/**
 * The policy in force before an accepted revision, for the tamper signal: the bootstrap while nothing was stored,
 * otherwise the stored revision's policy. A stored copy that no longer validates as a whole kept the run refused, so
 * its policy section is read on its own (null when that fails too, and every new contact counts as added).
 */
function previousPolicy(env: Readonly<Record<string, unknown>>, previous: StoredPlatformConfig | null, context: DocumentContext): EscalationPolicy | null {
  if (previous === null) return bootstrapPolicy(env);
  const revalidated = sectionsFromStored(previous, context);
  if (revalidated.ok) return revalidated.sections.policy;
  const policy = storedBody(previous)?.["policy"];
  return isRecord(policy) ? parsePolicy(policy) : null;
}

/**
 * Validates a fetched body and offers it to the store. A document that would leave the monitor without a usable
 * configuration (for example a policy with SMS contacts while no Twilio credentials are set) is refused, so a platform
 * edit can never switch monitoring off: the LKG stays in force and the error is recorded for the private view.
 */
export function applyPlatformDocument(store: MonitorStore, env: Readonly<Record<string, unknown>>, body: string, now: number): ApplyResult {
  const context = documentContext(env);
  const parsed = parsePlatformDocument(body, context);
  if (!parsed.ok) {
    store.recordConfigFetchError(parsed.code, parsed.errors.slice(0, 5).join("; "), now, parsed.revision);
    return { outcome: "invalid", code: parsed.code, notices: 0 };
  }
  const { document } = parsed;
  const current = store.platformConfig();
  let newPolicy: EscalationPolicy | null = null;
  if (document.revision > (current?.revision ?? 0)) {
    const candidate = loadConfig(env, document.sections);
    if (!candidate.ok) {
      // The platform cannot see the Worker's secrets or bindings, so it saved this revision; name it for the operator.
      const detail = `revision ${String(document.revision)} refused, the previous configuration stays in force: ${candidate.errors.slice(0, 5).join("; ")}`;
      store.recordConfigFetchError("config_unusable", detail, now, document.revision);
      return { outcome: "unusable", code: "config_unusable", notices: 0 };
    }
    newPolicy = candidate.config.policy;
  }
  let notices = 0;
  const outcome = store.acceptPlatformConfig(document, now, {
    notices: (previous) => {
      const queued = configNotices(previousPolicy(env, previous, context), newPolicy, document.revision, document.updatedBy);
      notices = queued?.recipients.length ?? 0;
      return queued;
    },
    // Retries already queued follow the new contacts: a removed contact is not paged again, a corrected number is used.
    policy: newPolicy,
  });
  const code = outcome === "refused_lower" ? "config_revision_lower" : outcome === "refused_conflict" ? "config_revision_conflict" : null;
  return { outcome, code, notices };
}
