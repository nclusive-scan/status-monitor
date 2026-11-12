// The platform-managed configuration: the signed pull, document validation, monotonic revision acceptance with a
// last-known-good copy in SQLite, the effective config over the env bootstrap, and the config-change tamper signal.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deepCheckHosts } from "../worker/config.ts";
import type { DocumentContext } from "../worker/platform-config.ts";
import {
  applyPlatformDocument, configNotices, contactChanges, documentContext, fetchPlatformConfig, MAX_DOCUMENT_BYTES, parsePlatformDocument,
  platformFetchSettings, resolveConfig,
} from "../worker/platform-config.ts";
import { configView } from "../worker/status-view.ts";
import { MonitorStore, RETENTION_MS } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { isRecord } from "../worker/types.ts";
import { countingRandom, examplePolicy, fixtureTargets, FakeClock, header, MINUTE, scriptedFetch, sqliteStorage, T0 } from "./support/fakes.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const KEY = "k".repeat(40);
const HEALTH_KEY = "h".repeat(40);
const exampleDocument = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(read("config/platform-config.example.json"));
  if (!isRecord(parsed)) throw new Error("example document is not an object");
  return { ...parsed };
};
const policyJson = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(read("config/escalation.example.json"));
  if (!isRecord(parsed)) throw new Error("example policy is not an object");
  return { ...parsed };
};
const EMPTY = { schema: 1, revision: 0, updatedAt: null, updatedBy: null, policy: null, targets: null, senders: null, maintenance: null };
/** The test env's PLATFORM_CONFIG_URL, whose host is the default (and only) deep-check host. */
const CONFIG_URL = "https://platform.example.com/api/v2/monitor/config";
const ORIGIN = new URL(CONFIG_URL).origin;
const HOST = new URL(CONFIG_URL).host;
const targetsJson = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(read("test/support/targets.fixture.json"));
  if (!isRecord(parsed)) throw new Error("example targets are not an object");
  return { ...parsed };
};
/** The example targets with the deep check's URL replaced. */
const targetsWithDeepUrl = (url: string): Record<string, unknown> => {
  const targets = targetsJson();
  const checks = Array.isArray(targets["checks"]) ? targets["checks"].filter(isRecord) : [];
  return { ...targets, checks: checks.map((check) => (check["type"] === "deep" ? { ...check, url } : check)) };
};

const env = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  MONITOR_TARGETS: read("test/support/targets.fixture.json"),
  ESCALATION_POLICY: read("config/escalation.example.json"),
  STATUS_PAGE_URL: "https://status.example.com",
  TWILIO_WEBHOOK_URL: "https://status.example.com/hooks/twilio",
  MONITOR_CONFIG_KEY: KEY,
  MONITOR_HEALTH_KEY: HEALTH_KEY,
  ACK_SIGNING_KEY: KEY,
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM: "+15555550123",
  ALERT_EMAIL: { send: () => Promise.resolve({ messageId: "m" }) },
  ALERT_EMAIL_FROM: "alerts@example.com",
  PLATFORM_CONFIG_URL: CONFIG_URL,
  ...overrides,
});

/** A document at `revision`, with the example policy changed by `edit`. */
function documentAt(revision: number, edit: (policy: Record<string, unknown>) => void = () => undefined, extra: Record<string, unknown> = {}): string {
  const policy = policyJson();
  edit(policy);
  return JSON.stringify({ ...exampleDocument(), revision, policy, ...extra });
}

const tiersOf = (policy: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(policy["tiers"]) ? policy["tiers"] : []).filter(isRecord).map((tier) => tier);
const contactsOf = (tier: Record<string, unknown>): Record<string, unknown>[] =>
  (Array.isArray(tier["contacts"]) ? tier["contacts"] : []).filter(isRecord).map((contact) => contact);

/** The validation context of the default env: the deep check on the platform's host, the built-in components. */
const CONTEXT: DocumentContext = documentContext({
  MONITOR_TARGETS: read("test/support/targets.fixture.json"), PLATFORM_CONFIG_URL: CONFIG_URL, ALERT_EMAIL_FROM: "alerts@example.com",
});

function newStore() {
  const storage = sqliteStorage();
  return { storage, store: new MonitorStore(storage, countingRandom()) };
}

