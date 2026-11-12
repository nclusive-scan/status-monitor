// The Worker against an example server report shaped per spec/PROTOCOL.md, "Deep health": UPPERCASE detail codes, six
// checks including notification_backlog_age, key bytes used exactly as stored, rejections answered like an unknown path
// (401 for an anonymous caller), and how the Workers runtime reports a TLS failure.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { runDeepCheck } from "../worker/checks/deep.ts";
import { classifyFetchError, runHttpCheck } from "../worker/checks/http.ts";
import type { DeepCheckConfig, HttpCheckConfig } from "../worker/config.ts";
import { loadConfig } from "../worker/config.ts";
import { isRecord } from "../worker/types.ts";
import { fixtureTargets, FakeClock, header, jsonResponse, scriptedFetch } from "./support/fakes.ts";
import { readFileSync } from "node:fs";

/** The example server's check ids, in its report order. */
const ENDPOINT_CHECK_IDS = ["database", "migrations", "notification_backlog", "notification_backlog_age", "notification_failures_1h", "queue_depth"];

/** An example server report (spec/PROTOCOL.md, "Deep health"), with a two-hour-old notification backlog. */
const endpointReport = {
  version: 1,
  generatedAt: "2026-11-11T14:00:00.000Z",
  release: { version: "1.4.2", commit: "0123456789abcdef0123456789abcdef01234567" },
  overall: "down",
  checks: [
    { id: "database", status: "ok", latencyMs: 3, detail: "OK", value: null },
    { id: "migrations", status: "ok", latencyMs: 2, detail: "CURRENT", value: 42 },
    { id: "notification_backlog", status: "ok", latencyMs: 2, detail: "OK", value: 12 },
    { id: "notification_backlog_age", status: "down", latencyMs: 2, detail: "BACKLOG_STALE", value: 7200 },
    { id: "notification_failures_1h", status: "ok", latencyMs: 2, detail: "OK", value: 0 },
    { id: "queue_depth", status: "ok", latencyMs: 2, detail: "OK", value: 31 },
  ],
};

const deepConfig = (): DeepCheckConfig => {
  const check = fixtureTargets().checks.find((item) => item.type === "deep");
  if (check?.type !== "deep") throw new Error("example deep check missing");
  return check;
};

void test("contract: every endpoint check id is either the platform's or mapped, and the notification ones go to notifications", () => {
  const check = deepConfig();
  for (const id of ENDPOINT_CHECK_IDS.filter((item) => item.startsWith("notification_"))) {
    assert.equal(check.componentMap[id], "notifications", `${id} must be mapped to notifications`);
  }
  assert.deepEqual(ENDPOINT_CHECK_IDS.map((id) => endpointReport.checks.find((item) => item.id === id)?.id), ENDPOINT_CHECK_IDS);
});

void test("contract: a stale backlog fails Notifications, not Platform API, and keeps its detail code (lowercased)", async () => {
  const results = await runDeepCheck(deepConfig(), {
    fetch: scriptedFetch(() => jsonResponse(endpointReport)).fetch, clock: new FakeClock(), key: "k".repeat(40),
  });
  assert.deepEqual(results.map((result) => [result.checkId, result.componentId, result.status, result.detail]), [
    ["platform_deep", "platform_api", "ok", "ok"],
    ["platform_deep.notification_backlog", "notifications", "ok", "ok"],
    ["platform_deep.notification_backlog_age", "notifications", "down", "backlog_stale"],
    ["platform_deep.notification_failures_1h", "notifications", "ok", "ok"],
  ]);
  const own = results[0]?.data;
  const raw = own?.["checks"];
  const checks: readonly unknown[] = Array.isArray(raw) ? raw : [];
  assert.deepEqual(checks.map((item) => (isRecord(item) ? item["detail"] : null)),
    ["ok", "current", "ok", "backlog_stale", "ok", "ok"], "no sub-check detail is lost as invalid_detail");
});

