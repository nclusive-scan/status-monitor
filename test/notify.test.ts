// Twilio against a scripted fetch, the Email Service sender against a fake send_email binding, message text, delivery
// routing (including DELIVERY_MODE=log and config-change notices), and the public/private split.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyAckToken } from "../worker/ack.ts";
import type { MonitorConfig, TwilioSettings } from "../worker/config.ts";
import { deliver } from "../worker/deliver.ts";
import { contactProblemFor } from "../worker/delivery-health.ts";
import { contactByPhone, parseAckReply } from "../worker/inbound.ts";
import type { EmailBinding } from "../worker/notify/email.ts";
import { createEmailSender, emailFailure, RETRYABLE_EMAIL_CODES } from "../worker/notify/email.ts";
import { configChangeEmail, emailContent, smsText } from "../worker/notify/messages.ts";
import type { MessageContext } from "../worker/notify/messages.ts";
import { sendSms, twilioErrorCode } from "../worker/notify/twilio.ts";
import { maskEmail, maskPhone, privateProjection, publicProjection } from "../worker/redact.ts";
import type { Snapshot } from "../worker/redact.ts";
import { initialComponentState } from "../worker/engine.ts";
import type { IncidentRow, OutboxRow } from "../worker/store.ts";
import { isRecord as isRecordValue } from "../worker/types.ts";
import { examplePolicy, fixtureTargets, header, jsonResponse, MINUTE, scriptedFetch, T0 } from "./support/fakes.ts";

const twilio: TwilioSettings = {
  accountSid: `AC${"1".repeat(32)}`, username: `AC${"1".repeat(32)}`, password: "auth-token", authToken: "auth-token", authTokenSecondary: null,
  from: "+15555550123", messagingServiceSid: null,
};
const emailSettings = { from: "alerts@example.com", fromName: "Acme Status" };

const bodyText = (init: RequestInit | undefined): string => (typeof init?.body === "string" ? init.body : "");