void test("document: the example and the empty answer validate; the sections keep the Worker's own parsers", () => {
  const example = parsePlatformDocument(JSON.stringify(exampleDocument()), CONTEXT);
  assert.ok(example.ok, example.ok ? "" : example.errors.join("\n"));
  assert.equal(example.document.revision, 7);
  assert.equal(example.document.updatedBy, "Display Name");
  assert.deepEqual(example.document.sections.policy, examplePolicy());
  assert.equal(example.document.sections.targets, null, "null targets: use the Worker's built-in MONITOR_TARGETS");
  assert.deepEqual(example.document.sections.senders, {
    smsFrom: "+15555550123", smsMessagingServiceSid: null, emailFrom: "alerts@example.com", emailFromName: "Example Status",
  });
  const empty = parsePlatformDocument(JSON.stringify(EMPTY), CONTEXT);
  assert.ok(empty.ok);
  assert.deepEqual(empty.document.sections, { revision: 0, policy: null, targets: null, senders: null, maintenance: [] });
});

void test("document: anything off is refused with a code and the problems", () => {
  const refused = (body: string, code: string, pattern?: RegExp): void => {
    const parsed = parsePlatformDocument(body, CONTEXT);
    assert.equal(parsed.ok, false, body.slice(0, 80));
    assert.equal(parsed.code, code);
    if (pattern !== undefined) assert.match(parsed.errors.join("\n"), pattern);
  };
  refused("{", "config_invalid_json");
  refused("[]", "config_invalid");
  refused(JSON.stringify({ ...exampleDocument(), schema: 2 }), "config_invalid", /schema: must be 1/);
  refused(JSON.stringify({ ...exampleDocument(), revision: -1 }), "config_invalid", /revision/);
  refused(JSON.stringify({ ...exampleDocument(), revision: "7" }), "config_invalid", /revision/);
  refused(JSON.stringify({ ...EMPTY, policy: policyJson() }), "config_invalid", /must carry no sections/);
  refused(JSON.stringify({ ...exampleDocument(), policy: null }), "config_invalid", /policy: must be an object/);
  refused(JSON.stringify({ ...exampleDocument(), policy: JSON.stringify(policyJson()) }), "config_invalid", /policy: must be an object/);
  refused(documentAt(7, (policy) => {
    policy["maxCycles"] = 0;
  }), "config_invalid", /maxCycles/);
  refused(documentAt(7, () => undefined, { senders: { emailFrom: "ceo@example.com" } }), "config_invalid", /must be the ALERT_EMAIL binding's allowed sender/);
  const noFrom = parsePlatformDocument(JSON.stringify(exampleDocument()), { ...CONTEXT, alertEmailFrom: null });
  assert.ok(!noFrom.ok && /senders\.emailFrom: must be null: the Worker has no ALERT_EMAIL_FROM/.test(noFrom.errors.join("\n")),
    "without ALERT_EMAIL_FROM no emailFrom is accepted");
  const targets: unknown = JSON.parse(read("test/support/targets.fixture.json"));
  const checks = isRecord(targets) && Array.isArray(targets["checks"]) ? targets["checks"].filter(isRecord) : [];
  const deep = checks.find((check) => check["type"] === "deep") ?? {};
  refused(documentAt(7, () => undefined, { targets: { ...(isRecord(targets) ? targets : {}), checks: [...checks, { ...deep, id: "deep_two" }] } }),
    "config_invalid", /at most one deep check/);
  refused(documentAt(7, () => undefined, { updatedBy: "x".repeat(MAX_DOCUMENT_BYTES) }), "config_too_large");
});

void test("document: the editor's name is kept to one printable line", () => {
  const parsed = parsePlatformDocument(documentAt(7, () => undefined, { updatedBy: "Dana\r\nBcc: x@evil.test" }), CONTEXT);
  assert.ok(parsed.ok);
  assert.equal(parsed.document.updatedBy, "Dana Bcc: x@evil.test");
});

void test("fetch settings: PLATFORM_CONFIG_URL at its exact path over https, and a usable config key; unset is standalone", () => {
  assert.deepEqual(platformFetchSettings(env()), { ok: true, url: CONFIG_URL, key: KEY });
  assert.deepEqual(platformFetchSettings(env({ PLATFORM_CONFIG_URL: undefined })), { ok: false, code: "standalone" }, "no URL: nothing to pull");
  assert.deepEqual(platformFetchSettings(env({ PLATFORM_CONFIG_URL: undefined, MONITOR_CONFIG_KEY: undefined })), { ok: false, code: "standalone" });
  assert.deepEqual(platformFetchSettings(env({ PLATFORM_CONFIG_URL: "https://staging.example.com/api/v2/monitor/config" })),
    { ok: true, url: "https://staging.example.com/api/v2/monitor/config", key: KEY });
  for (const url of [`http://${HOST}/api/v2/monitor/config`, `https://${HOST}/api/v2/monitor/health`, `https://user:pass@${HOST}/api/v2/monitor/config`,
    `https://${HOST}/api/v2/monitor/config?x=1`]) {
    assert.deepEqual(platformFetchSettings(env({ PLATFORM_CONFIG_URL: url })), { ok: false, code: "config_url_invalid" }, url);
  }
  assert.deepEqual(platformFetchSettings(env({ MONITOR_CONFIG_KEY: undefined })), { ok: false, code: "config_key_missing" });
  assert.deepEqual(platformFetchSettings(env({ MONITOR_CONFIG_KEY: `${KEY}\n` })), { ok: false, code: "config_key_invalid" });
  assert.deepEqual(platformFetchSettings(env({ MONITOR_HEALTH_KEY: KEY })), { ok: false, code: "config_key_invalid" }, "the two keys must differ");
});

void test("fetch: one signed GET of the config path, no redirects followed, the body returned as text", async () => {
  const body = JSON.stringify(exampleDocument());
  const { fetch, calls } = scriptedFetch(() => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
  const result = await fetchPlatformConfig({ url: CONFIG_URL, key: KEY }, { fetch, clock: new FakeClock(), random: countingRandom() });
  assert.deepEqual(result, { ok: true, body });
  const init = calls[0]?.init;
  assert.equal(calls[0]?.url, CONFIG_URL);
  assert.equal(init?.method, "GET");
  assert.equal(init.redirect, "manual");
  const timestamp = header(init, "x-status-monitor-timestamp") ?? "", nonce = header(init, "x-status-monitor-nonce") ?? "";
  assert.equal(timestamp, String(Math.floor(T0 / 1000)));
  const canonical = `v2\nGET\n${HOST}\n/api/v2/monitor/config\n${timestamp}\n${nonce}\n${createHash("sha256").update("").digest("hex")}`;
  const expected = createHmac("sha256", Buffer.from(KEY, "utf8")).update(canonical).digest("hex");
  assert.equal(header(init, "x-status-monitor-signature"), `v2=${expected}`);
});

void test("fetch: refusals, server errors, timeouts, network errors and oversized bodies become short codes", async () => {
  const outcome = async (handler: () => Response | Promise<Response>) =>
    fetchPlatformConfig({ url: CONFIG_URL, key: KEY }, { fetch: scriptedFetch(handler).fetch, clock: new FakeClock() });
  for (const status of [401, 403, 404]) {
    assert.deepEqual(await outcome(() => new Response("AUTHENTICATION_REQUIRED", { status })), { ok: false, code: "config_rejected_or_missing" });
  }
  assert.deepEqual(await outcome(() => new Response("", { status: 503 })), { ok: false, code: "config_status_503" });
  assert.deepEqual(await outcome(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })),
    { ok: false, code: "config_status_302" });
  assert.deepEqual(await outcome(() => {
    throw new DOMException("timed out", "TimeoutError");
  }), { ok: false, code: "config_timeout" });
  assert.deepEqual(await outcome(() => {
    throw new TypeError("fetch failed");
  }), { ok: false, code: "config_network" });
  assert.deepEqual(await outcome(() => new Response("x".repeat(MAX_DOCUMENT_BYTES + 1))), { ok: false, code: "config_too_large" });
});