void test("contract: an unmapped failing check (e.g. STATEMENT_TIMEOUT on the database) fails Platform API with its code", async () => {
  const report = { ...endpointReport, checks: endpointReport.checks.map((item) =>
    item.id === "database" ? { ...item, status: "down", detail: "STATEMENT_TIMEOUT" } : { ...item, status: "ok", detail: "OK" }) };
  const results = await runDeepCheck(deepConfig(), { fetch: scriptedFetch(() => jsonResponse(report)).fetch, clock: new FakeClock(), key: "k".repeat(40) });
  assert.deepEqual([results[0]?.status, results[0]?.detail], ["down", "statement_timeout"]);
});

void test("contract: the health key is signed byte for byte as stored, like a server's Buffer.from(key) of the same secret", async () => {
  const key = "0123456789".repeat(4);
  const fetch = scriptedFetch(() => jsonResponse(endpointReport));
  await runDeepCheck(deepConfig(), { fetch: fetch.fetch, clock: new FakeClock(), key });
  const init = fetch.calls[0]?.init;
  const timestamp = header(init, "x-status-monitor-timestamp") ?? "", nonce = header(init, "x-status-monitor-nonce") ?? "";
  const canonical = ["v2", "GET", "platform.example.com", "/api/v2/monitor/health", timestamp, nonce,
    createHash("sha256").update("").digest("hex")].join("\n");
  const serverSide = createHmac("sha256", Buffer.from(key, "utf8")).update(canonical).digest("hex");
  assert.equal(header(init, "x-status-monitor-signature"), `v2=${serverSide}`);
});

void test("contract: a shared key stored with a trailing newline is a config error, never a silently trimmed key", () => {
  const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const key = "a".repeat(40);
  const env = {
    MONITOR_TARGETS: read("test/support/targets.fixture.json"), ESCALATION_POLICY: read("config/escalation.example.json"),
    STATUS_PAGE_URL: "https://status.example.com", TWILIO_WEBHOOK_URL: "https://status.example.com/hooks/twilio",
    MONITOR_HEALTH_KEY: key, MONITOR_CONFIG_KEY: "b".repeat(40), ACK_SIGNING_KEY: key, TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`, TWILIO_AUTH_TOKEN: "token",
    TWILIO_FROM: "+15555550123", ALERT_EMAIL: { send: () => Promise.resolve({ messageId: "m" }) }, ALERT_EMAIL_FROM: "alerts@example.com",
    PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config",
  };
  const loaded = loadConfig(env);
  assert.equal(loaded.ok && loaded.config.healthKey, key);
  const padded = loadConfig({ ...env, MONITOR_HEALTH_KEY: `${key}\n` });
  assert.equal(padded.ok, false);
  assert.match(padded.errors.join("; "), /MONITOR_HEALTH_KEY: has leading or trailing whitespace/);
});

void test("contract: the Workers runtime's opaque TLS failure is tls_or_network, never claimed as tls or connect_error", async () => {
  // The exact shape workerd throws for an expired, wrong-host, self-signed or untrusted certificate.
  const workerd = new Error("internal error; reference = 5d1lhb3v9kq0m7rfq0o8gq4b");
  assert.equal(classifyFetchError(workerd), "tls_or_network");
  assert.equal(classifyFetchError(new Error("Network connection lost.")), "connect_error");
  const check: HttpCheckConfig = {
    id: "forums_http", component: "forums", type: "http", url: "https://forums.example.test/", method: "GET", expectStatus: { min: 200, max: 299 },
    maxRedirects: 5, bodyIncludes: null, latencyDegradedMs: 3000, timeoutMs: 10000,
  };
  const result = await runHttpCheck(check, { fetch: scriptedFetch(() => {
    throw workerd;
  }).fetch, clock: new FakeClock() });
  assert.deepEqual([result.status, result.detail], ["down", "tls_or_network"]);
});
