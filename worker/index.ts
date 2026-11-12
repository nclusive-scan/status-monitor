// The monitor Worker: no public routes (workers_dev and preview URLs off, no routes). It runs every minute from
// its cron trigger and answers only the status page Worker's MONITOR service binding, which forwards these paths
// unchanged: GET /api/status, GET /api/private, GET|POST /ack/<token>, POST /hooks/twilio (inbound SMS) and
// POST /hooks/twilio-status (Twilio's delivery status callback). Both Twilio hooks are checked against the exact public
// URL Twilio signed (TWILIO_WEBHOOK_URL; STATUS_PAGE_URL + /hooks/twilio-status), never the URL the request arrives on.
//
// The Durable Object lives in jurisdiction "us" (it holds on-call phone numbers and email addresses). A jurisdiction maps
// the same name to a different object than plain idFromName, so this must be fixed before the first deploy and never
// changed afterwards: changing it starts a new, empty object.
import { verifyAckToken } from "./ack.ts";
import { brandOf } from "./brand.ts";
import { runChecks } from "./checks/run.ts";
import type { MonitorConfig } from "./config.ts";
import { monitorMode, statusViewKey, twilioStatusUrl } from "./config.ts";
import { TWILIO_STATUSES } from "./delivery-health.ts";
import { constantTimeEqual } from "./crypto.ts";
import type { Env } from "./env.ts";
import { envRecord } from "./env.ts";
import { heartbeatTarget, ping } from "./heartbeat.ts";
import type { MonitorObject } from "./monitor-object.ts";
import { localDev, monitorId } from "./monitor-id.ts";
import { fetchPlatformConfig, platformFetchSettings, resolveConfig } from "./platform-config.ts";
import { reportUrl, sendReport } from "./report.ts";
import { ackConfirmPage, ackResultPage, escalateResultPage, invalidAckPage, json, jsonText, notFound, twiml } from "./responses.ts";
import { validateTwilioSignatureAny } from "./twilio-signature.ts";
import { systemClock } from "./types.ts";

// The entry module exports only the handler (default) and the Durable Object class: the runtime refuses any other.
export { MonitorObject } from "./monitor-object.ts";

const MAX_FORM_BYTES = 64 * 1024;
const monitor = (env: Env): DurableObjectStub<MonitorObject> => env.MONITOR_STATE.get(monitorId(env.MONITOR_STATE, localDev(env)));

/**
 * Pulls the platform-managed configuration and hands it to the object. Never throws, and runs beside the checks: it
 * starts before them and is awaited only after the heartbeat, so a slow or failing platform never delays a run. It runs
 * even when the current configuration is refused, which is how a first platform revision can make it usable. In
 * standalone mode (no PLATFORM_CONFIG_URL) there is nothing to pull.
 */
async function pullPlatformConfig(env: Env, stub: DurableObjectStub<MonitorObject>, now: number): Promise<void> {
  if (monitorMode(envRecord(env)) === "standalone") return;
  try {
    const settings = platformFetchSettings(envRecord(env));
    const fetched = settings.ok ? await fetchPlatformConfig(settings, { fetch, clock: systemClock }) : settings;
    if (!fetched.ok) {
      console.error(JSON.stringify({ event: "monitor_config_pull", outcome: "error", code: fetched.code }));
      await stub.recordConfigFetchError(fetched.code, now);
      return;
    }
    const result = await stub.offerPlatformConfig(fetched.body, now);
    console.log(JSON.stringify({ event: "monitor_config_pull", outcome: result.outcome, code: result.code, notices: result.notices }));
  } catch (error) {
    console.error(JSON.stringify({ event: "monitor_config_pull", outcome: "error", code: error instanceof Error ? error.name : "unknown" }));
  }
}

