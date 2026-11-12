// Runtime hardening: the connection limiter (no false timeouts behind hung origins), the heartbeat and its failure
// URL, the DNS fallback resolver and the inconclusive-DNS notice, paging health, the provider-status seam, and the
// claim lease against the slowest delivery batch.
import assert from "node:assert/strict";
import test from "node:test";
import { runDnsCheck } from "../worker/checks/dns.ts";
import { CHECK_CONCURRENCY, runChecks } from "../worker/checks/run.ts";
import type { CheckConfig, DnsCheckConfig, HttpCheckConfig, TargetsConfig } from "../worker/config.ts";
import { heartbeatTarget, PENDING_PAGE_ALARM_MS, ping } from "../worker/heartbeat.ts";
import { createLimiter } from "../worker/limit.ts";
import { CLAIM_BATCH, CLAIM_MS, DELIVERY_CONCURRENCY, MonitorStore, WORST_SEND_MS } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { systemClock } from "../worker/types.ts";
import { configWarnings, runtimeWarnings, storeSignals } from "../worker/warnings.ts";
import { countingRandom, examplePolicy, fixtureTargets, FakeClock, jsonResponse, MINUTE, scriptedFetch, sqliteStorage, T0 } from "./support/fakes.ts";

void test("limiter: never more than capacity at once, weights count, and queued work starts as slots free", async () => {
  const limiter = createLimiter(5);
  let running = 0, peak = 0;
  // A weight above the capacity is held to the capacity (it runs alone).
  const job = (ms: number, weight: number) => limiter.run(async () => {
    running += Math.min(weight, 5);
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running -= Math.min(weight, 5);
    return weight;
  }, weight);
  const results = await Promise.all([job(20, 2), job(20, 2), job(20, 2), job(5, 1), job(5, 1), job(5, 9)]);
  assert.deepEqual(results, [2, 2, 2, 1, 1, 9]);
  assert.ok(peak <= 5, `peak ${String(peak)}`);
  await assert.rejects(limiter.run(() => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await limiter.run(() => Promise.resolve("still works")), "still works", "a failed job frees its slot");
});

const hangingCheck = (index: number): HttpCheckConfig => ({
  type: "http", id: `hang_${String(index)}`, component: "signup", url: `https://hang${String(index)}.example.com/`, method: "GET",
  expectStatus: { min: 200, max: 299 }, maxRedirects: 0, bodyIncludes: null, latencyDegradedMs: 30_000, timeoutMs: 1000,
});

void test("checks: 7 hung origins plus a healthy one: at most 5 connections, each timeout measures only its own request", async () => {
  let inFlight = 0, peak = 0;
  const { fetch } = scriptedFetch((url, init) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const done = (): void => {
      inFlight -= 1;
    };
    if (url.startsWith("https://healthy")) {
      done();
      return new Response("ok");
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        done();
        reject(init.signal?.reason instanceof Error ? init.signal.reason : new DOMException("aborted", "AbortError"));
      });
    });
  });
  const healthy: CheckConfig = { ...hangingCheck(99), id: "healthy", url: "https://healthy.example.com/" };
  const targets: TargetsConfig = { ...fixtureTargets(), checks: [...Array.from({ length: 7 }, (_, index) => hangingCheck(index)), healthy] };
  const started = Date.now();
  const results = await runChecks(targets, { fetch, clock: systemClock, healthKey: null });
  const elapsed = Date.now() - started;
  assert.ok(peak <= CHECK_CONCURRENCY, `peak ${String(peak)} connections`);
  const hung = results.filter((result) => result.checkId.startsWith("hang_"));
  assert.deepEqual([...new Set(hung.map((result) => result.detail))], ["timeout"]);
  assert.ok(hung.every((result) => result.latencyMs < 1800), `each timer starts with its slot: ${hung.map((result) => result.latencyMs).join(",")}`);
  assert.ok(elapsed >= 1900, "the queued checks really waited for a slot");
  assert.deepEqual(results.filter((result) => result.checkId === "healthy").map((result) => [result.status, result.detail]), [["ok", "ok"]],
    "the healthy origin is not a false timeout");
});