void test("twilio: posts To/From/Body, a 10-minute ValidityPeriod and the status callback, with Basic auth", async () => {
  const { fetch, calls } = scriptedFetch(() => jsonResponse({ sid: `SM${"a".repeat(32)}` }, 201));
  const result = await sendSms(twilio, "+15555550100", "hello", fetch, "https://status.example.com/hooks/twilio-status");
  assert.deepEqual(result, { ok: true, providerId: `SM${"a".repeat(32)}` });
  assert.equal(calls[0]?.url, `https://api.twilio.com/2010-04-01/Accounts/AC${"1".repeat(32)}/Messages.json`);
  assert.equal(header(calls[0].init, "authorization"), `Basic ${Buffer.from(`AC${"1".repeat(32)}:auth-token`).toString("base64")}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(bodyText(calls[0].init))), {
    To: "+15555550100", Body: "hello", ValidityPeriod: "600", From: "+15555550123", StatusCallback: "https://status.example.com/hooks/twilio-status",
  });
  const viaService = scriptedFetch(() => jsonResponse({ sid: `SM${"b".repeat(32)}` }, 201));
  await sendSms({ ...twilio, from: null, messagingServiceSid: `MG${"2".repeat(32)}` }, "+15555550100", "x", viaService.fetch);
  assert.equal(new URLSearchParams(bodyText(viaService.calls[0]?.init)).get("MessagingServiceSid"), `MG${"2".repeat(32)}`);
});

void test("twilio: 429/5xx and network errors retry; other 4xx do not; only the integer code of an error body is read", async () => {
  const status = async (code: number, body = "secret body") => sendSms(twilio, "+1", "x", scriptedFetch(() => new Response(body, { status: code })).fetch);
  assert.deepEqual(await status(503), { ok: false, retryable: true, code: "twilio_http_503" });
  assert.deepEqual(await status(429), { ok: false, retryable: true, code: "twilio_http_429" });
  assert.deepEqual(await status(400), { ok: false, retryable: false, code: "twilio_http_400" });
  const twilioError = (code: unknown): string =>
    JSON.stringify({ status: 400, code, message: "The message To +15555550100 'secret text' failed", more_info: "https://www.twilio.com/docs/errors/x" });
  const named: [number, string][] = [
    [21610, "twilio_recipient_opted_out"], [21211, "twilio_invalid_number"], [21614, "twilio_not_sms_capable"], [21408, "twilio_region_not_enabled"],
  ];
  for (const [code, expected] of named) {
    const result = await status(400, twilioError(code));
    assert.deepEqual(result, { ok: false, retryable: false, code: expected });
    assert.ok(!JSON.stringify(result).includes("5555550100") && !JSON.stringify(result).includes("secret"), "the message never leaves");
  }
  assert.deepEqual(await status(400, twilioError(21606)), { ok: false, retryable: false, code: "twilio_21606" });
  assert.deepEqual(await status(429, twilioError(20429)), { ok: false, retryable: true, code: "twilio_20429" }, "still retryable");
  assert.deepEqual(await status(400, twilioError("21610")), { ok: false, retryable: false, code: "twilio_http_400" }, "only an integer code counts");
  assert.deepEqual(await status(400, twilioError(1.5)), { ok: false, retryable: false, code: "twilio_http_400" });
  assert.deepEqual(await status(400, `{"code": 21610, "pad": "${"x".repeat(5000)}"}`), { ok: false, retryable: false, code: "twilio_http_400" },
    "an oversized body is not read");
  assert.deepEqual(await status(401, "not json"), { ok: false, retryable: false, code: "twilio_http_401" });
  const offline = await sendSms(twilio, "+1", "x", scriptedFetch(() => {
    throw new TypeError("offline");
  }).fetch);
  assert.deepEqual(offline, { ok: false, retryable: true, code: "twilio_network" });
});

void test("twilio: an error body with no Content-Length is read only up to the cap, never buffered whole", async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode(`{"code": 21610, "pad": "${"x".repeat(64 * 1024)}`);
  const stream = (chunks: number): ReadableStream<Uint8Array> => {
    let left = chunks;
    return new ReadableStream({
      pull(controller) {
        if (left === 0) {
          controller.close();
          return;
        }
        left -= 1;
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
  };
  const chunked = new Response(stream(160), { status: 400 });
  assert.equal(chunked.headers.get("content-length"), null);
  assert.equal(await twilioErrorCode(chunked), null, "too large: abandoned unparsed");
  assert.ok(pulled < 4 * chunk.byteLength, `pulled ${String(pulled)} bytes of a 10 MiB body`);
  // A small body without a Content-Length is still parsed.
  const small = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"code": 21610}'));
      controller.close();
    },
  }), { status: 400 });
  assert.equal(await twilioErrorCode(small), 21610);
});

type Sent = Parameters<EmailBinding["send"]>[0];

/** A send_email binding double: records each message and answers with a result or a thrown Email Service error. */
function fakeBinding(answer: (message: Sent) => Promise<{ messageId: string }> = () => Promise.resolve({ messageId: "<m-1@cf>" })): {
  binding: EmailBinding;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    binding: {
      send: (message) => {
        sent.push(message);
        return answer(message);
      },
    },
  };
}

const serviceError = (code: string): Error => Object.assign(new Error(`${code}: recipient a@example.com refused`), { code });

void test("email: sends through the binding as alerts@example.com with the outbox key and Auto-Submitted headers", async () => {
  const { binding, sent } = fakeBinding();
  const sender = createEmailSender(binding, emailSettings);
  const result = await sender.send({
    to: "primary@example.com", subject: "[Acme] DOWN: Signup", text: "body", key: "inc_1:page-c1-t0:primary_oncall:email",
  });
  assert.deepEqual(result, { ok: true, providerId: "cfemail:<m-1@cf>" });
  assert.deepEqual(sent[0], {
    from: { email: "alerts@example.com", name: "Acme Status" }, to: "primary@example.com", subject: "[Acme] DOWN: Signup", text: "body",
    headers: { "Auto-Submitted": "auto-generated", "X-Status-Monitor-Outbox-Key": "inc_1:page-c1-t0:primary_oncall:email" },
  });
  assert.equal(Object.keys(sent[0].headers).some((name) => name.toLowerCase() === "message-id"), false, "Message-ID is platform-controlled");
});