void test("bootstrap: with nothing stored the env's MONITOR_TARGETS and ESCALATION_POLICY are the configuration", () => {
  const { store } = newStore();
  const loaded = resolveConfig(env(), store.platformConfig());
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.config.source, { kind: "bootstrap" });
  const refused = resolveConfig(env({ ESCALATION_POLICY: undefined }), store.platformConfig());
  assert.equal(refused.ok, false, "neither a platform policy nor ESCALATION_POLICY: refuse, as before");
});

void test("accept: a higher revision becomes the last known good, survives a restart and wins over the bootstrap", () => {
  const { storage, store } = newStore();
  const result = applyPlatformDocument(store, env({ ESCALATION_POLICY: undefined }), documentAt(7, (policy) => {
    policy["maxCycles"] = 2;
  }), T0);
  assert.deepEqual(result, { outcome: "accepted", code: null, notices: 4 }, "first revision over no bootstrap: every email contact told");
  const restarted = new MonitorStore(storage, countingRandom());
  const stored = restarted.platformConfig();
  assert.deepEqual([stored?.revision, stored?.updatedBy, stored?.updatedAt, stored?.fetchedAt], [7, "Display Name", "2026-11-11T20:00:00.000Z", T0]);
  const loaded = resolveConfig(env({ ESCALATION_POLICY: undefined }), stored ?? null);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("\n"));
  assert.deepEqual(loaded.config.source, { kind: "platform", revision: 7 });
  assert.equal(loaded.config.policy.maxCycles, 2);
  assert.equal(restarted.configFetchStatus().lastSuccessAt, T0);
});