void test("checks: a DNS check holds two slots (its A and AAAA lookups run together)", async () => {
  let inFlight = 0, peak = 0;
  const { fetch } = scriptedFetch(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return jsonResponse({ Status: 0, Answer: [{ type: 1, data: "216.150.1.65" }] });
  });
  const dns = (index: number): CheckConfig => ({ type: "dns", id: `d${String(index)}`, component: "signup", hostname: `h${String(index)}.example.com`,
    dnsOnly: true, timeoutMs: 5000 });
  await runChecks({ ...fixtureTargets(), checks: Array.from({ length: 6 }, (_, index) => dns(index)) }, { fetch, clock: new FakeClock(), healthKey: null });
  assert.ok(peak <= CHECK_CONCURRENCY, `peak ${String(peak)}`);
});

const dnsCheck: DnsCheckConfig = { type: "dns", id: "signup_dns", component: "signup", hostname: "signup.example.test", dnsOnly: true, timeoutMs: 2000 };

void test("dns: a second resolver answers when the first fails; only both failing is inconclusive", async () => {
  const answer = jsonResponse({ Status: 0, Answer: [{ type: 1, data: "216.150.1.65" }] });
  const { fetch, calls } = scriptedFetch((url) => (url.startsWith("https://cloudflare-dns.com/") ? new Response("", { status: 503 }) : answer.clone()));
  const ok = await runDnsCheck(dnsCheck, { fetch, clock: new FakeClock(), secondaryResolver: "https://dns.google/resolve" });
  assert.deepEqual([ok.status, ok.inconclusive, ok.data?.["resolver"]], ["ok", false, "dns.google"]);
  assert.ok(calls.some((call) => call.url.startsWith("https://dns.google/resolve?name=signup.example.test&type=A")));
  const none = await runDnsCheck(dnsCheck, { fetch: scriptedFetch(() => new Response("", { status: 503 })).fetch, clock: new FakeClock(),
    secondaryResolver: "https://dns.google/resolve" });
  assert.deepEqual([none.detail, none.inconclusive], ["resolver_unavailable", true]);
  const alone = await runDnsCheck(dnsCheck, { fetch, clock: new FakeClock() });
  assert.deepEqual([alone.detail, alone.inconclusive], ["resolver_unavailable", true], "without a second resolver, as before");
});

const dnsRun = (at: number, inconclusive: boolean): CheckResult[] => [{
  checkId: "signup_dns", componentId: "signup", type: "dns", status: inconclusive ? "degraded" : "ok", inconclusive, latencyMs: 5,
  detail: inconclusive ? "resolver_unavailable" : "ok", observedAt: at, data: null,
}];

void test("dns: 15 minutes of nothing but inconclusive DNS results warns and emails the first tier once per streak", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  for (let minute = 0; minute <= 16; minute += 1) store.recordRun(dnsRun(T0 + minute * MINUTE, true), fixtureTargets(), examplePolicy(), T0 + minute * MINUTE);
  assert.equal(store.dnsInconclusiveSince(), T0);
  assert.deepEqual(runtimeWarnings({ dnsInconclusiveSince: T0, prunedUnexported: 0 }, T0 + 14 * MINUTE), []);
  assert.deepEqual(runtimeWarnings({ dnsInconclusiveSince: T0, prunedUnexported: 0 }, T0 + 15 * MINUTE), ["dns_inconclusive"]);
  assert.equal(store.queueMonitorNotice("dns_inconclusive", T0, examplePolicy(), T0 + 15 * MINUTE), 1, "the first tier's email contact");
  assert.equal(store.queueMonitorNotice("dns_inconclusive", T0, examplePolicy(), T0 + 16 * MINUTE), 0, "once per streak");
  const [notice] = store.claimDue(T0 + 16 * MINUTE);
  assert.deepEqual([notice?.row.kind, notice?.row.channel, notice?.row.detail, notice?.incident], ["monitor_notice", "email", "dns_inconclusive", null]);
  store.recordRun(dnsRun(T0 + 17 * MINUTE, false), fixtureTargets(), examplePolicy(), T0 + 17 * MINUTE);
  assert.equal(store.dnsInconclusiveSince(), null, "a conclusive result ends the streak");
});