async function runMonitor(env: Env, now: number): Promise<void> {
  const stub = monitor(env);
  const pull = pullPlatformConfig(env, stub, now);
  try {
    const loaded = resolveConfig(envRecord(env), await stub.storedPlatformConfig());
    if (!loaded.ok) {
      // Fail closed: no checks, no pages, no heartbeat. The status page shows the monitor as stale.
      console.error(JSON.stringify({ event: "monitor_config_invalid", errors: loaded.errors }));
      await stub.recordConfigError(loaded.errors.join("; "), now);
      return;
    }
    const { config } = loaded;
    const results = await runChecks(config.targets, {
      fetch, clock: systemClock, healthKey: config.healthKey, dnsSecondaryResolver: config.dnsSecondaryResolver,
    });
    // Folded against the targets just checked, even if the pull has meanwhile accepted a newer revision.
    const outcome = await stub.ingest(results, now, config.targets);
    const failing = results.filter((result) => result.status !== "ok").map((result) => `${result.checkId}:${result.detail}`);
    const source = config.source.kind === "platform" ? `platform:${String(config.source.revision)}` : "bootstrap";
    const target = heartbeatTarget(config, outcome.paging);
    console.log(JSON.stringify({
      event: "monitor_run", source, checks: results.length, failing, opened: outcome.opened, resolved: outcome.resolved,
      heartbeat: target === null ? "none" : target === config.heartbeatFailUrl ? "fail" : "ok",
    }));
    await ping(target, fetch);
  } finally {
    await pull;
    await report(env, stub);
  }
}

/**
 * Sends the report when one is due. Never throws; runs after the pull, also when the configuration is refused. In
 * standalone mode (no PLATFORM_CONFIG_URL) there is nobody to report to.
 */
async function report(env: Env, stub: DurableObjectStub<MonitorObject>): Promise<void> {
  if (monitorMode(envRecord(env)) === "standalone") return;
  try {
    const settings = platformFetchSettings(envRecord(env));
    const url = reportUrl(envRecord(env));
    if (!settings.ok || url === null) return;
    const now = Date.now();
    const prepared = await stub.prepareReport(now);
    if (prepared === null) return;
    const sent = await sendReport({ url, key: settings.key }, prepared.body, { fetch, clock: systemClock });
    if (sent.ok) {
      const archived = await stub.reportSent(prepared.incidentIds, sent.archived, Date.now(), prepared.seq);
      console.log(JSON.stringify({ event: "monitor_report", outcome: "ok", incidents: prepared.incidentIds.length, archived }));
    } else {
      await stub.reportFailed(sent.code, Date.now(), prepared.incidentIds.length);
      console.error(JSON.stringify({ event: "monitor_report", outcome: "error", code: sent.code }));
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "monitor_report", outcome: "error", code: error instanceof Error ? error.name : "unknown" }));
  }
}

async function readForm(request: Request): Promise<[string, string][] | null> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) return null;
  const body = await request.text();
  if (body.length > MAX_FORM_BYTES) return null;
  return [...new URLSearchParams(body).entries()];
}