void test("accept: the same revision and body is a no-op; a lower revision or a changed body under the same number is refused", () => {
  const { store } = newStore();
  assert.equal(applyPlatformDocument(store, env(), documentAt(7), T0).outcome, "accepted");
  assert.deepEqual(applyPlatformDocument(store, env(), documentAt(7), T0 + MINUTE), { outcome: "unchanged", code: null, notices: 0 });
  assert.equal(store.platformConfig()?.fetchedAt, T0 + MINUTE, "an unchanged revision records the confirmation");

  const lower = applyPlatformDocument(store, env(), documentAt(5, (policy) => {
    policy["maxCycles"] = 1;
  }), T0 + 2 * MINUTE);
  assert.deepEqual(lower, { outcome: "refused_lower", code: "config_revision_lower", notices: 0 });
  assert.equal(store.platformConfig()?.revision, 7);
  assert.deepEqual(store.configFetchStatus(), {
    lastSuccessAt: T0 + MINUTE, lastErrorCode: "config_revision_lower", lastErrorAt: T0 + 2 * MINUTE, lastErrorDetail: "offered revision 5, stored 7",
    lastErrorRevision: 5,
  });

  const conflict = applyPlatformDocument(store, env(), documentAt(7, (policy) => {
    policy["maxCycles"] = 1;
  }), T0 + 3 * MINUTE);
  assert.equal(conflict.outcome, "refused_conflict");
  assert.equal(store.configFetchStatus().lastErrorCode, "config_revision_conflict");
  assert.equal(applyPlatformDocument(store, env(), JSON.stringify(EMPTY), T0 + 4 * MINUTE).outcome, "refused_lower", "a reset platform is refused");
  const loaded = resolveConfig(env(), store.platformConfig());
  assert.ok(loaded.ok && loaded.config.policy.maxCycles === 3 && loaded.config.source.kind === "platform");

  assert.equal(applyPlatformDocument(store, env(), documentAt(8), T0 + 5 * MINUTE).outcome, "accepted");
  assert.equal(store.configFetchStatus().lastErrorCode, null, "a good pull clears the error");
});

void test("accept: 'nothing saved yet' keeps the bootstrap and counts as a successful pull", () => {
  const { store } = newStore();
  assert.deepEqual(applyPlatformDocument(store, env(), JSON.stringify(EMPTY), T0), { outcome: "empty", code: null, notices: 0 });
  assert.equal(store.platformConfig(), null);
  assert.equal(store.configFetchStatus().lastSuccessAt, T0);
  const loaded = resolveConfig(env(), store.platformConfig());
  assert.ok(loaded.ok && loaded.config.source.kind === "bootstrap");
});