void test("dns: the streak ends when no DNS check is configured any more, so its warning cannot stay forever", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun(dnsRun(T0, true), fixtureTargets(), examplePolicy(), T0);
  assert.equal(store.dnsInconclusiveSince(), T0);
  // The DNS check is removed: later runs carry only HTTP results.
  const httpOnly = (at: number): CheckResult[] => [{
    checkId: "signup_http", componentId: "signup", type: "http", status: "ok", inconclusive: false, latencyMs: 5, detail: "ok", observedAt: at, data: null,
  }];
  for (let minute = 1; minute <= 60; minute += 1) store.recordRun(httpOnly(T0 + minute * MINUTE), fixtureTargets(), examplePolicy(), T0 + minute * MINUTE);
  assert.equal(store.dnsInconclusiveSince(), null);
  assert.deepEqual(runtimeWarnings(storeSignals(store, T0 + 60 * MINUTE), T0 + 60 * MINUTE), []);
});

void test("heartbeat: the success URL normally; the failure URL while paging fails; never refuses for a missing one", async () => {
  const urls = { heartbeatUrl: "https://hc.example.com/ping/abc", heartbeatFailUrl: "https://hc.example.com/ping/abc/fail" };
  const healthy = { failedPages: 0, oldestPendingMs: null };
  assert.equal(heartbeatTarget(urls, healthy), urls.heartbeatUrl);
  assert.equal(heartbeatTarget(urls, { failedPages: 1, oldestPendingMs: null }), urls.heartbeatFailUrl);
  assert.equal(heartbeatTarget(urls, { failedPages: 0, oldestPendingMs: PENDING_PAGE_ALARM_MS + 1 }), urls.heartbeatFailUrl);
  assert.equal(heartbeatTarget(urls, { failedPages: 0, oldestPendingMs: PENDING_PAGE_ALARM_MS }), urls.heartbeatUrl);
  assert.equal(
    heartbeatTarget({ ...urls, heartbeatFailUrl: null }, { failedPages: 1, oldestPendingMs: null }), urls.heartbeatUrl, "no fail URL: ping as usual",
  );
  assert.equal(heartbeatTarget({ heartbeatUrl: null, heartbeatFailUrl: null }, healthy), null);
  const { fetch, calls } = scriptedFetch(() => new Response("OK"));
  assert.equal(await ping(urls.heartbeatUrl, fetch), true);
  assert.deepEqual([calls[0]?.url, calls[0]?.init?.method], [urls.heartbeatUrl, "GET"]);
  assert.equal(await ping(urls.heartbeatUrl, scriptedFetch(() => {
    throw new TypeError("network");
  }).fetch), false, "never throws");
  assert.equal(await ping(null, fetch), false);
});

const run = (at: number, down: readonly string[]): CheckResult[] => fixtureTargets().components.map((component) => ({
  checkId: `${component.id}_http`, componentId: component.id, type: "http", status: down.includes(component.id) ? "down" : "ok", inconclusive: false,
  latencyMs: 5, detail: "x", observedAt: at, data: null,
}));

void test("paging health: a page that failed for good, or one stuck pending past 5 minutes, until someone acknowledges", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun(run(T0, ["signup"]), fixtureTargets(), examplePolicy(), T0);
  const id = store.recordRun(run(T0 + MINUTE, ["signup"]), fixtureTargets(), examplePolicy(), T0 + MINUTE).opened[0] ?? "";
  assert.deepEqual(store.pagingHealth(T0 + 2 * MINUTE), { failedPages: 0, oldestPendingMs: MINUTE });
  const [first, second] = store.claimDue(T0 + MINUTE);
  store.markFailed(first?.row.key ?? "", "twilio_http_400", false, T0 + MINUTE);
  store.markFailed(second?.row.key ?? "", "email_timeout", true, T0 + MINUTE);
  assert.deepEqual(store.pagingHealth(T0 + 7 * MINUTE), { failedPages: 1, oldestPendingMs: 6 * MINUTE });
  store.acknowledge(id, { name: "Primary On-call", via: "sms", contactId: "primary_oncall" }, examplePolicy(), T0 + 8 * MINUTE);
  assert.equal(store.pagingHealth(T0 + 8 * MINUTE).failedPages, 0, "acknowledged: nobody is waiting on the failed page");
});

