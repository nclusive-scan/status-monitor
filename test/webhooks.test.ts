// The monitor Worker's webhook routes end to end under Node: the router in worker/index.ts, the real MonitorObject on
// the SQLite fake (DELIVERY_MODE "log", so nothing is sent anywhere). Covers the Twilio status callback (signature
// against STATUS_PAGE_URL/hooks/twilio-status, the secondary token during a rotation, rejected signatures counted), the
// inbound SMS answering before any delivery, and the escalate button on the acknowledgement page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { createAckToken } from "../worker/ack.ts";
import type { TargetsConfig } from "../worker/config.ts";
import { computeTwilioSignature } from "../worker/twilio-signature.ts";
import type { CheckResult } from "../worker/types.ts";
import { isRecord } from "../worker/types.ts";
import { fixtureTargets, MINUTE, sqliteStorage } from "./support/fakes.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== "cloudflare:workers") return next(specifier, context);
    const base = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
    return { url: `data:text/javascript,${encodeURIComponent(base)}`, shortCircuit: true };
  },
});

interface ObjectUnderTest {
  ingest(results: CheckResult[], now: number, checked: TargetsConfig): Promise<unknown>;
  privateStatus(now: number): string;
}
type ObjectClass = new (ctx: unknown, env: Record<string, unknown>) => ObjectUnderTest;
interface Handler {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

const objectModule: unknown = await import(new URL("../worker/monitor-object.ts", import.meta.url).href);
const entryModule: unknown = await import(new URL("../worker/index.ts", import.meta.url).href);
const MonitorObject = isRecord(objectModule) ? objectModule["MonitorObject"] : null;
const handler = isRecord(entryModule) ? entryModule["default"] : null;
const isObjectClass = (value: unknown): value is ObjectClass => typeof value === "function";
const isHandler = (value: unknown): value is Handler => isRecord(value) && typeof value["fetch"] === "function";
if (!isObjectClass(MonitorObject) || !isHandler(handler)) throw new Error("worker modules not loadable");

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const STATUS_PAGE = "https://status.example.com";
const STATUS_HOOK = `${STATUS_PAGE}/hooks/twilio-status`;
const INBOUND_HOOK = `${STATUS_PAGE}/hooks/twilio`;
const ACCOUNT = `AC${"0".repeat(32)}`;
const TOKEN = "primary-auth-token";
const ACK_KEY = "a".repeat(40);
const SID = `SM${"d".repeat(32)}`;

interface World {
  readonly env: Record<string, unknown>;
  readonly object: ObjectUnderTest;
  readonly db: ReturnType<typeof sqliteStorage>["db"];
  readonly alarms: number[];
}

function world(overrides: Record<string, unknown> = {}): World {
  if (!isObjectClass(MonitorObject)) throw new Error("unreachable");
  const vars: Record<string, unknown> = {
    MONITOR_TARGETS: read("test/support/targets.fixture.json"), ESCALATION_POLICY: read("config/escalation.example.json"), STATUS_PAGE_URL: STATUS_PAGE,
    TWILIO_WEBHOOK_URL: INBOUND_HOOK, MONITOR_HEALTH_KEY: "h".repeat(40), MONITOR_CONFIG_KEY: "c".repeat(40), ACK_SIGNING_KEY: ACK_KEY,
    TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM: "+15555550123", DELIVERY_MODE: "log",
    PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config", ...overrides,
  };
  const storage = sqliteStorage();
  const alarms: number[] = [];
  const ctx = {
    storage: {
      ...storage,
      setAlarm: (at: number) => {
        alarms.push(at);
        return Promise.resolve();
      },
      deleteAlarm: () => Promise.resolve(),
    },
  };
  const object = new MonitorObject(ctx, vars);
  const namespace = { jurisdiction: () => ({ idFromName: () => "id" }), get: () => object };
  return { env: { ...vars, MONITOR_STATE: namespace }, object, db: storage.db, alarms };
}

const runOf = (targets: TargetsConfig, at: number, down: readonly string[]): CheckResult[] =>
  targets.checks.map((check) => ({
    checkId: check.id, componentId: check.component, type: check.type, status: down.includes(check.component) ? "down" : "ok", inconclusive: false,
    latencyMs: 10, detail: "x", observedAt: at, data: null,
  }));

/** Opens a signup incident now (log mode sends its pages at once) and gives the primary SMS page a Twilio SID. */
async function openIncident(w: World): Promise<{ readonly id: string; readonly code: string }> {
  const targets = fixtureTargets();
  const now = Date.now();
  await w.object.ingest(runOf(targets, now - 2 * MINUTE, ["signup"]), now - 2 * MINUTE, targets);
  await w.object.ingest(runOf(targets, now - MINUTE, ["signup"]), now - MINUTE, targets);
  const row = w.db.prepare("SELECT id, ack_code FROM incidents WHERE resolved_at IS NULL").get();
  if (row === undefined || typeof row["id"] !== "string" || typeof row["ack_code"] !== "string") throw new Error("no incident");
  w.db.prepare("UPDATE outbox SET provider_id = ? WHERE kind = 'page' AND channel = 'sms'").run(SID);
  return { id: row["id"], code: row["ack_code"] };
}

async function twilioPost(w: World, path: string, signedUrl: string, params: Record<string, string>, token = TOKEN): Promise<Response> {
  const entries = Object.entries(params);
  const signature = await computeTwilioSignature(token, signedUrl, entries);
  if (!isHandler(handler)) throw new Error("unreachable");
  return handler.fetch(new Request(`https://monitor.internal${path}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(entries).toString(),
  }), w.env);
}

const privateView = (w: World): Readonly<Record<string, unknown>> => {
  const view: unknown = JSON.parse(w.object.privateStatus(Date.now()));
  if (!isRecord(view)) throw new Error("private view unreadable");
  return view;
};

const quiet = (t: { mock: { method(object: object, name: string, fn: () => void): unknown } }): void => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "error", () => undefined);
};

void test("twilio-status: a callback signed for STATUS_PAGE_URL/hooks/twilio-status records the status; 21610 marks the contact opted out", async (t) => {
  quiet(t);
  const w = world();
  await openIncident(w);
  const response = await twilioPost(w, "/hooks/twilio-status", STATUS_HOOK, {
    AccountSid: ACCOUNT, MessageSid: SID, SmsSid: SID, MessageStatus: "undelivered", SmsStatus: "undelivered", ErrorCode: "21610", From: "+15555550123",
  });
  assert.equal(response.status, 204);
  const view = privateView(w);
  const notifications = Array.isArray(view["notifications"]) ? view["notifications"].filter(isRecord) : [];
  const page = notifications.find((row) => row["provider"] === SID);
  assert.deepEqual([page?.["status"], page?.["deliveryStatus"], page?.["deliveryCode"]], ["failed", "undelivered", "twilio_21610"]);
  const health = Array.isArray(view["contactHealth"]) ? view["contactHealth"].filter(isRecord) : [];
  assert.deepEqual(health.map((row) => [row["contactId"], row["channel"], row["state"]]), [["primary_oncall", "sms", "opted_out"]]);
  assert.ok(w.alarms.length > 0, "the alarm is woken to send the notice and any failover");

  const unknown = await twilioPost(w, "/hooks/twilio-status", STATUS_HOOK, {
    AccountSid: ACCOUNT, MessageSid: `SM${"e".repeat(32)}`, MessageStatus: "delivered",
  });
  assert.equal(unknown.status, 204, "an unknown SID is answered too: nothing for Twilio to retry");
  const otherAccount = await twilioPost(w, "/hooks/twilio-status", STATUS_HOOK, {
    AccountSid: `AC${"9".repeat(32)}`, MessageSid: SID, MessageStatus: "delivered",
  });
  assert.equal(otherAccount.status, 204);
});

void test("twilio-status: a signature for any other URL, or under an unknown token, is refused, logged without details and counted", async (t) => {
  quiet(t);
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => {
    warnings.push(String(line));
  });
  const w = world();
  await openIncident(w);
  const params = { AccountSid: ACCOUNT, MessageSid: SID, MessageStatus: "delivered", To: "+15555550100" };
  assert.equal((await twilioPost(w, "/hooks/twilio-status", INBOUND_HOOK, params)).status, 403, "signed for the inbound hook's URL");
  assert.equal((await twilioPost(w, "/hooks/twilio-status", "https://monitor.internal/hooks/twilio-status", params)).status, 403);
  assert.equal((await twilioPost(w, "/hooks/twilio-status", STATUS_HOOK, params, "rotated-token")).status, 403, "no secondary token set");
  const monitor = privateView(w)["monitor"];
  const rejected = isRecord(monitor) ? monitor["twilioSignatureRejected"] : null;
  assert.ok(isRecord(rejected) && rejected["count"] === 3 && typeof rejected["lastAt"] === "string");
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((line) => line === JSON.stringify({ event: "monitor_twilio_signature_rejected", route: "/hooks/twilio-status" })),
    "no number, SID or signature in the log");
});

void test("during a rotation TWILIO_AUTH_TOKEN_SECONDARY is accepted alongside the auth token", async (t) => {
  quiet(t);
  const w = world({ TWILIO_AUTH_TOKEN_SECONDARY: "rotated-token" });
  await openIncident(w);
  const params = { AccountSid: ACCOUNT, MessageSid: SID, MessageStatus: "delivered" };
  assert.equal((await twilioPost(w, "/hooks/twilio-status", STATUS_HOOK, params, "rotated-token")).status, 204);
  assert.equal((await twilioPost(w, "/hooks/twilio-status", STATUS_HOOK, params, TOKEN)).status, 204);
  assert.equal((await twilioPost(w, "/hooks/twilio-status", STATUS_HOOK, params, "third-token")).status, 403);
});

void test("inbound SMS: the TwiML answer comes back before any delivery; the alarm (1 s later) sends the notices", async (t) => {
  quiet(t);
  const w = world();
  const { code } = await openIncident(w);
  w.alarms.length = 0;
  const before = Date.now();
  const response = await twilioPost(w, "/hooks/twilio", INBOUND_HOOK, { From: "+15555550100", Body: `ack ${code.toLowerCase()}` });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>', "acknowledged: the notice is the confirmation");
  const pending = w.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'acknowledged' AND status = 'pending'").get();
  assert.ok(pending !== undefined && Number(pending["n"]) > 0, "the acknowledgement notices wait for the alarm");
  assert.ok(w.alarms.some((at) => at >= before + 1000), "the alarm is set at the 1 s floor");

  const help = await twilioPost(w, "/hooks/twilio", INBOUND_HOOK, { From: "+15555550100", Body: "ack" });
  assert.match(await help.text(), /<Message>Already acknowledged by Primary On-call\.<\/Message>/);
  // Advanced Opt-Out names the keyword it applied (here a custom one) in OptOutType.
  const custom = await twilioPost(w, "/hooks/twilio", INBOUND_HOOK, { From: "+15555550101", Body: "Leave me alone", OptOutType: "STOP" });
  assert.equal(await custom.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>', "no reply: Twilio answers opt-outs itself");
  const listed: unknown = privateView(w)["contactHealth"];
  const health = Array.isArray(listed) ? listed.filter(isRecord) : [];
  assert.deepEqual(health.map((row) => [row["contactId"], row["state"], row["code"]]), [["secondary_oncall", "opted_out", "inbound_stop"]]);
  const stranger = await twilioPost(w, "/hooks/twilio", INBOUND_HOOK, { From: "+15555550199", Body: "ACK" });
  assert.equal(await stranger.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
});

void test("ack page: offers Escalate beside Acknowledge; the escalate POST pages the next tier", async (t) => {
  quiet(t);
  const w = world();
  const { id } = await openIncident(w);
  const token = await createAckToken(ACK_KEY, id, "primary_oncall", Date.now() + 3600_000);
  if (!isHandler(handler)) throw new Error("unreachable");
  const page = await handler.fetch(new Request(`https://monitor.internal/ack/${token}`), w.env);
  const html = await page.text();
  assert.match(html, /name="action" value="ack"/);
  assert.match(html, /name="action" value="escalate"/);
  assert.match(html, /open since \d\d:\d\d E[SD]T \(\d\d:\d\d UTC\)/, "local time first (policy.timeZone)");
  const escalated = await handler.fetch(new Request(`https://monitor.internal/ack/${token}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "action=escalate",
  }), w.env);
  assert.match(await escalated.text(), /Now paging Secondary on-call\./);
  const tier = w.db.prepare("SELECT escalation FROM incidents WHERE id = ?").get(id);
  const state: unknown = JSON.parse(typeof tier?.["escalation"] === "string" ? tier["escalation"] : "{}");
  assert.ok(isRecord(state) && state["tierIndex"] === 1);
  // A plain POST (no action) still acknowledges, as before.
  const acked = await handler.fetch(new Request(`https://monitor.internal/ack/${token}`, { method: "POST" }), w.env);
  assert.match(await acked.text(), /<h1>Acknowledged<\/h1>/);
  const again = await handler.fetch(new Request(`https://monitor.internal/ack/${token}`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "action=escalate",
  }), w.env);
  assert.match(await again.text(), /Already acknowledged/);
});