void test("last known good: an invalid document, an unusable one or a failed pull leaves the stored revision in force", () => {
  const { store } = newStore();
  applyPlatformDocument(store, env(), documentAt(7), T0);
  const invalid = applyPlatformDocument(store, env(), JSON.stringify({ ...exampleDocument(), revision: 9, policy: { version: 1, tiers: [] } }), T0 + MINUTE);
  assert.equal(invalid.outcome, "invalid");
  assert.equal(store.configFetchStatus().lastErrorCode, "config_invalid");
  assert.match(store.configFetchStatus().lastErrorDetail ?? "", /policy\.tiers/);

  // SMS contacts while the Worker holds no Twilio credentials: valid on its own, but it would switch monitoring off.
  const noTwilio = env({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined });
  const unusable = applyPlatformDocument(store, noTwilio, documentAt(9), T0 + 2 * MINUTE);
  assert.deepEqual(unusable, { outcome: "unusable", code: "config_unusable", notices: 0 });
  // The platform saved revision 9 and shows it as current, so the private view names the revision it refused.
  assert.match(store.configFetchStatus().lastErrorDetail ?? "", /^revision 9 refused, the previous configuration stays in force: .*TWILIO_\*: required/);

  store.recordConfigFetchError("config_timeout", "", T0 + 3 * MINUTE);
  assert.equal(store.platformConfig()?.revision, 7);
  const loaded = resolveConfig(env({ ESCALATION_POLICY: undefined }), store.platformConfig());
  assert.ok(loaded.ok && loaded.config.source.kind === "platform", "the platform being down never stops monitoring");
});

void test("last known good: a stored copy the Worker's parsers now refuse stops the run, never reviving the bootstrap", () => {
  const { store } = newStore();
  // Revision 7 was accepted by an older Worker that allowed two deep checks; this one allows at most one.
  const targets = targetsJson();
  const checks = Array.isArray(targets["checks"]) ? targets["checks"].filter(isRecord) : [];
  const deep = checks.find((check) => check["type"] === "deep") ?? {};
  const staleTargets = { ...targets, checks: [...checks, { ...deep, id: "deep_two" }] };
  const stale = JSON.stringify({ policy: policyJson(), targets: staleTargets, senders: null, maintenance: [] });
  assert.equal(store.acceptPlatformConfig({ revision: 7, updatedAt: null, updatedBy: "Dana Admin", body: stale }, T0), "accepted");

  // ESCALATION_POLICY and MONITOR_TARGETS are still set: they must not take over once a platform revision is stored.
  const loaded = resolveConfig(env(), store.platformConfig());
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors.join("\n"), /^platform revision 7: the stored copy no longer validates; save a new revision\n.*at most one deep check/);
  const withoutBootstrap = resolveConfig(env({ ESCALATION_POLICY: undefined, MONITOR_TARGETS: undefined }), store.platformConfig());
  assert.equal(withoutBootstrap.ok, false);
  assert.deepEqual([configView(store, loaded).source, configView(store, loaded).revision], ["platform", 7], "the view names the stored revision");

  // The platform keeps serving revision 7, refused on every pull; saving revision 8 recovers.
  const served = JSON.stringify({ ...exampleDocument(), revision: 7, policy: policyJson(), targets: staleTargets });
  assert.equal(applyPlatformDocument(store, env(), served, T0 + MINUTE).outcome, "invalid");
  // Same contacts as the stored policy section, which is still read on its own for the tamper signal: no notice.
  assert.deepEqual(applyPlatformDocument(store, env(), documentAt(8), T0 + 2 * MINUTE), { outcome: "accepted", code: null, notices: 0 });
  const recovered = resolveConfig(env(), store.platformConfig());
  assert.ok(recovered.ok && recovered.config.source.kind === "platform" && recovered.config.source.revision === 8);
});

void test("last known good: an unreadable stored body stops the run too", () => {
  const { storage, store } = newStore();
  applyPlatformDocument(store, env(), documentAt(7), T0);
  storage.db.exec(`UPDATE platform_config SET body = '{"policy":{"version":2}}'`);
  const loaded = resolveConfig(env(), store.platformConfig());
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors.join("\n"), /platform revision 7: the stored copy no longer validates[\s\S]*policy\.version/);
});