void test("provider status seam: a final status recorded by provider id adds a delivered or failed timeline entry", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun(run(T0, ["signup"]), fixtureTargets(), examplePolicy(), T0);
  const id = store.recordRun(run(T0 + MINUTE, ["signup"]), fixtureTargets(), examplePolicy(), T0 + MINUTE).opened[0] ?? "";
  const claimed = store.claimDue(T0 + MINUTE);
  const sms = claimed.find(({ row }) => row.channel === "sms")?.row;
  const email = claimed.find(({ row }) => row.channel === "email")?.row;
  store.markSent(sms?.key ?? "", `SM${"a".repeat(32)}`, T0 + MINUTE);
  store.markSent(email?.key ?? "", "cfemail:1", T0 + MINUTE);
  const row = store.recordProviderStatus(`SM${"a".repeat(32)}`, "undelivered", "twilio_30007", T0 + 2 * MINUTE);
  assert.deepEqual([row?.key, row?.deliveryStatus, row?.deliveryCode], [sms?.key, "undelivered", "twilio_30007"]);
  assert.equal(store.recordProviderStatus("SMunknown", "delivered", null, T0), null);
  store.recordProviderStatus("cfemail:1", "delivered", null, T0 + 2 * MINUTE);
  assert.deepEqual(store.deliveryCounts(id), { sent: 2, delivered: 1, failed: 1 });
  assert.deepEqual(store.incidentEvents(id).filter((event) => event.type === "delivered" || event.type === "failed").map((event) =>
    [event.type, event.channel, event.code]), [["failed", "sms", "twilio_30007"], ["delivered", "email", null]]);
});

void test("contact health: a state change asks for a report; the same state only refreshes the code", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordReportSent([], [], T0, store.reportSeq());
  store.setContactHealth("primary_oncall", "sms", "opted_out", "twilio_21610", T0);
  assert.equal(store.reportDue(T0, Number.MAX_SAFE_INTEGER), true);
  store.recordReportSent([], [], T0 + 1, store.reportSeq());
  store.setContactHealth("primary_oncall", "sms", "opted_out", "inbound_stop", T0 + MINUTE);
  assert.equal(store.reportDue(T0 + MINUTE, Number.MAX_SAFE_INTEGER), false);
  assert.deepEqual(store.contactHealth(), [{ contactId: "primary_oncall", channel: "sms", state: "opted_out", code: "inbound_stop", since: T0 }]);
});

void test("claim lease: longer than the slowest delivery batch (25 rows, 5 at a time, 20 s each)", () => {
  // WORST_SEND_MS is the email binding's 20 s timeout (Twilio's is 15 s).
  assert.ok(CLAIM_MS > Math.ceil(CLAIM_BATCH / DELIVERY_CONCURRENCY) * WORST_SEND_MS);
});

void test("warnings: one channel, one contact, drill off, heartbeat missing in live mode", () => {
  const policy = examplePolicy();
  const base = {
    brandName: "Acme", mode: "standalone" as const, targets: fixtureTargets(), policy, maintenance: [], statusPageUrl: "https://s.example.com", twilioWebhookUrl: "https://s.example.com/hooks/twilio",
    healthKey: null, configKey: null, ackSigningKey: "a".repeat(40), twilio: null, email: null, heartbeatUrl: null, heartbeatFailUrl: null,
    dnsSecondaryResolver: null, deliveryMode: "live" as const, source: { kind: "bootstrap" as const },
  };
  assert.deepEqual(configWarnings(base), [
    "tier_single_contact:primary", "contact_single_channel:engineering_lead", "tier_single_contact:third_party", "drill_disabled", "heartbeat_missing",
  ]);
  const quiet = configWarnings({ ...base, deliveryMode: "log", policy: { ...policy, drill: { ...policy.drill, enabled: true } } });
  assert.ok(!quiet.includes("heartbeat_missing") && !quiet.includes("drill_disabled"), "log mode needs no heartbeat");
});
