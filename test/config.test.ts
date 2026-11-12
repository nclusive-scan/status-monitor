// Configuration loads strictly and fails closed; the committed wrangler configs keep the Worker private.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BRAND_NAME_MAX_CHARS, brandOf, DEFAULT_BRAND_NAME, withNoun } from "../worker/brand.ts";
import { alertEmailFrom, loadConfig, monitorMode, parsePolicy, parseSenders, parseTargets, Problems, statusViewKey } from "../worker/config.ts";
import type { PlatformSections, TargetsConfig } from "../worker/config.ts";
import { isRecord } from "../worker/types.ts";
import { ADOPTED_EMAIL_FROM, ADOPTED_STATUS_HOST, adoptedMonitorWrangler } from "./support/adopted.ts";
import { bootstrapTargets, examplePolicy, fixtureTargets } from "./support/fakes.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Strips // line comments outside strings, enough for the committed .jsonc files. */
const jsonc = (source: string): unknown => JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
const KEY = "x".repeat(40);
const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
};
const records = (value: unknown): Readonly<Record<string, unknown>>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const validEnv = (): Record<string, unknown> => ({
  MONITOR_TARGETS: read("test/support/targets.fixture.json"),
  ESCALATION_POLICY: read("config/escalation.example.json"),
  STATUS_PAGE_URL: "https://status.example.com",
  TWILIO_WEBHOOK_URL: "https://status.example.com/hooks/twilio",
  MONITOR_HEALTH_KEY: "h".repeat(40),
  MONITOR_CONFIG_KEY: "c".repeat(40),
  ACK_SIGNING_KEY: KEY,
  TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM: "+15555550123",
  ALERT_EMAIL: { send: () => Promise.resolve({ messageId: "m" }) },
  ALERT_EMAIL_FROM: "alerts@example.com",
  BRAND_NAME: "Acme",
  // The fixture's deep check calls platform.example.com; standalone, DEEP_CHECK_HOSTS names it.
  DEEP_CHECK_HOSTS: "platform.example.com",
});

void test("the example targets watch example.com only: a website and an API health check, both paging and public", () => {
  const targets = bootstrapTargets();
  assert.deepEqual(targets.components, [
    { id: "website", name: "Website", pageOn: "down", alert: "page", public: true },
    { id: "api", name: "API", pageOn: "down", alert: "page", public: true },
  ]);
  const byId = new Map(targets.checks.map((check) => [check.id, check]));
  const web = byId.get("website_http"), api = byId.get("api_health");
  assert.ok(web?.type === "http" && web.url === "https://example.com/" && web.maxRedirects === 2 && web.bodyIncludes === null, "website");
  assert.ok(api?.type === "http" && api.url === "https://api.example.com/health" && api.maxRedirects === 0 && api.bodyIncludes === "\"ok\":true", "API");
  assert.equal(targets.checks.length, 2);
  for (const check of targets.checks) {
    if (check.type !== "dns") assert.match(new URL(check.url).hostname, /(^|\.)example\.com$/, "RFC 2606 names only");
  }
  assert.equal(targets.openAfterFailures, 2);
  assert.equal(targets.resolveAfterPasses, 3);
});

void test("the example policy has primary, secondary and third_party tiers with placeholder contacts only", () => {
  const policy = examplePolicy();
  assert.deepEqual(policy.tiers.map((tier) => [tier.id, tier.ackTimeoutMinutes]), [["primary", 5], ["secondary", 10], ["third_party", 15]]);
  assert.equal(policy.maxCycles, 3);
  for (const contact of policy.tiers.flatMap((tier) => tier.contacts)) {
    if (contact.sms !== null) assert.match(contact.sms, /^\+155555501\d\d$/);
    if (contact.email !== null) assert.match(contact.email, /@example\.com$/);
  }
});

void test("a complete environment loads", () => {
  const loaded = loadConfig(validEnv());
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("\n"));
  assert.equal(loaded.config.statusPageUrl, "https://status.example.com");
  assert.equal(loaded.config.twilio?.username, `AC${"0".repeat(32)}`);
  assert.equal(loaded.config.twilio.authToken, "token");
  assert.deepEqual(loaded.config.email, { from: "alerts@example.com", fromName: "Acme Status" });
  assert.equal(loaded.config.deliveryMode, "live", "live unless DELIVERY_MODE says log");
  assert.deepEqual(loaded.config.source, { kind: "bootstrap" });
  assert.equal(loaded.config.brandName, "Acme");
  assert.equal(loaded.config.mode, "standalone", "no PLATFORM_CONFIG_URL: standalone");
});