void test("deep check: every deep check must use a DEEP_CHECK_HOSTS host (default: PLATFORM_CONFIG_URL's host)", () => {
  assert.deepEqual(deepCheckHosts(env()), new Set([HOST]));
  assert.deepEqual(deepCheckHosts(env({ PLATFORM_CONFIG_URL: "https://staging.example.com:8443/api/v2/monitor/config" })),
    new Set(["staging.example.com:8443"]));
  assert.deepEqual(deepCheckHosts(env({ DEEP_CHECK_HOSTS: "a.example.com, b.example.com:8443" })), new Set(["a.example.com", "b.example.com:8443"]));
  assert.equal(deepCheckHosts(env({ DEEP_CHECK_HOSTS: "https://a.example.com/" })), null, "hosts, not URLs");
  // Read like a protocol server's allowed authorities (canonicalAuthority): case-insensitive, the default port dropped.
  assert.deepEqual(deepCheckHosts(env({ DEEP_CHECK_HOSTS: `${HOST}:443` })), new Set([HOST]));
  assert.deepEqual(deepCheckHosts(env({ DEEP_CHECK_HOSTS: "Platform.Example.COM, B.example.com:8443" })),
    new Set([HOST, "b.example.com:8443"]));
  assert.equal(deepCheckHosts(env({ DEEP_CHECK_HOSTS: "a.example.com:0" })), null, "port 0 is not a port");
  assert.equal(deepCheckHosts(env({ DEEP_CHECK_HOSTS: "a.example.com:65536" })), null);
  // Read like a protocol server's allowed authorities: a stray comma makes the value unusable on both sides, so a value
  // one side accepts is never refused by the other for it. Single-label hosts are refused here (a Worker cannot call them).
  const tooLong = `${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.com`;
  for (const value of ["a.example.com,", ",a.example.com", "a.example.com, ", "a.example.com,,b.example.com", "localhost:8443", "intranet", tooLong]) {
    assert.equal(deepCheckHosts(env({ DEEP_CHECK_HOSTS: value })), null, value);
  }
  assert.deepEqual(deepCheckHosts(env({ DEEP_CHECK_HOSTS: " A.Example.com:443 , b.example.com:8443 " })), new Set(["a.example.com", "b.example.com:8443"]));
  assert.equal(deepCheckHosts(env({ PLATFORM_CONFIG_URL: "http://staging.example.com/api/v2/monitor/config" })), null);

  const at = (url: string): string => JSON.stringify({ ...exampleDocument(), targets: targetsWithDeepUrl(url) });
  const ok = parsePlatformDocument(at(`${ORIGIN}/api/v2/monitor/health`), CONTEXT);
  assert.ok(ok.ok, ok.ok ? "" : ok.errors.join("\n"));
  for (const url of ["https://collector.attacker.example/api/v2/monitor/health", `https://${HOST}:8443/api/v2/monitor/health`,
    "https://signup.example.test/api/v2/monitor/health"]) {
    const refused = parsePlatformDocument(at(url), CONTEXT);
    assert.equal(refused.ok, false, url);
    assert.match(
      refused.errors.join("\n"),
      /targets\.checks\.platform_deep\.url: host must be one of DEEP_CHECK_HOSTS \(platform\.example\.com\)/, url,
    );
  }
  const query = parsePlatformDocument(at(`${ORIGIN}/api/v2/monitor/health?x=1`), CONTEXT);
  assert.match(query.ok ? "" : query.errors.join("\n"), /must have no query or fragment/, "a signed request carries no query");
  const mixedCase = parsePlatformDocument(at(`${ORIGIN}/api/v2/monitor/health`),
    { ...CONTEXT, deepHosts: deepCheckHosts(env({ DEEP_CHECK_HOSTS: "PLATFORM.example.COM:443" })) });
  assert.ok(mixedCase.ok, "the value a server reads as its host allows the same deep check here");
  const noHosts = parsePlatformDocument(at(`${ORIGIN}/api/v2/monitor/health`), { ...CONTEXT, deepHosts: null });
  assert.match(noHosts.ok ? "" : noHosts.errors.join("\n"), /needs DEEP_CHECK_HOSTS \(or a valid PLATFORM_CONFIG_URL\)/);

  // Through the pull: refused as invalid, nothing stored, and so never signed for.
  const { store } = newStore();
  const result = applyPlatformDocument(store, env(), at("https://collector.attacker.example/api/v2/monitor/health"), T0);
  assert.deepEqual(result, { outcome: "invalid", code: "config_invalid", notices: 0 });
  assert.equal(store.platformConfig(), null);
  // An allowlisted second host is accepted.
  const second = applyPlatformDocument(store, env({ DEEP_CHECK_HOSTS: `${HOST},health.example.com` }),
    at("https://health.example.com/api/v2/monitor/health"), T0);
  assert.equal(second.outcome, "accepted");
  // The same stored revision under a narrower allowlist no longer validates.
  assert.equal(resolveConfig(env(), store.platformConfig()).ok, false);
  // The bootstrap is held to the allowlist too.
  const bootstrap = resolveConfig(env({ PLATFORM_CONFIG_URL: "https://staging.example.com/api/v2/monitor/config" }), null);
  assert.ok(!bootstrap.ok);
  assert.match(bootstrap.errors.join("\n"), /host must be one of DEEP_CHECK_HOSTS \(staging\.example\.com\)/);
});