void test("email: rate limit, delivery failure and service errors retry; every other Email Service code does not; messages never leak", async () => {
  assert.deepEqual([...RETRYABLE_EMAIL_CODES], ["E_RATE_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INTERNAL_SERVER_ERROR"]);
  const outcome = async (error: unknown) =>
    createEmailSender(fakeBinding(() => Promise.reject(error instanceof Error ? error : new Error("x"))).binding, emailSettings)
      .send({ to: "a@example.com", subject: "s", text: "t", key: "k" });
  assert.deepEqual(await outcome(serviceError("E_RATE_LIMIT_EXCEEDED")), { ok: false, retryable: true, code: "email_rate_limit_exceeded" });
  assert.deepEqual(await outcome(serviceError("E_DELIVERY_FAILED")), { ok: false, retryable: true, code: "email_delivery_failed" });
  assert.deepEqual(await outcome(serviceError("E_INTERNAL_SERVER_ERROR")), { ok: false, retryable: true, code: "email_internal_server_error" });
  for (const code of ["E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_RECIPIENT_SUPPRESSED", "E_VALIDATION_ERROR", "E_DAILY_LIMIT_EXCEEDED",
    "E_ACCOUNT_SUSPENDED", "E_HEADER_NOT_ALLOWED"]) {
    const result = await outcome(serviceError(code));
    assert.deepEqual(result, { ok: false, retryable: false, code: `email_${code.slice(2).toLowerCase()}` }, code);
    assert.ok(!JSON.stringify(result).includes("example.com"), "the error message is never carried");
  }
  assert.deepEqual(emailFailure(new TypeError("binding unavailable")), { ok: false, retryable: true, code: "email_error" });
  assert.deepEqual(emailFailure({ code: "not an email code" }), { ok: false, retryable: true, code: "email_error" });
});

void test("email: a send that never answers times out as a retryable failure", async () => {
  const hung = fakeBinding(() => new Promise(() => undefined));
  assert.deepEqual(await createEmailSender(hung.binding, emailSettings, 20).send({ to: "a@example.com", subject: "s", text: "t", key: "k" }),
    { ok: false, retryable: true, code: "email_timeout" });
});

void test("email: line breaks in the subject are flattened and the outbox key header keeps a narrow alphabet", async () => {
  const { binding, sent } = fakeBinding();
  await createEmailSender(binding, emailSettings).send({ to: "a@example.com", subject: "hi\r\nBcc: y@evil.test", text: "t", key: "k\r\nBcc: x" });
  assert.equal(sent[0]?.subject, "hi Bcc: y@evil.test");
  assert.doesNotMatch(sent[0].headers["X-Status-Monitor-Outbox-Key"] ?? "", /[\r\n ]/);
});

const context = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  brand: "Acme", kind: "page", componentName: "Signup", incidentTitle: "Signup is down", openedAt: T0, ackCode: "K7M2QX", statusPageUrl: "https://status.example.com",
  cycle: 1, maxCycles: 3, targetTierName: "Secondary on-call", targetContactNames: ["Secondary On-call", "Engineering Lead"], acknowledgedBy: null,
  now: T0 + 5 * MINUTE, ackUrl: "https://status.example.com/ack/token", ...overrides,
});

