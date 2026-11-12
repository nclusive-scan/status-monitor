// What /api/status says about each public component's checks: which operations are checked, their status and response
// time, and when each last ran, plus the rules that open and resolve an incident. URLs, hostnames, detail codes, deep
// values and release data stay private.
import assert from "node:assert/strict";
import test from "node:test";
import type { ConfigResult, EscalationPolicy, MonitorConfig, TargetsConfig } from "../worker/config.ts";
import { parsePolicy, parseTargets } from "../worker/config.ts";
import { publicProjection } from "../worker/redact.ts";
import { publicSnapshot } from "../worker/status-view.ts";
import { MonitorStore } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { countingRandom, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

const DEEP_URL = "https://platform.example.test/api/v2/monitor/health";

const parsed = parseTargets({
  version: 1, openAfterFailures: 3, resolveAfterPasses: 2,
  components: [
    { id: "api", name: "API", public: true },
    { id: "jobs", name: "Background jobs", public: true },
    { id: "internal", name: "Internal", public: false },
  ],
  checks: [
    { id: "api_http", component: "api", type: "http", url: "https://api.example.test/healthz" },
    { id: "platform", component: "api", type: "deep", url: DEEP_URL, componentMap: { notification_backlog: "jobs" } },
    { id: "internal_http", component: "internal", type: "http", url: "https://internal.example.test/" },
  ],
});
if (parsed === null) throw new Error("targets invalid");
const targets: TargetsConfig = parsed;
const policy: EscalationPolicy | null = parsePolicy({
  version: 1, maxCycles: 1, reminderMinutes: 15, tiers: [{ id: "primary", name: "Primary", ackTimeoutMinutes: 5, contacts: [{ id: "a", name: "A", email: "a@example.test" }] }],
});
if (policy === null) throw new Error("policy invalid");

const config: MonitorConfig = {
  brandName: "Acme", mode: "standalone", targets, policy, statusPageUrl: "https://status.example.test", twilioWebhookUrl: "https://status.example.test/hooks/twilio",
  healthKey: null, configKey: null, ackSigningKey: "a".repeat(40), twilio: null, email: null, heartbeatUrl: null, heartbeatFailUrl: null,
  dnsSecondaryResolver: null, maintenance: [], deliveryMode: "log", source: { kind: "bootstrap" },
};
const loaded: ConfigResult = { ok: true, config };

/** One run: the API's HTTP check, the deep check with its unmapped and mapped sub-checks, and the private component. */
function results(at: number): CheckResult[] {
  const row = (checkId: string, componentId: string, type: CheckResult["type"], status: CheckResult["status"], latencyMs: number, detail: string,
    data: Record<string, unknown> | null): CheckResult => ({ checkId, componentId, type, status, inconclusive: false, latencyMs, detail, observedAt: at, data });
  return [
    row("api_http", "api", "http", "ok", 120, "ok", { url: "https://api.example.test/healthz" }),
    row("platform", "api", "deep", "degraded", 340, "migrations_behind", {
      url: DEEP_URL, release: { version: "1.4.0", commit: "abc123" }, overall: "degraded", generatedAt: new Date(at).toISOString(),
      checks: [
        { id: "database", status: "ok", latencyMs: 3, detail: "ok", value: null },
        { id: "migrations", status: "degraded", latencyMs: 0, detail: "migrations_behind", value: 404 },
        { id: "notification_backlog", status: "ok", latencyMs: 1, detail: "ok", value: 12 },
      ],
    }),
    row("platform.notification_backlog", "jobs", "deep", "ok", 1, "ok", { value: 12 }),
    row("internal_http", "internal", "http", "down", 900, "status_503", null),
  ];
}

void test("each public component lists its checks with status, response time and last run; a deep check lists its unclaimed sub-checks", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun(results(T0), targets, policy, T0);
  const view = publicProjection(publicSnapshot(store, loaded, T0 + 20_000));
  const at = new Date(T0).toISOString();

  assert.deepEqual(view.monitor.rules, { openAfterFailures: 3, resolveAfterPasses: 2 });
  assert.equal(view.monitor.staleAfterSeconds, 300);
  assert.deepEqual(view.components.map((component) => [component.id, component.lastCheckedAt]), [["api", at], ["jobs", at]]);

  const api = view.components.find((component) => component.id === "api");
  assert.deepEqual(api?.checks, [
    { id: "api_http", kind: "http", status: "ok", latencyMs: 120, checkedAt: at },
    { id: "platform", kind: "deep", status: "degraded", latencyMs: 340, checkedAt: at },
    { id: "platform.database", kind: "part", status: "ok", latencyMs: 3, checkedAt: at },
    { id: "platform.migrations", kind: "part", status: "degraded", latencyMs: 0, checkedAt: at },
  ], "the mapped sub-check is listed under its own component, not twice");
  const jobs = view.components.find((component) => component.id === "jobs");
  assert.deepEqual(jobs?.checks, [{ id: "platform.notification_backlog", kind: "part", status: "ok", latencyMs: 1, checkedAt: at }]);

  const text = JSON.stringify(view);
  for (const secret of ["example.test", "healthz", "migrations_behind", "status_503", "abc123", "1.4.0", "404", "internal"]) {
    assert.ok(!text.includes(secret), `public view leaks ${secret}`);
  }
});

void test("a stale monitor shows every check as unknown, keeping when it last ran", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun(results(T0), targets, policy, T0);
  const view = publicProjection(publicSnapshot(store, loaded, T0 + 30 * MINUTE));
  assert.equal(view.monitor.stale, true);
  const checks = view.components.flatMap((component) => component.checks);
  assert.ok(checks.length > 0);
  assert.ok(checks.every((check) => check.status === "unknown" && check.checkedAt === new Date(T0).toISOString()));
});

void test("before the first run a component has no checks and no last-checked time; a refused configuration has no rules", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  const view = publicProjection(publicSnapshot(store, loaded, T0));
  assert.deepEqual(view.components.map((component) => [component.lastCheckedAt, component.checks]), [[null, []], [null, []]]);
  const refused = publicProjection(publicSnapshot(store, { ok: false, errors: ["targets: invalid"] }, T0));
  assert.equal(refused.monitor.rules, null);
});