/** One run of the example targets with the given components failing. */
const runOf = (at: number, down: readonly string[]): CheckResult[] =>
  fixtureTargets().components.map((component) => ({
    checkId: `${component.id}_http`, componentId: component.id, type: "http", status: down.includes(component.id) ? "down" : "ok", inconclusive: false,
    latencyMs: 10, detail: "x", observedAt: at, data: null,
  }));

/** A store with a signup incident paging the primary tier, whose SMS page failed with a retryable error. */
function failedPage() {
  const { store } = newStore();
  store.recordRun(runOf(T0, ["signup"]), fixtureTargets(), examplePolicy(), T0);
  store.recordRun(runOf(T0 + MINUTE, ["signup"]), fixtureTargets(), examplePolicy(), T0 + MINUTE);
  const claimed = store.claimDue(T0 + MINUTE);
  for (const { row } of claimed) store.markFailed(row.key, "twilio_http_503", true, T0 + MINUTE);
  const sms = claimed.find(({ row }) => row.channel === "sms")?.row;
  if (sms === undefined) throw new Error("no SMS page queued");
  assert.deepEqual([sms.kind, sms.contactId, sms.recipient], ["page", "primary_oncall", "+15555550100"]);
  return { store, key: sms.key };
}

void test("queued retries: a corrected number takes over the pending page; the email and config notices are untouched", () => {
  const { store, key } = failedPage();
  const result = applyPlatformDocument(store, env(), documentAt(7, (policy) => {
    const [oncall] = contactsOf(tiersOf(policy)[0] ?? {});
    if (oncall !== undefined) oncall["sms"] = "+15555550198";
  }), T0 + 2 * MINUTE);
  assert.equal(result.outcome, "accepted");
  const retried = store.claimDue(T0 + 5 * MINUTE);
  assert.equal(retried.find(({ row }) => row.key === key)?.row.recipient, "+15555550198", "the retry goes to the corrected number");
  assert.equal(retried.find(({ row }) => row.kind === "page" && row.channel === "email")?.row.recipient, "primary@example.com");
  assert.ok(store.events().some((event) => event.detail === "revision 7: cancelled 0, re-addressed 1 pending"));
});

void test("queued retries: a removed contact's pending pages are cancelled, while the config notice still tells them", () => {
  const { store, key } = failedPage();
  const result = applyPlatformDocument(store, env(), documentAt(7, (policy) => {
    const [primary] = tiersOf(policy);
    if (primary !== undefined) primary["contacts"] = [{ id: "new_oncall", name: "New On-call", sms: "+15555550111" }];
  }), T0 + 2 * MINUTE);
  assert.equal(result.outcome, "accepted");
  const pages = store.notifications().filter((row) => row.kind === "page" && row.contactId === "primary_oncall");
  assert.deepEqual(pages.map((row) => row.status), ["cancelled", "cancelled"]);
  assert.ok(store.claimDue(T0 + 5 * MINUTE).every(({ row }) => row.key !== key));
  const notice = store.notifications().find((row) => row.kind === "config_change" && row.recipient === "primary@example.com");
  assert.equal(notice?.status, "pending", "the removed contact still learns of the change");
  assert.ok(store.events().some((event) => event.detail === "revision 7: cancelled 2, re-addressed 0 pending"));
});

void test("queued retries: a revision that keeps the contacts leaves the outbox alone", () => {
  const { store } = failedPage();
  const before = store.notifications();
  assert.equal(applyPlatformDocument(store, env(), documentAt(7, (policy) => {
    policy["maxCycles"] = 2;
  }), T0 + 2 * MINUTE).outcome, "accepted");
  assert.deepEqual(store.notifications(), before);
});