void test("BRAND_NAME: default Status, a custom name is used as given, and an unusable one refuses the configuration", () => {
  const plain = loadConfig({ ...validEnv(), BRAND_NAME: undefined });
  assert.ok(plain.ok, plain.ok ? "" : plain.errors.join("\n"));
  assert.equal(plain.config.brandName, DEFAULT_BRAND_NAME);
  assert.equal(plain.config.brandName, "Status");
  assert.deepEqual(plain.config.email, { from: "alerts@example.com", fromName: "Status" }, "the default From name is not \"Status Status\"");
  for (const brand of ["Acme", "Acme Health", "A&B Clinics", "St. Mary's (East)", "X", "a".repeat(BRAND_NAME_MAX_CHARS)]) {
    const loaded = loadConfig({ ...validEnv(), BRAND_NAME: brand });
    assert.ok(loaded.ok && loaded.config.brandName === brand, brand);
  }
  const trimmed = loadConfig({ ...validEnv(), BRAND_NAME: "  Acme  " });
  assert.ok(trimmed.ok && trimmed.config.brandName === "Acme", "surrounding whitespace is trimmed");
  for (const brand of [
    "a".repeat(BRAND_NAME_MAX_CHARS + 1), "Acme\nHealth", "Acme  Health", "-Acme", "<Acme>", "\"Acme\"", "Acme|Health", "Acme [Health]", "Café",
    "Acme 🚑", "Acme€",
  ]) {
    const loaded = loadConfig({ ...validEnv(), BRAND_NAME: brand });
    assert.equal(loaded.ok, false, brand);
    assert.match(loaded.errors.join("\n"), /BRAND_NAME: must be 1 to 24 characters/, brand);
    assert.equal(brandOf({ BRAND_NAME: brand }), "Status", "the pages fall back to the default");
  }
  assert.equal(withNoun("Status", "status"), "Status");
  assert.equal(withNoun("Acme", "status"), "Acme status");
});

void test("ALERT_EMAIL_FROM: required when a contact has an email, must be an address, and sets the sender; the name is optional", () => {
  const missing = loadConfig({ ...validEnv(), ALERT_EMAIL_FROM: undefined });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join("\n"), /ALERT_EMAIL_FROM: required: a contact has an email channel/);
  const invalid = loadConfig({ ...validEnv(), ALERT_EMAIL_FROM: "alerts at example.com" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /ALERT_EMAIL_FROM: must be an email address/);
  const upper = loadConfig({ ...validEnv(), ALERT_EMAIL_FROM: "Alerts@Example.COM" });
  assert.ok(upper.ok && upper.config.email?.from === "alerts@example.com", "kept lowercase");
  const named = loadConfig({ ...validEnv(), ALERT_EMAIL_FROM_NAME: "Acme On-call" });
  assert.ok(named.ok && named.config.email?.fromName === "Acme On-call");
  const badName = loadConfig({ ...validEnv(), ALERT_EMAIL_FROM_NAME: "Acme <alerts@example.com>" });
  assert.equal(badName.ok, false);
  assert.match(badName.errors.join("\n"), /ALERT_EMAIL_FROM_NAME: must be 1 to 60 characters/);
  const smsOnly = parsePolicy({ version: 1, tiers: [{ id: "t", name: "T", contacts: [{ id: "a", name: "A", sms: "+15555550100" },
    { id: "b", name: "B", sms: "+15555550101" }] }] });
  assert.ok(smsOnly !== null);
  const noEmail = loadConfig({ ...validEnv(), ESCALATION_POLICY: JSON.stringify(smsOnly), ALERT_EMAIL_FROM: undefined, ALERT_EMAIL: undefined });
  assert.ok(noEmail.ok, noEmail.ok ? "" : noEmail.errors.join("\n"));
  assert.equal(noEmail.config.email, null, "no email contact: no sender needed");
  const logged = loadConfig({ ...validEnv(), DELIVERY_MODE: "log", ALERT_EMAIL_FROM: undefined });
  assert.ok(logged.ok && logged.config.email === null, "log mode sends nothing, so no sender is needed");
  assert.equal(alertEmailFrom({}), null);
  assert.equal(alertEmailFrom({ ALERT_EMAIL_FROM: " Alerts@Example.com " }), "alerts@example.com");
});

