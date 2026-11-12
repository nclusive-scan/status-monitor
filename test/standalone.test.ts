// Standalone mode end to end: the shipped example configuration (wrangler.jsonc vars, config/escalation.example.json)
// with no PLATFORM_CONFIG_URL. The Worker's scheduled handler runs against the real MonitorObject on the SQLite fake,
// with the global fetch replaced, so every request it makes is recorded: in standalone mode those are the checks and
// nothing else (no config pull, no report); with PLATFORM_CONFIG_URL set the pull and the report go out as before.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { brandOf } from "../worker/brand.ts";
import { applyPlatformDocument, resolveConfig } from "../worker/platform-config.ts";
import { MonitorStore } from "../worker/store.ts";
import { isRecord } from "../worker/types.ts";
import { adoptedMonitorWrangler } from "./support/adopted.ts";
import { countingRandom, sqliteStorage, T0 } from "./support/fakes.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "cloudflare:workers") return next(specifier, context);
    const base = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
    return { url: `data:text/javascript,${encodeURIComponent(base)}`, shortCircuit: true };
  },
});

interface ObjectUnderTest {
  privateStatus(now: number): string;
}
type ObjectClass = new (ctx: unknown, env: Record<string, unknown>) => ObjectUnderTest;
interface Handler {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
  scheduled(controller: { scheduledTime: number; cron: string }, env: Record<string, unknown>, ctx: { waitUntil(promise: Promise<unknown>): void }): void;
}

const objectModule: unknown = await import(new URL("../worker/monitor-object.ts", import.meta.url).href);
const entryModule: unknown = await import(new URL("../worker/index.ts", import.meta.url).href);
const MonitorObject = isRecord(objectModule) ? objectModule["MonitorObject"] : null;
const handler = isRecord(entryModule) ? entryModule["default"] : null;
const isObjectClass = (value: unknown): value is ObjectClass => typeof value === "function";
const isHandler = (value: unknown): value is Handler =>
  isRecord(value) && typeof value["fetch"] === "function" && typeof value["scheduled"] === "function";
if (!isObjectClass(MonitorObject) || !isHandler(handler)) throw new Error("worker modules not loadable");

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
};

/** The vars of the shipped wrangler.jsonc (comments stripped), the example policy, and the keys a deploy sets. */
function exampleEnv(overrides: Record<string, unknown> = {}, wrangler = read("wrangler.jsonc")): Record<string, unknown> {
  const config = record(JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, "")));
  return {
    ...record(config["vars"]),
    ESCALATION_POLICY: read("config/escalation.example.json"),
    ACK_SIGNING_KEY: "a".repeat(40),
    STATUS_VIEW_KEY: "v".repeat(40),
    BRAND_NAME: "Acme",
    // No real provider is ever called from a test.
    DELIVERY_MODE: "log",
    ...overrides,
  };
}

interface World {
  readonly env: Record<string, unknown>;
  readonly object: ObjectUnderTest;
}

function world(vars: Record<string, unknown>): World {
  if (!isObjectClass(MonitorObject)) throw new Error("unreachable");
  const storage = sqliteStorage();
  const ctx = { storage: { ...storage, setAlarm: () => Promise.resolve(), deleteAlarm: () => Promise.resolve() } };
  const object = new MonitorObject(ctx, vars);
  const namespace = { jurisdiction: () => ({ idFromName: () => "id" }), get: () => object };
  return { env: { ...vars, MONITOR_STATE: namespace }, object };
}

interface Recorded {
  readonly url: string;
  readonly method: string;
}

/** Runs one cron tick with the global fetch answering `answer`; returns every request the Worker made. */
async function tick(w: World, answer: (url: string) => Response, t: { mock: { method(object: object, name: string, fn: unknown): unknown } }): Promise<Recorded[]> {
  if (!isHandler(handler)) throw new Error("unreachable");
  const calls: Recorded[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    return Promise.resolve(answer(url));
  });
  const pending: Promise<unknown>[] = [];
  handler.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, w.env, { waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
  return calls;
}

const healthy = (url: string): Response => new Response(url.endsWith("/health") ? "{\"ok\":true}" : "<html>ok</html>", { status: 200 });

const quiet = (t: { mock: { method(object: object, name: string, fn: () => void): unknown } }): void => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "error", () => undefined);
};