void test("messages: pages carry the ACK code and status link; notices say who it went to; no numbers or addresses", () => {
  assert.equal(smsText(context()), "[Acme] DOWN: Signup. Reply ACK K7M2QX to acknowledge. status.example.com\nSignup is down since 14:00 UTC.");
  assert.equal(smsText(context({ timeZone: "America/New_York" })),
    "[Acme] DOWN: Signup. Reply ACK K7M2QX to acknowledge. status.example.com\nSignup is down since 09:00 EST (14:00 UTC).", "local time first");
  assert.match(smsText(context({ kind: "escalation_notice" })),
    /Still unacknowledged after 5 min\. Now paging Secondary on-call \(Secondary On-call, Engineering Lead\)/);
  assert.match(smsText(context({ kind: "cycle_notice", cycle: 2 })), /\[cycle 2\/3\][^]*Starting over at/);
  assert.match(smsText(context({ kind: "acknowledged", acknowledgedBy: "Engineering Lead" })), /Acknowledged by Engineering Lead\. Paging stopped\./);
  assert.match(
    smsText(context({ kind: "resolved", now: T0 + 23 * MINUTE })), /^\[Acme\] RESOLVED: Signup\. status\.example\.com\nRecovered after 23 min\.$/,
  );
  const email = emailContent(context({ kind: "exhausted" }));
  assert.equal(email.subject, "[Acme] UNACKNOWLEDGED after 3 cycles: Signup");
  assert.match(email.text, /Paging has stopped; the incident is still open\./);
  assert.match(email.text, /Reply ACK K7M2QX to acknowledge by SMS, or use the link below\./);
  assert.match(email.text, /can escalate to the next tier now/);
  assert.doesNotMatch(emailContent(context({ drill: true })).text, /escalate/, "a drill link offers no escalation");
  assert.match(email.text, /https:\/\/status\.example\.com\/ack\/token/);
  assert.doesNotMatch(emailContent(context({ kind: "resolved" })).text, /\/ack\//, "no ack link once resolved");
});

void test("inbound SMS: ACK <code> from a known number only", () => {
  assert.equal(parseAckReply("ack k7m2qx"), "K7M2QX");
  assert.equal(parseAckReply("  ACK K7M2QX. "), "K7M2QX");
  assert.equal(parseAckReply("ACK"), null);
  assert.equal(parseAckReply("please ACK K7M2QX"), null);
  assert.equal(contactByPhone(examplePolicy(), "+15555550101")?.id, "secondary_oncall");
  assert.equal(contactByPhone(examplePolicy(), "+15555550198"), null);
});

const config: MonitorConfig = {
  brandName: "Acme", mode: "standalone", targets: fixtureTargets(), policy: examplePolicy(), statusPageUrl: "https://status.example.com",
  twilioWebhookUrl: "https://status.example.com/hooks/twilio", healthKey: null, configKey: null, ackSigningKey: "a".repeat(40), twilio,
  email: emailSettings, heartbeatUrl: null, heartbeatFailUrl: null, dnsSecondaryResolver: null, maintenance: [], deliveryMode: "live",
  source: { kind: "bootstrap" },
};
const incident: IncidentRow = {
  id: "inc_1", componentId: "signup", title: "Signup is down", openedAt: T0, ackCode: "K7M2QX", phase: "paging", acknowledgedAt: null,
  acknowledgedBy: null, resolvedAt: null, nextAlarmAt: T0 + 5 * MINUTE, escalation: null, groupId: "inc_1", closeReason: null, drill: false,
  peakStatus: "down", acknowledgedContact: null, acknowledgedVia: null, exportedAt: null, alertMode: "page", handedOverTo: null,
};
const row = (channel: "sms" | "email"): OutboxRow => ({
  key: `inc_1:page-c1-t0:primary_oncall:${channel}`, incidentId: "inc_1", kind: "page", contactId: "primary_oncall", contactName: "Primary On-call",
  channel, recipient: channel === "sms" ? "+15555550100" : "primary@example.com", tierId: "primary", cycle: 1, target: null, acknowledgedBy: null,
  status: "pending", attempts: 0, lastError: null, createdAt: T0, sentAt: null, providerId: null, configChange: null, detail: null, about: null,
  deliveryStatus: null, deliveryCode: null,
});

void test("delivery: SMS goes to Twilio; email goes to Email Service with a signed, expiring, single-incident ack link", async () => {
  const { fetch, calls } = scriptedFetch(() => jsonResponse({ sid: `SM${"c".repeat(32)}` }, 201));
  assert.equal((await deliver(row("sms"), incident, { config, fetch, email: null, now: T0 })).ok, true);
  assert.match(new URLSearchParams(bodyText(calls[0]?.init)).get("Body") ?? "", /Reply ACK K7M2QX/);
  const { binding, sent } = fakeBinding();
  assert.equal((await deliver(row("email"), incident, { config, fetch, email: createEmailSender(binding, emailSettings), now: T0 })).ok, true);
  const token = /\/ack\/([^\s]+)/.exec(sent[0]?.text ?? "")?.[1] ?? "";
  const verified = await verifyAckToken(config.ackSigningKey, token, T0 + 23 * 3600_000);
  assert.ok(verified.ok && verified.claims.i === "inc_1" && verified.claims.c === "primary_oncall");
  assert.deepEqual(await verifyAckToken(config.ackSigningKey, token, T0 + 25 * 3600_000), { ok: false, reason: "expired" });
  assert.deepEqual(await deliver(row("email"), incident, { config, fetch, email: null, now: T0 }),
    { ok: false, retryable: false, code: "email_not_configured" });
});

const configRow: OutboxRow = {
  ...row("email"), key: "cfg_r8:config_change:0:email", incidentId: "cfg_r8", kind: "config_change", cycle: 0,
  configChange: { revision: 8, updatedBy: "Dana Admin", added: ["New Person"], removed: ["Vendor Support"], changed: ["Primary On-call: mobile changed"] },
};

void test("DELIVERY_MODE=log records every delivery without calling Twilio or the email binding", async () => {
  const { fetch, calls } = scriptedFetch(() => {
    throw new Error("no provider may be called in log mode");
  });
  const { binding, sent } = fakeBinding();
  const deps = { config: { ...config, deliveryMode: "log" as const }, fetch, email: createEmailSender(binding, emailSettings), now: T0 };
  const logs: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => {
    logs.push(String(line));
  };
  try {
    assert.deepEqual(await deliver(row("sms"), incident, deps), { ok: true, providerId: "log:sms" });
    assert.deepEqual(await deliver(row("email"), incident, deps), { ok: true, providerId: "log:email" });
    assert.deepEqual(await deliver(configRow, null, deps), { ok: true, providerId: "log:email" });
  } finally {
    console.log = original;
  }
  assert.equal(calls.length, 0, "Twilio was not called");
  assert.equal(sent.length, 0, "no email was sent");
  assert.equal(logs.length, 3);
  assert.ok(logs.every((line) => line.includes("delivery_logged") && !line.includes("+15555550100") && !line.includes("primary@example.com")),
    "the log masks recipients");
});


void test("a config-change notice is an informational email naming the revision, the editor and the contact changes", async () => {
  const { binding, sent } = fakeBinding();
  const { fetch, calls } = scriptedFetch(() => jsonResponse({}));
  assert.equal((await deliver(configRow, null, { config, fetch, email: createEmailSender(binding, emailSettings), now: T0 })).ok, true);
  assert.equal(calls.length, 0, "never an SMS");
  assert.equal(sent[0]?.subject, "[Acme] Alert contacts changed (revision 8)");
  const text = sent[0].text;
  assert.match(text, /revision 8, saved by Dana Admin/);
  assert.match(text, /Added: New Person\nRemoved: Vendor Support\nChanged: Primary On-call: mobile changed/);
  assert.match(text, /nobody is being paged/);
  assert.doesNotMatch(text, /\/ack\/|Reply ACK|\+1555/, "nothing to acknowledge, no numbers");
  assert.deepEqual(await deliver({ ...configRow, channel: "sms" }, null, { config, fetch, email: null, now: T0 }),
    { ok: false, retryable: false, code: "config_notice_invalid" }, "a config change never goes by SMS");
  assert.equal(configChangeEmail({ ...configRow.configChange ?? { revision: 1, added: [], removed: [], changed: [] }, updatedBy: null }, "Acme").text
    .includes("an unknown editor"), true);
});

const snapshot = (now: number, lastRunAt: number | null): Snapshot => ({
  now, brand: "Acme", lastRunAt, configError: "",
  config: {
    mode: "platform", source: "platform", revision: 7, storedRevision: 7, updatedAt: "2026-11-11T20:00:00.000Z", updatedBy: "Dana Admin", lastFetchAt: T0,
    lastErrorCode: "config_timeout", lastErrorAt: T0 - MINUTE, lastErrorDetail: null, lastErrorRevision: null, deliveryMode: "live",
  },
  components: [{
    config: { id: "signup", name: "Signup", pageOn: "down", alert: "page", public: true },
    state: { ...initialComponentState("signup"), status: "down", since: T0 },
  }],
  uptime: new Map([["signup", { h24: 99.5, d7: 99.9, d30: 99.95 }]]),
  history: new Map(),
  incidents: [incident],
  checks: [{ checkId: "platform_deep", componentId: "platform_api", type: "deep", status: "ok", inconclusive: false, latencyMs: 12, detail: "ok",
    observedAt: T0, data: { url: "https://platform.example.com/api/v2/monitor/health", release: { version: "1.4.2" } } }],
  recentFailures: [{ checkId: "signup_http", status: "down", detail: "redirect_loop", observedAt: T0, latencyMs: 30 }],
  notifications: [row("sms"), row("email")],
  events: [{ incidentId: "inc_1", at: T0, type: "opened", detail: "redirect_loop", tierId: null, contactId: null, channel: null, code: "redirect_loop" }],
  maintenance: [],
  warnings: ["heartbeat_missing"],
  contactHealth: [{ contactId: "primary_oncall", channel: "sms", state: "opted_out", code: "twilio_21610", since: T0 }],
  drills: [],
  nextDrillAt: null,
  report: { lastOkAt: T0, lastErrorCode: null, lastErrorAt: null },
  heartbeat: { configured: false, failUrlConfigured: false, paging: { failedPages: 0, oldestPendingMs: null } },
  dnsInconclusiveSince: null,
  prunedUnexported: { count: 0, at: null },
  maintenanceAll: [],
});

void test("public status carries no URLs, details, codes, contacts or numbers; private masks contacts", () => {
  const publicText = JSON.stringify(publicProjection(snapshot(T0 + MINUTE, T0)));
  for (const secret of ["https://", "redirect_loop", "K7M2QX", "+1555", "5555550100", "example.com", "primary_oncall", "Primary On-call", "1.4.2"]) {
    assert.ok(!publicText.includes(secret), `public status leaks ${secret}`);
  }
  const view = publicProjection(snapshot(T0 + MINUTE, T0));
  assert.deepEqual(view.incidents[0], { id: "inc_1", component: "Signup", title: "Signup is down", startedAt: new Date(T0).toISOString(),
    acknowledged: false, resolved: false, resolvedAt: null });
  assert.equal(view.overall, "down");
  const privateText = JSON.stringify(privateProjection(snapshot(T0 + MINUTE, T0)));
  assert.ok(privateText.includes("•••0100") && privateText.includes("p…@example.com") && privateText.includes("K7M2QX"));
  assert.ok(!privateText.includes("+15555550100") && !privateText.includes("primary@example.com"), "private view masks contacts");
  assert.ok(!publicText.includes("Dana Admin") && !publicText.includes("config_timeout"), "config provenance is private");
  const monitor = privateProjection(snapshot(T0 + MINUTE, T0))["monitor"];
  assert.deepEqual(isRecordValue(monitor) ? monitor["config"] : null, {
    mode: "platform", source: "platform", revision: 7, storedRevision: 7, updatedAt: "2026-11-11T20:00:00.000Z", updatedBy: "Dana Admin",
    lastFetchAt: new Date(T0).toISOString(), lastErrorCode: "config_timeout", lastErrorAt: new Date(T0 - MINUTE).toISOString(), lastErrorDetail: null,
    lastErrorRevision: null,
  });
  assert.equal(isRecordValue(monitor) ? monitor["deliveryMode"] : null, "live");
  assert.equal(maskPhone("+15555550123"), "•••0123");
  assert.equal(maskEmail("oncall@example.com"), "o…@example.com");
});

void test("a monitor silent for more than 5 minutes is stale and vouches for nothing", () => {
  const stale = publicProjection(snapshot(T0 + 6 * MINUTE, T0));
  assert.equal(stale.monitor.stale, true);
  assert.equal(stale.overall, "unknown");
  assert.deepEqual(stale.components.map((item) => item.status), ["unknown"]);
  assert.equal(publicProjection(snapshot(T0, null)).monitor.stale, true, "never ran");
  assert.equal(publicProjection({ ...snapshot(T0 + MINUTE, T0), configError: "policy: invalid" }).monitor.stale, true, "misconfigured");
});

void test("a suppressed address is known only from E_RECIPIENT_SUPPRESSED, so the README keeps \"Drop suppressed recipients\" off", () => {
  const failed = emailFailure(Object.assign(new Error("recipient suppressed"), { code: "E_RECIPIENT_SUPPRESSED" }));
  assert.deepEqual(failed, { ok: false, retryable: false, code: "email_recipient_suppressed" });
  assert.equal(contactProblemFor("email", "email_recipient_suppressed"), "suppressed");
  // With the setting on, Email Service drops the address and send() succeeds: nothing above ever happens.
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /\*\*Leave "Drop suppressed recipients" off\*\*/, "a deploy prerequisite");
  assert.match(readme, /\| "Drop suppressed recipients" turned on for the sending domain \|/, "and a failure mode");
});