void test("standalone is the default: no PLATFORM_CONFIG_URL means the env alone, and setting one switches to platform mode", () => {
  assert.equal(monitorMode({}), "standalone");
  assert.equal(monitorMode({ PLATFORM_CONFIG_URL: " " }), "standalone");
  assert.equal(monitorMode({ PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config" }), "platform");
  assert.equal(monitorMode({ PLATFORM_CONFIG_URL: "not a url" }), "platform", "a bad URL is a platform-mode error, not silently standalone");
  const standalone = loadConfig({ ...validEnv(), MONITOR_CONFIG_KEY: undefined });
  assert.ok(standalone.ok && standalone.config.mode === "standalone", "standalone needs no config key");
  const platform = loadConfig({ ...validEnv(), PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config" });
  assert.ok(platform.ok && platform.config.mode === "platform");
  const noHosts = loadConfig({ ...validEnv(), DEEP_CHECK_HOSTS: undefined });
  assert.equal(noHosts.ok, false);
  assert.match(noHosts.errors.join("\n"), /a deep check needs DEEP_CHECK_HOSTS \(or a valid PLATFORM_CONFIG_URL\)/, "standalone, nothing names a deep host by default");
});

void test("an API key replaces the account SID for sending, but the auth token still validates webhooks", () => {
  const loaded = loadConfig({ ...validEnv(), TWILIO_API_KEY_SID: "SKkey", TWILIO_API_KEY_SECRET: "keysecret" });
  assert.ok(loaded.ok);
  assert.equal(loaded.config.twilio?.username, "SKkey");
  assert.equal(loaded.config.twilio.password, "keysecret");
  assert.equal(loaded.config.twilio.authToken, "token");
});

const failures: [string, Record<string, unknown>, RegExp][] = [
  ["missing policy", { ESCALATION_POLICY: undefined }, /policy: must be an object/],
  ["policy not JSON", { ESCALATION_POLICY: "{" }, /policy: is not valid JSON/],
  ["short ack key", { ACK_SIGNING_KEY: "short" }, /ACK_SIGNING_KEY: must be at least 32 bytes/],
  ["missing ack key", { ACK_SIGNING_KEY: undefined }, /ACK_SIGNING_KEY: is required/],
  ["deep check without the health key", { MONITOR_HEALTH_KEY: undefined }, /MONITOR_HEALTH_KEY: is required by the deep check/],
  ["short health key", { MONITOR_HEALTH_KEY: "y".repeat(31) }, /MONITOR_HEALTH_KEY: must be at least 32 bytes/],
  ["short config key", { MONITOR_CONFIG_KEY: "y".repeat(31) }, /MONITOR_CONFIG_KEY: must be at least 32 bytes/],
  ["padded config key", { MONITOR_CONFIG_KEY: ` ${"c".repeat(40)}` }, /MONITOR_CONFIG_KEY: has leading or trailing whitespace/],
  ["the same value for both keys", { MONITOR_CONFIG_KEY: "h".repeat(40) }, /MONITOR_CONFIG_KEY: must differ from MONITOR_HEALTH_KEY/],
  ["a deep check off the allowed hosts", { DEEP_CHECK_HOSTS: "other.example.com" }, /host must be one of DEEP_CHECK_HOSTS/],
  ["a non-https heartbeat failure URL", { HEARTBEAT_FAIL_URL: "http://hc.example.com/fail" }, /HEARTBEAT_FAIL_URL: must be an https URL/],
  ["a secondary resolver with a query", { DNS_SECONDARY_RESOLVER: "https://dns.google/resolve?x=1" }, /DNS_SECONDARY_RESOLVER: must have no query/],
  ["sms contacts without Twilio", { TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined }, /TWILIO_\*: required/],
  ["email contacts without the ALERT_EMAIL binding", { ALERT_EMAIL: undefined }, /ALERT_EMAIL: send_email binding required/],
  ["an ALERT_EMAIL that is not a binding", { ALERT_EMAIL: "alerts@example.com" }, /ALERT_EMAIL: send_email binding required/],
  ["email contacts without ALERT_EMAIL_FROM", { ALERT_EMAIL_FROM: undefined }, /ALERT_EMAIL_FROM: required/],
  ["an unusable BRAND_NAME", { BRAND_NAME: "x".repeat(25) }, /BRAND_NAME: must be 1 to 24 characters/],
  ["unknown delivery mode", { DELIVERY_MODE: "dry" }, /DELIVERY_MODE: must be live or log/],
  ["Twilio without auth token", { TWILIO_AUTH_TOKEN: undefined }, /TWILIO_AUTH_TOKEN: is required/],
  ["Twilio without sender", { TWILIO_FROM: undefined }, /TWILIO_FROM: or TWILIO_MESSAGING_SERVICE_SID is required/],
  ["insecure status page", { STATUS_PAGE_URL: "http://status.example.com" }, /STATUS_PAGE_URL: must be an https URL/],
];
for (const [name, change, pattern] of failures) {
  void test(`fails closed: ${name}`, () => {
    const loaded = loadConfig({ ...validEnv(), ...change });
    assert.equal(loaded.ok, false);
    assert.match(loaded.errors.join("\n"), pattern);
  });
}

void test("targets refuse a single-blip open threshold, unknown components, bad URLs and duplicate ids", () => {
  const base = record(JSON.parse(read("test/support/targets.fixture.json")));
  const checks = records(base["checks"]);
  const first = checks[0] ?? {};
  const check = (value: unknown, pattern: RegExp): void => {
    const problems = new Problems();
    assert.equal(parseTargets(value, problems), null);
    assert.match(problems.list.join("\n"), pattern);
  };
  check({ ...base, openAfterFailures: 1 }, /openAfterFailures: must be an integer from 2/);
  check({ ...base, checks: [...checks, { ...first, id: "x_http", component: "nope" }] }, /unknown component nope/);
  check({ ...base, checks: [{ ...first, url: "http://signup.example.test/" }] }, /must be an https URL/);
  check({ ...base, checks: [first, first] }, /duplicate id signup_http/);
  check({ ...base, checks: [{ id: "d", component: "signup", type: "deep", url: "https://platform.example.com/api/v2/health" }] },
    /path must be \/api\/v2\/monitor\/health/);
  check({ ...base, checks: [{ id: "q", component: "signup", type: "ping" }] }, /must be http, dns or deep/);
});

void test("component alert and public are optional (page, true); other values are refused with a clear message", () => {
  const parse = (component: Record<string, unknown>, problems = new Problems()): TargetsConfig | null => parseTargets({
    version: 1, components: [{ id: "web", name: "Web", ...component }],
    checks: [{ id: "web_http", component: "web", type: "http", url: "https://example.com/" }],
  }, problems);
  assert.deepEqual(parse({})?.components[0], { id: "web", name: "Web", pageOn: "down", alert: "page", public: true }, "an older document stays valid");
  for (const alert of ["page", "email", "none"]) assert.equal(parse({ alert })?.components[0]?.alert, alert);
  assert.deepEqual(parse({ alert: "email", public: false, pageOn: "degraded" })?.components[0],
    { id: "web", name: "Web", pageOn: "degraded", alert: "email", public: false });
  assert.equal(parse({ public: true })?.components[0]?.public, true);
  for (const alert of ["sms", "PAGE", "Email", "", 1, true, ["page"], {}]) {
    const problems = new Problems();
    assert.equal(parse({ alert }, problems), null, JSON.stringify(alert));
    assert.deepEqual(problems.list, ["targets.components[0].alert: must be page, email or none"], JSON.stringify(alert));
  }
  for (const shown of ["false", "true", 0, 1, "", [], {}]) {
    const problems = new Problems();
    assert.equal(parse({ public: shown }, problems), null, JSON.stringify(shown));
    assert.deepEqual(problems.list, ["targets.components[0].public: must be true or false"], JSON.stringify(shown));
  }
});

void test("the policy refuses contacts without channels, bad numbers and a contact in two tiers", () => {
  const base = record(JSON.parse(read("config/escalation.example.json")));
  const baseTiers = records(base["tiers"]);
  const problems = new Problems();
  const contact = { id: "dup", name: "Dup", sms: "555-0100" };
  const tiers = [{ ...baseTiers[0], contacts: [contact, { id: "none", name: "No channel" }] }, { ...baseTiers[1], contacts: [contact] }];
  assert.equal(parsePolicy({ ...base, tiers }, problems), null);
  const text = problems.list.join("\n");
  assert.match(text, /sms: must match/);
  assert.match(text, /needs at least one channel/);
  assert.match(text, /duplicate id dup/);
});

void test("DELIVERY_MODE=log needs no provider: nothing is sent, so Twilio and the email binding may be absent", () => {
  const loaded = loadConfig({ ...validEnv(), DELIVERY_MODE: "log", TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, ALERT_EMAIL: undefined });
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("\n"));
  assert.equal(loaded.config.deliveryMode, "log");
  assert.equal(loaded.config.twilio, null);
  assert.equal(loaded.config.email, null);
});

const platformSections = (overrides: Partial<PlatformSections> = {}): PlatformSections => ({
  revision: 7, policy: examplePolicy(), targets: null, senders: null, maintenance: [], ...overrides,
});

void test("a stored platform policy makes ESCALATION_POLICY optional and wins over it", () => {
  const solo = parsePolicy({ version: 1, tiers: [{ id: "solo", name: "Solo", contacts: [{ id: "me", name: "Me", email: "me@example.com" }] }] });
  assert.ok(solo !== null);
  const withoutSecret = loadConfig({ ...validEnv(), ESCALATION_POLICY: undefined }, platformSections({ policy: solo }));
  assert.ok(withoutSecret.ok, withoutSecret.ok ? "" : withoutSecret.errors.join("\n"));
  assert.deepEqual(withoutSecret.config.policy.tiers.map((tier) => tier.id), ["solo"]);
  assert.deepEqual(withoutSecret.config.source, { kind: "platform", revision: 7 });
  const overSecret = loadConfig(validEnv(), platformSections({ policy: solo }));
  assert.ok(overSecret.ok && overSecret.config.policy.tiers.length === 1, "the platform policy wins over the bootstrap secret");
  const brokenSecret = loadConfig({ ...validEnv(), ESCALATION_POLICY: "{" }, platformSections({ policy: solo }));
  assert.ok(brokenSecret.ok, "ESCALATION_POLICY is not read while a platform policy is stored");
});

void test("with neither a platform policy nor ESCALATION_POLICY the run still refuses", () => {
  const loaded = loadConfig({ ...validEnv(), ESCALATION_POLICY: undefined }, platformSections({ policy: null }));
  assert.equal(loaded.ok, false);
  assert.match(loaded.errors.join("\n"), /policy: must be an object/);
});

void test("platform targets replace MONITOR_TARGETS; null keeps the built-in targets", () => {
  const targets = parseTargets({ version: 1, components: [{ id: "web", name: "Web" }], checks: [{ id: "web_http", component: "web", type: "http",
    url: "https://example.com/" }] });
  assert.ok(targets !== null);
  const replaced = loadConfig(validEnv(), platformSections({ targets }));
  assert.ok(replaced.ok && replaced.config.targets.components.length === 1);
  const builtIn = loadConfig(validEnv(), platformSections());
  assert.ok(builtIn.ok && builtIn.config.targets.components.length === fixtureTargets().components.length);
});

void test("platform senders override the Twilio sender vars and set the email sender name; both SMS fields null keeps the env", () => {
  const service = `MG${"3".repeat(32)}`;
  const viaService = loadConfig(validEnv(), platformSections({
    senders: { smsFrom: null, smsMessagingServiceSid: service, emailFrom: "alerts@example.com", emailFromName: "Acme Alerts" },
  }));
  assert.ok(viaService.ok);
  assert.deepEqual([viaService.config.twilio?.from, viaService.config.twilio?.messagingServiceSid], [null, service], "TWILIO_FROM is ignored");
  assert.deepEqual(viaService.config.email, { from: "alerts@example.com", fromName: "Acme Alerts" });
  const viaNumber = loadConfig({ ...validEnv(), TWILIO_FROM: undefined }, platformSections({
    senders: { smsFrom: "+15555550198", smsMessagingServiceSid: null, emailFrom: "alerts@example.com", emailFromName: "Acme Status" },
  }));
  assert.ok(viaNumber.ok && viaNumber.config.twilio?.from === "+15555550198", "no env sender needed when the platform names one");
  const envSender = loadConfig(validEnv(), platformSections({
    senders: { smsFrom: null, smsMessagingServiceSid: null, emailFrom: "alerts@example.com", emailFromName: "Acme Status" },
  }));
  assert.ok(envSender.ok && envSender.config.twilio?.from === "+15555550123");
});

void test("senders: at most one SMS sender, emailFrom only as ALERT_EMAIL_FROM, a plain display name", () => {
  const FROM = "alerts@example.com";
  const check = (value: unknown, pattern: RegExp, from: string | null = FROM): void => {
    const problems = new Problems();
    assert.equal(parseSenders(value, problems, from), null);
    assert.match(problems.list.join("\n"), pattern);
  };
  check({ smsFrom: "+15555550123", smsMessagingServiceSid: `MG${"3".repeat(32)}` }, /at most one may be set/);
  check({ emailFrom: "someone@example.com" }, /senders\.emailFrom: must be the ALERT_EMAIL binding's allowed sender, ALERT_EMAIL_FROM \(alerts@example\.com\)/);
  check({ emailFrom: FROM }, /senders\.emailFrom: must be null: the Worker has no ALERT_EMAIL_FROM/, null);
  check({ emailFromName: "Evil\r\nBcc: x" }, /emailFromName/);
  check({ smsFrom: "555-0100" }, /smsFrom: must match/);
  assert.deepEqual(parseSenders({}, new Problems(), FROM), { smsFrom: null, smsMessagingServiceSid: null, emailFrom: null, emailFromName: null });
  assert.equal(parseSenders({ emailFrom: "Alerts@Example.com" }, new Problems(), FROM)?.emailFrom, FROM, "compared and kept lowercase");
  assert.equal(parseSenders({ emailFromName: " Acme Alerts " }, new Problems(), null)?.emailFromName, "Acme Alerts");
});

void test("senders: the platform's From name wins over ALERT_EMAIL_FROM_NAME, and a null emailFrom means ALERT_EMAIL_FROM", () => {
  const senders = { smsFrom: null, smsMessagingServiceSid: null, emailFrom: null, emailFromName: "Platform Name" };
  const loaded = loadConfig({ ...validEnv(), ALERT_EMAIL_FROM_NAME: "Env Name" }, platformSections({ senders }));
  assert.ok(loaded.ok && loaded.config.email !== null);
  assert.deepEqual(loaded.config.email, { from: "alerts@example.com", fromName: "Platform Name" });
  const unnamed = loadConfig({ ...validEnv(), ALERT_EMAIL_FROM_NAME: "Env Name" }, platformSections({ senders: { ...senders, emailFromName: null } }));
  assert.ok(unnamed.ok && unnamed.config.email?.fromName === "Env Name");
});

void test("targets allow at most one deep check", () => {
  const base = record(JSON.parse(read("test/support/targets.fixture.json")));
  const checks = records(base["checks"]);
  const deep = checks.find((check) => check["type"] === "deep") ?? {};
  const problems = new Problems();
  assert.equal(parseTargets({ ...base, checks: [...checks, { ...deep, id: "second_deep" }] }, problems), null);
  assert.match(problems.list.join("\n"), /at most one deep check/);
});

void test("the private view key must be at least 32 bytes or the view is disabled", () => {
  assert.equal(statusViewKey({ STATUS_VIEW_KEY: "short" }), null);
  assert.equal(statusViewKey({}), null);
  assert.equal(statusViewKey({ STATUS_VIEW_KEY: KEY }), KEY);
});

/**
 * The Worker wrangler config's invariants, independent of the example values an adopter replaces (README "Quick start"
 * steps 2 and 3): the sender, hostnames and brand are theirs; the shape and the safety properties are not.
 */
function assertMonitorWrangler(source: string): void {
  const config = jsonc(source);
  assert.ok(typeof config === "object" && config !== null);
  const get = (key: string): unknown => Reflect.get(config, key);
  assert.equal(get("name"), "status-monitor");
  assert.equal(get("workers_dev"), false);
  assert.equal(get("preview_urls"), false);
  assert.deepEqual(get("routes"), []);
  assert.equal(get("route"), undefined);
  assert.deepEqual(get("triggers"), { crons: ["* * * * *"] });
  assert.deepEqual(get("migrations"), [{ tag: "v1", new_sqlite_classes: ["MonitorObject"] }]);
  const vars = get("vars");
  assert.deepEqual(Reflect.get(vars ?? {}, "MONITOR_TARGETS"), JSON.parse(read("config/targets.example.json")), "inline targets match the example");
  assert.equal(Reflect.get(vars ?? {}, "PLATFORM_CONFIG_URL"), undefined, "the example runs standalone");
  assert.equal(Reflect.get(vars ?? {}, "DELIVERY_MODE"), "live", "the deployed Worker sends; only local development logs");
  const from: unknown = Reflect.get(vars ?? {}, "ALERT_EMAIL_FROM");
  assert.ok(typeof from === "string" && /^[^@\s]+@[^@\s]+$/.test(from), "ALERT_EMAIL_FROM is an address");
  assert.deepEqual(get("send_email"), [{ name: "ALERT_EMAIL", allowed_sender_addresses: [from] }],
    "email goes through the ALERT_EMAIL binding, restricted to ALERT_EMAIL_FROM");
  const statusPageUrl: unknown = Reflect.get(vars ?? {}, "STATUS_PAGE_URL");
  assert.ok(typeof statusPageUrl === "string" && new URL(statusPageUrl).protocol === "https:", "STATUS_PAGE_URL is https");
  assert.equal(Reflect.get(vars ?? {}, "TWILIO_WEBHOOK_URL"), `${statusPageUrl.replace(/\/$/, "")}/hooks/twilio`,
    "Twilio signs the webhook URL on the status page host");
  for (const secret of [
    "ESCALATION_POLICY", "MONITOR_HEALTH_KEY", "MONITOR_CONFIG_KEY", "STATUS_VIEW_KEY", "ACK_SIGNING_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
    "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_FROM", "TWILIO_MESSAGING_SERVICE_SID", "HEARTBEAT_URL", "HEARTBEAT_FAIL_URL",
    "TWILIO_AUTH_TOKEN_SECONDARY"]) {
    assert.match(source, new RegExp(`^//\\s+${secret}\\b`, "m"), `${secret} listed in a comment`);
    assert.equal(Reflect.get(vars ?? {}, secret), undefined, `${secret} is not a plain var`);
  }
  assert.doesNotMatch(source, /gmail/i, "no Gmail configuration is left");
}

void test("the Worker wrangler config has no public surface and runs every minute on a SQLite Durable Object", () => {
  assertMonitorWrangler(read("wrangler.jsonc"));
});

void test("the Worker wrangler config check holds after an adopter sets their own status host and sender", () => {
  const adopted = adoptedMonitorWrangler(read("wrangler.jsonc"));
  assert.match(adopted, new RegExp(`"ALERT_EMAIL_FROM": "${ADOPTED_EMAIL_FROM}"`), "the sender was replaced");
  assert.match(adopted, new RegExp(`"STATUS_PAGE_URL": "https://${ADOPTED_STATUS_HOST}"`), "the status host was replaced");
  assertMonitorWrangler(adopted);
  // A mismatch an adopter can make is still caught: the sender must equal the binding's allowed address, and the
  // Twilio webhook must be on the status page host.
  const otherSender = adopted.replace(`"ALERT_EMAIL_FROM": "${ADOPTED_EMAIL_FROM}"`, '"ALERT_EMAIL_FROM": "pager@adopter.test"');
  assert.notEqual(otherSender, adopted);
  assert.throws(() => {
    assertMonitorWrangler(otherSender);
  }, { message: /restricted to ALERT_EMAIL_FROM/ });
  const otherHook = adopted.replace(`https://${ADOPTED_STATUS_HOST}/hooks/twilio`, "https://other.adopter.test/hooks/twilio");
  assert.notEqual(otherHook, adopted);
  assert.throws(() => {
    assertMonitorWrangler(otherHook);
  }, { message: /Twilio signs the webhook URL/ });
});