void test("standalone: the shipped example config runs with no PLATFORM_CONFIG_URL; only the checks are fetched, never a pull or a report", async (t) => {
  quiet(t);
  const w = world(exampleEnv());
  const calls = await tick(w, healthy, t);
  assert.deepEqual(calls.map((call) => call.url).sort(), ["https://api.example.com/health", "https://example.com/"]);
  assert.ok(calls.every((call) => !call.url.includes("/api/v2/monitor/")), "no config pull, no report");
  const view = record(JSON.parse(w.object.privateStatus(Date.now())));
  const monitor = record(view["monitor"]);
  assert.equal(monitor["configError"], null, "the example configuration is valid as shipped");
  assert.equal(monitor["stale"], false, "the run completed");
  const config = record(monitor["config"]);
  assert.equal(config["mode"], "standalone");
  assert.equal(config["source"], "bootstrap");
  assert.equal(config["lastErrorCode"], null, "standalone records no config_url or config_key error");
  const report = record(monitor["report"]);
  assert.deepEqual([report["lastOkAt"], report["lastErrorCode"]], [null, null], "no report was attempted");
});

void test("platform mode: with PLATFORM_CONFIG_URL and MONITOR_CONFIG_KEY the signed pull and the report go to that origin", async (t) => {
  quiet(t);
  const w = world(exampleEnv({ PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config", MONITOR_CONFIG_KEY: "c".repeat(40) }));
  const calls = await tick(w, (url) => {
    if (url.endsWith("/api/v2/monitor/config")) return new Response(null, { status: 404 });
    if (url.endsWith("/api/v2/monitor/report")) return new Response("{\"archived\":[]}", { status: 200, headers: { "content-type": "application/json" } });
    return healthy(url);
  }, t);
  assert.deepEqual(calls.filter((call) => call.url.includes("/api/v2/monitor/")).map((call) => [call.method, call.url]), [
    ["GET", "https://platform.example.com/api/v2/monitor/config"],
    ["POST", "https://platform.example.com/api/v2/monitor/report"],
  ]);
  const config = record(record(record(JSON.parse(w.object.privateStatus(Date.now())))["monitor"])["config"]);
  assert.deepEqual([config["mode"], config["lastErrorCode"]], ["platform", "config_rejected_or_missing"]);
});

void test("standalone: a platform revision stored by an earlier deployment is ignored; the env alone is the configuration", () => {
  // As shipped, and as an adopter edits wrangler.jsonc in the quick start (their own sender and status host).
  for (const wrangler of [read("wrangler.jsonc"), adoptedMonitorWrangler(read("wrangler.jsonc"))]) {
    const store = new MonitorStore(sqliteStorage(), countingRandom());
    const platformEnv = exampleEnv({ PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config", MONITOR_CONFIG_KEY: "c".repeat(40) }, wrangler);
    // A platform's senders override is accepted only when it names this deployment's ALERT_EMAIL_FROM.
    const example = record(JSON.parse(read("config/platform-config.example.json")));
    const document = { ...example, senders: { ...record(example["senders"]), emailFrom: platformEnv["ALERT_EMAIL_FROM"] } };
    const applied = applyPlatformDocument(store, platformEnv, JSON.stringify(document), T0);
    assert.equal(applied.outcome, "accepted", applied.code ?? "");
    const stored = store.platformConfig();
    const platform = resolveConfig(platformEnv, stored);
    assert.ok(platform.ok && platform.config.source.kind === "platform", "platform mode runs the stored revision");
    const standalone = resolveConfig(exampleEnv({}, wrangler), stored);
    assert.ok(standalone.ok, standalone.ok ? "" : standalone.errors.join("\n"));
    assert.deepEqual([standalone.config.source, standalone.config.mode], [{ kind: "bootstrap" }, "standalone"]);
  }
});

void test("brand: /api/status names the brand for the page; an unusable BRAND_NAME reads as the default there", async (t) => {
  quiet(t);
  if (!isHandler(handler)) throw new Error("unreachable");
  const branded = world(exampleEnv());
  await tick(branded, healthy, t);
  const status = record(await (await handler.fetch(new Request("https://monitor.internal/api/status"), branded.env)).json());
  assert.equal(status["brand"], "Acme");
  const plain = world(exampleEnv({ BRAND_NAME: undefined }));
  const plainStatus = record(await (await handler.fetch(new Request("https://monitor.internal/api/status"), plain.env)).json());
  assert.equal(plainStatus["brand"], "Status", "default");
  const broken = world(exampleEnv({ BRAND_NAME: "<script>" }));
  const brokenStatus = record(await (await handler.fetch(new Request("https://monitor.internal/api/status"), broken.env)).json());
  assert.equal(brokenStatus["brand"], "Status", "the configuration is refused, and the page still gets a safe name");
  assert.equal(brandOf({ BRAND_NAME: "<script>" }), "Status");
  const ack = await handler.fetch(new Request("https://monitor.internal/ack/not-a-token"), branded.env);
  assert.equal(ack.status, 404);
  const page = await ack.text();
  assert.match(page, /<title>Link not valid · Acme status<\/title>/);
});