void test("tamper signal: a contact change emails every email contact of the old and new policy, never by SMS", () => {
  const { store } = newStore();
  // First revision equal to the bootstrap: same contacts, no notice.
  assert.deepEqual(applyPlatformDocument(store, env(), documentAt(7), T0), { outcome: "accepted", code: null, notices: 0 });
  const result = applyPlatformDocument(store, env(), documentAt(8, (policy) => {
    const [primary, secondary, third] = tiersOf(policy);
    if (primary === undefined || secondary === undefined || third === undefined) throw new Error("example tiers missing");
    const [oncall] = contactsOf(primary);
    if (oncall !== undefined) oncall["sms"] = "+15555550166";
    third["contacts"] = [{ id: "new_vendor", name: "New Vendor", email: "new-vendor@example.com" }, { id: "pager_only", name: "Pager Only",
      sms: "+15555550177" }];
  }, { updatedBy: "Dana Admin" }), T0 + MINUTE);
  assert.equal(result.outcome, "accepted");
  const rows = store.notifications().filter((row) => row.kind === "config_change");
  assert.deepEqual(rows.map((row) => row.recipient).sort(),
    ["lead@example.com", "new-vendor@example.com", "primary@example.com", "secondary@example.com", "support@example.com"],
    "old and new email contacts, each once; the SMS-only contact gets nothing");
  assert.equal(result.notices, 5);
  assert.ok(rows.every((row) => row.channel === "email" && row.incidentId === "cfg_r8" && row.status === "pending"));
  assert.deepEqual(rows[0]?.configChange, {
    revision: 8, updatedBy: "Dana Admin", added: ["New Vendor", "Pager Only"], removed: ["Vendor Support"], changed: ["Primary On-call: mobile changed"],
  });
  const claimed = store.claimDue(T0 + MINUTE).filter(({ row }) => row.kind === "config_change");
  assert.equal(claimed.length, 5);
  assert.ok(claimed.every(({ incident }) => incident === null), "a config notice belongs to no incident");
  store.markSent(claimed[0]?.row.key ?? "", "cfemail:1", T0 + MINUTE);
  assert.equal(store.nextWakeAt(), T0 + MINUTE + 180_000, "the rest stay due until delivered");
});

void test("tamper signal: changes that leave the contacts alone send nothing", () => {
  const { store } = newStore();
  applyPlatformDocument(store, env(), documentAt(7), T0);
  const result = applyPlatformDocument(store, env(), documentAt(8, (policy) => {
    policy["maxCycles"] = 1;
    const [primary] = tiersOf(policy);
    if (primary !== undefined) primary["ackTimeoutMinutes"] = 2;
  }), T0 + MINUTE);
  assert.deepEqual(result, { outcome: "accepted", code: null, notices: 0 });
  assert.equal(store.notifications().length, 0);
});

void test("tamper signal: added, removed and changed contacts are computed by id, with names only", () => {
  const before = examplePolicy();
  assert.equal(configNotices(before, before, 3, "x"), null);
  const after = { ...before, tiers: before.tiers.map((tier) => ({
    ...tier,
    contacts: tier.contacts.flatMap((contact) => {
      if (contact.id === "engineering_lead") return [];
      return [contact.id === "secondary_oncall" ? { ...contact, sms: "+15555550198", email: "other@example.com" } : contact];
    }),
  })) };
  assert.deepEqual(contactChanges(before, after), { added: [], removed: ["Engineering Lead"], changed: ["Secondary On-call: mobile and email changed"] });
  const notices = configNotices(before, after, 3, null);
  assert.deepEqual(notices?.recipients.map((recipient) => recipient.email),
    ["primary@example.com", "secondary@example.com", "lead@example.com", "support@example.com", "other@example.com"]);
});

void test("config notices are pruned with the rest of the history", () => {
  const { store } = newStore();
  applyPlatformDocument(store, env({ ESCALATION_POLICY: undefined }), documentAt(7), T0);
  assert.ok(store.notifications().length > 0);
  store.prune(T0 + RETENTION_MS + MINUTE);
  assert.equal(store.notifications().length, 0);
});