const noStore = (status: number): Response => new Response(null, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/**
 * The form of a Twilio webhook whose X-Twilio-Signature is valid for `publicUrl(config)` under the auth token (or,
 * during a rotation, TWILIO_AUTH_TOKEN_SECONDARY), with the effective config; otherwise the response to give. A bad
 * signature is logged as monitor_twilio_signature_rejected (route only, nothing from the request) and counted.
 */
async function verifiedTwilioForm(
  request: Request,
  env: Env,
  route: string,
  publicUrl: (config: MonitorConfig) => string,
): Promise<{ readonly config: MonitorConfig; readonly params: [string, string][] } | Response> {
  // The effective config: with a platform policy stored, ESCALATION_POLICY may be absent and loadConfig(env) alone fails.
  const loaded = resolveConfig(envRecord(env), await monitor(env).storedPlatformConfig());
  if (!loaded.ok || loaded.config.twilio === null) return notFound();
  const { twilio } = loaded.config;
  const params = await readForm(request);
  if (params === null) return notFound();
  const signature = request.headers.get("x-twilio-signature");
  if (!(await validateTwilioSignatureAny([twilio.authToken, twilio.authTokenSecondary], publicUrl(loaded.config), params, signature))) {
    console.warn(JSON.stringify({ event: "monitor_twilio_signature_rejected", route }));
    try {
      await monitor(env).recordTwilioSignatureRejected(Date.now());
    } catch {
      // Counting is best effort; the request is refused either way.
    }
    return new Response("forbidden", { status: 403, headers: { "cache-control": "no-store" } });
  }
  return { config: loaded.config, params };
}

const param = (params: readonly [string, string][], name: string): string => params.find(([key]) => key === name)?.[1] ?? "";

async function handleTwilio(request: Request, env: Env): Promise<Response> {
  const verified = await verifiedTwilioForm(request, env, "/hooks/twilio", (config) => config.twilioWebhookUrl);
  if (verified instanceof Response) return verified;
  // With Advanced Opt-Out, Twilio names the opt-out or opt-in it applied (custom keywords included) in OptOutType.
  const optOutType = param(verified.params, "OptOutType").toUpperCase();
  const body = optOutType === "STOP" || optOutType === "START" ? optOutType : param(verified.params, "Body").slice(0, 160);
  // The object answers without waiting for any delivery (they go out from its alarm), so Twilio gets the TwiML at once.
  return twiml(await monitor(env).acknowledgeBySms(param(verified.params, "From"), body, Date.now()));
}

/**
 * POST /hooks/twilio-status: Twilio's status callback for a message the monitor sent. Form fields used:
 * MessageSid (or SmsSid), MessageStatus (or SmsStatus), ErrorCode (failed/undelivered), AccountSid. Answers 204 for
 * anything correctly signed, known or not, so Twilio has nothing to retry.
 */
async function handleTwilioStatus(request: Request, env: Env): Promise<Response> {
  const verified = await verifiedTwilioForm(request, env, "/hooks/twilio-status", (config) => twilioStatusUrl(config.statusPageUrl));
  if (verified instanceof Response) return verified;
  const { params, config } = verified;
  const either = (first: string, second: string): string => (param(params, first) !== "" ? param(params, first) : param(params, second));
  const sid = either("MessageSid", "SmsSid");
  const status = either("MessageStatus", "SmsStatus").toLowerCase();
  const errorCode = param(params, "ErrorCode");
  const account = param(params, "AccountSid");
  if (!/^(?:SM|MM)[0-9a-f]{32}$/.test(sid) || !TWILIO_STATUSES.includes(status) || (account !== "" && account !== config.twilio?.accountSid)) {
    return noStore(204);
  }
  const code = /^\d{1,6}$/.test(errorCode) ? `twilio_${errorCode}` : null;
  const known = await monitor(env).recordSmsStatus(sid, status, code, Date.now());
  if (code !== null || status === "failed" || status === "undelivered") {
    console.log(JSON.stringify({ event: "monitor_sms_status", status, code, known }));
  }
  return noStore(204);
}

async function handleAck(request: Request, env: Env, token: string): Promise<Response> {
  const brand = brandOf(envRecord(env));
  // Byte for byte, as config.ts signs with it (a padded key fails config, so no link was signed with it).
  const key = env.ACK_SIGNING_KEY ?? "";
  if (key.trim() === "" || key !== key.trim()) return invalidAckPage(brand);
  const verified = await verifyAckToken(key, token, Date.now());
  if (!verified.ok) return invalidAckPage(brand);
  const stub = monitor(env);
  if (request.method === "GET" || request.method === "HEAD") {
    const incident = await stub.incidentForAck(verified.claims.i, verified.claims.c);
    return incident === null ? invalidAckPage(brand) : ackConfirmPage(incident, brand);
  }
  // The confirm page's buttons post action=ack (or no body: acknowledge) or action=escalate.
  const form = await readForm(request);
  if (form !== null && param(form, "action") === "escalate") {
    const { outcome, tierName } = await stub.escalateByLink(verified.claims.i, verified.claims.c, Date.now());
    return escalateResultPage(outcome, tierName, brand);
  }
  return ackResultPage(await stub.acknowledgeByLink(verified.claims.i, verified.claims.c, Date.now()), brand);
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  if (url.pathname === "/api/status" && method === "GET") {
    return json(await monitor(env).publicStatus(Date.now()), 200, "public, max-age=15");
  }
  if (url.pathname === "/api/private" && method === "GET") {
    const key = statusViewKey(envRecord(env));
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (key === null || !constantTimeEqual(presented, key)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json", "cache-control": "no-store", "www-authenticate": "Bearer" },
      });
    }
    return jsonText(await monitor(env).privateStatus(Date.now()));
  }
  const ack = /^\/ack\/([A-Za-z0-9_.-]{1,512})$/.exec(url.pathname);
  if (ack?.[1] !== undefined && (method === "GET" || method === "HEAD" || method === "POST")) return handleAck(request, env, ack[1]);
  if (url.pathname === "/hooks/twilio" && method === "POST") return handleTwilio(request, env);
  if (url.pathname === "/hooks/twilio-status" && method === "POST") return handleTwilioStatus(request, env);
  return notFound();
}

export default {
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(runMonitor(env, controller.scheduledTime));
  },
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(JSON.stringify({ event: "monitor_fetch_error", message: error instanceof Error ? error.name : "unknown" }));
      return json({ error: "unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
