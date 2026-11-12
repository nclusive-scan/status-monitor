// HTTP, DNS and deep checks against a scripted fetch: the outage class they exist for (redirect loops, TLS failures,
// Cloudflare-proxied records) and the deep-check signing contract.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { runDeepCheck } from "../worker/checks/deep.ts";
import { inCidr, isCloudflareAddress, parseIpv6, runDnsCheck } from "../worker/checks/dns.ts";
import { classifyFetchError, runHttpCheck } from "../worker/checks/http.ts";
import { runChecks } from "../worker/checks/run.ts";
import type { DeepCheckConfig, DnsCheckConfig, HttpCheckConfig } from "../worker/config.ts";
import { countingRandom, fixtureTargets, FakeClock, header, jsonResponse, scriptedFetch } from "./support/fakes.ts";

const http: HttpCheckConfig = {
  type: "http", id: "signup_http", component: "signup", url: "https://signup.example.test/", method: "GET",
  expectStatus: { min: 200, max: 200 }, maxRedirects: 5, bodyIncludes: null, latencyDegradedMs: 3000, timeoutMs: 10000,
};
const redirect = (location: string, status = 307): Response => new Response(null, { status, headers: { location } });

void test("http: the signup's 307 to /signup/home then 200 is ok, with the chain kept privately", async () => {
  const { fetch, calls } = scriptedFetch((url) => (url.endsWith("/signup/home") ? new Response("<html>") : redirect("/signup/home")));
  const result = await runHttpCheck(http, { fetch, clock: new FakeClock() });
  assert.equal(result.status, "ok");
  assert.equal(result.detail, "ok");
  assert.deepEqual(calls.map((call) => call.url), ["https://signup.example.test/", "https://signup.example.test/signup/home"]);
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.deepEqual(result.data?.["chain"], [{ url: "https://signup.example.test/", status: 307 }, {
    url: "https://signup.example.test/signup/home", status: 200 }]);
});

void test("http: a host that 308s to itself (Cloudflare Flexible SSL) is a redirect loop", async () => {
  const { fetch, calls } = scriptedFetch((url) => redirect(url, 308));
  const result = await runHttpCheck(http, { fetch, clock: new FakeClock() });
  assert.equal(result.status, "down");
  assert.equal(result.detail, "redirect_loop");
  assert.equal(calls.length, 1);
});

void test("http: a two-hop loop and an endless chain are both caught", async () => {
  const loop = scriptedFetch((url) => redirect(url.endsWith("/a") ? "/b" : "/a"));
  assert.equal((await runHttpCheck(http, { fetch: loop.fetch, clock: new FakeClock() })).detail, "redirect_loop");
  const chain = scriptedFetch((_url, _init, call) => redirect(`/hop${String(call)}`));
  assert.equal((await runHttpCheck(http, { fetch: chain.fetch, clock: new FakeClock() })).detail, "too_many_redirects");
  assert.equal(chain.calls.length, 6, "the first request plus maxRedirects hops");
  const downgrade = scriptedFetch(() => redirect("http://signup.example.test/"));
  assert.equal((await runHttpCheck(http, { fetch: downgrade.fetch, clock: new FakeClock() })).detail, "redirect_to_insecure");
});

void test("http: TLS failures are classified as tls, whether thrown or answered by Cloudflare with 525/526", async () => {
  const thrown = scriptedFetch(() => {
    throw new TypeError("fetch failed", { cause: new Error("unable to verify the first certificate") });
  });
  assert.equal((await runHttpCheck(http, { fetch: thrown.fetch, clock: new FakeClock() })).detail, "tls");
  for (const status of [525, 526]) {
    const answered = scriptedFetch(() => new Response("", { status }));
    const result = await runHttpCheck(http, { fetch: answered.fetch, clock: new FakeClock() });
    assert.deepEqual([result.status, result.detail], ["down", "tls"]);
  }
  assert.equal(classifyFetchError(new Error("SSL handshake failed")), "tls");
  assert.equal(classifyFetchError(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
  assert.equal(classifyFetchError(new Error("getaddrinfo ENOTFOUND")), "dns_error");
  assert.equal(classifyFetchError(new Error("connection reset")), "connect_error");
});

void test("http: wrong status, missing body text and slow answers", async () => {
  const wrong = scriptedFetch(() => new Response("", { status: 503 }));
  assert.equal((await runHttpCheck(http, { fetch: wrong.fetch, clock: new FakeClock() })).detail, "status_503");
  const origin = scriptedFetch(() => new Response("", { status: 522 }));
  assert.equal((await runHttpCheck(http, { fetch: origin.fetch, clock: new FakeClock() })).detail, "cloudflare_522");
  const body = scriptedFetch(() => new Response('{"ok":false}'));
  const health = { ...http, bodyIncludes: '"ok":true', maxRedirects: 0 };
  assert.equal((await runHttpCheck(health, { fetch: body.fetch, clock: new FakeClock() })).detail, "body_mismatch");
  const good = scriptedFetch(() => new Response('{"ok":true,"service":"x"}'));
  assert.equal((await runHttpCheck(health, { fetch: good.fetch, clock: new FakeClock() })).status, "ok");
  const clock = new FakeClock();
  const slow = scriptedFetch(() => {
    clock.advance(4000);
    return new Response("ok");
  });
  const result = await runHttpCheck(http, { fetch: slow.fetch, clock });
  assert.deepEqual([result.status, result.detail, result.latencyMs], ["degraded", "slow", 4000]);
});

const dns: DnsCheckConfig = { type: "dns", id: "signup_dns", component: "signup", hostname: "signup.example.test", dnsOnly: true, timeoutMs: 5000 };
const doh = (a: string[], aaaa: string[] = [], status = 0) => scriptedFetch((url) => {
  const v6 = url.endsWith("type=AAAA");
  const list = v6 ? aaaa : a;
  return jsonResponse({ Status: status, Answer: list.map((data) => ({ name: "signup.example.test", type: v6 ? 28 : 1, TTL: 300, data })) });
});

void test("dns: Cloudflare ranges, including the 104.16.0.0/13 and 172.64.0.0/13 boundaries and IPv6", () => {
  assert.equal(isCloudflareAddress("104.16.0.0"), true);
  assert.equal(isCloudflareAddress("104.23.255.255"), true);
  assert.equal(isCloudflareAddress("104.15.255.255"), false);
  assert.equal(isCloudflareAddress("172.64.10.1"), true);
  assert.equal(isCloudflareAddress("172.72.0.1"), false);
  assert.equal(isCloudflareAddress("216.150.1.193"), false, "Vercel's address today");
  assert.equal(isCloudflareAddress("2606:4700:3030::6815:1001"), true);
  assert.equal(isCloudflareAddress("2a06:98c7::1"), true, "inside 2a06:98c0::/29");
  assert.equal(isCloudflareAddress("2a06:98c8::1"), false);
  assert.equal(isCloudflareAddress("2001:db8::1"), false);
  assert.equal(parseIpv6("::1"), 1n);
  assert.equal(parseIpv6("1:2:3:4:5:6:7:8:9"), null);
  assert.equal(inCidr("10.0.0.1", "10.0.0.0/8"), true);
  assert.equal(inCidr("not-an-ip", "10.0.0.0/8"), false);
});

void test("dns: a DNS-only host on Vercel addresses is ok; the same host behind the orange cloud is down", async () => {
  const ok = await runDnsCheck(dns, { fetch: doh(["216.150.1.193", "216.150.1.65"]).fetch, clock: new FakeClock() });
  assert.deepEqual([ok.status, ok.detail], ["ok", "ok"]);
  const { fetch, calls } = doh(["104.21.32.1", "172.67.150.2"], ["2606:4700:3030::ac43:9602"]);
  const proxied = await runDnsCheck(dns, { fetch, clock: new FakeClock() });
  assert.deepEqual([proxied.status, proxied.detail], ["down", "cloudflare_proxy_address"]);
  assert.equal(header(calls[0]?.init, "accept"), "application/dns-json");
  assert.match(calls[0]?.url ?? "", /^https:\/\/cloudflare-dns\.com\/dns-query\?name=signup\.example\.test&type=A$/);
  const allowed = await runDnsCheck({ ...dns, dnsOnly: false }, { fetch: doh(["104.21.32.1"]).fetch, clock: new FakeClock() });
  assert.equal(allowed.status, "ok", "a host allowed to be proxied passes");
});

void test("dns: NXDOMAIN and empty answers are down; a failing resolver is inconclusive", async () => {
  const nx = await runDnsCheck(dns, { fetch: doh([], [], 3).fetch, clock: new FakeClock() });
  assert.deepEqual([nx.status, nx.detail], ["down", "nxdomain"]);
  const empty = await runDnsCheck(dns, { fetch: doh([]).fetch, clock: new FakeClock() });
  assert.deepEqual([empty.status, empty.detail], ["down", "no_address"]);
  const broken = await runDnsCheck(dns, { fetch: scriptedFetch(() => new Response("", { status: 502 })).fetch, clock: new FakeClock() });
  assert.deepEqual([broken.inconclusive, broken.detail], [true, "resolver_unavailable"]);
});

const KEY = "m".repeat(64);
const STAGING = "platform.example.com";
const deep: DeepCheckConfig = {
  type: "deep", id: "platform_deep", component: "platform_api", url: `https://${STAGING}/api/v2/monitor/health`,
  latencyDegradedMs: 5000, timeoutMs: 10000, componentMap: { notification_backlog: "notifications" },
};
const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1, generatedAt: "2026-11-11T14:00:00.000Z", release: { version: "1.4.2", commit: "abc1234" }, overall: "ok",
  checks: [
    { id: "database", status: "ok", latencyMs: 4, detail: "ok", value: 4 },
    { id: "notification_backlog", status: "ok", latencyMs: 6, detail: "ok", value: 0 },
  ],
  ...overrides,
});

void test("deep: the request carries the contract's headers and an HMAC over the exact signed string", async () => {
  const clock = new FakeClock();
  const { fetch, calls } = scriptedFetch(() => jsonResponse(payload()));
  const results = await runDeepCheck(deep, { fetch, clock, key: KEY, random: countingRandom() });
  const init = calls[0]?.init;
  const timestamp = header(init, "x-status-monitor-timestamp") ?? "";
  const nonce = header(init, "x-status-monitor-nonce") ?? "";
  assert.equal(timestamp, String(Math.floor(clock.now() / 1000)));
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const empty = createHash("sha256").update("").digest("hex");
  const canonical = `v2\nGET\n${STAGING}\n/api/v2/monitor/health\n${timestamp}\n${nonce}\n${empty}`;
  const expected = createHmac("sha256", Buffer.from(KEY, "utf8")).update(canonical).digest("hex");
  assert.equal(header(init, "x-status-monitor-signature"), `v2=${expected}`);
  assert.equal(init?.redirect, "manual");
  assert.deepEqual(results.map((result) => [result.checkId, result.componentId, result.status]), [
    ["platform_deep", "platform_api", "ok"], ["platform_deep.notification_backlog", "notifications", "ok"],
  ]);
});

void test("deep: mapped sub-checks land on their component and do not also fail the parent", async () => {
  const body = payload({ overall: "down", checks: [
    { id: "database", status: "ok", latencyMs: 4, detail: "ok", value: 4 },
    { id: "notification_backlog", status: "down", latencyMs: 6, detail: "backlog_over_threshold", value: 912 },
  ] });
  const results = await runDeepCheck(deep, { fetch: scriptedFetch(() => jsonResponse(body)).fetch, clock: new FakeClock(), key: KEY });
  assert.deepEqual(results.map((result) => [result.componentId, result.status, result.detail]), [
    ["platform_api", "ok", "ok"], ["notifications", "down", "backlog_over_threshold"],
  ]);
  const fetch = scriptedFetch(() => jsonResponse(body)).fetch;
  const unmapped = await runDeepCheck({ ...deep, componentMap: {} }, { fetch, clock: new FakeClock(), key: KEY });
  assert.deepEqual(unmapped.map((result) => [result.status, result.detail]), [["down", "backlog_over_threshold"]], "unmapped: overall counts");
});

void test("deep: 401/403/404 (rejected or not deployed), other statuses, bad payloads and network errors", async () => {
  const run = async (respond: () => Response): Promise<string[]> =>
    (await runDeepCheck(deep, { fetch: scriptedFetch(respond).fetch, clock: new FakeClock(), key: KEY })).map((result) => result.detail);
  assert.deepEqual(await run(() => new Response("", { status: 404 })), ["deep_rejected_or_missing"]);
  assert.deepEqual(await run(() => new Response("", { status: 401 })), ["deep_rejected_or_missing"], "a server answers an anonymous unknown path 401");
  assert.deepEqual(await run(() => new Response("", { status: 403 })), ["deep_rejected_or_missing"]);
  assert.deepEqual(await run(() => new Response("", { status: 500 })), ["status_500"]);
  assert.deepEqual(await run(() => new Response("", { status: 522 })), ["cloudflare_522"], "the http check's names for Cloudflare edge answers");
  assert.deepEqual(await run(() => new Response("", { status: 526 })), ["tls"]);
  assert.deepEqual(await run(() => {
    throw new Error("internal error; reference = abc123");
  }), ["tls_or_network"], "the Workers runtime's opaque TLS failure, named as the http check names it");
  assert.deepEqual(await run(() => new Response("", { status: 302, headers: { location: "/login" } })), ["status_302"]);
  assert.deepEqual(await run(() => jsonResponse(payload({ version: 2 }))), ["deep_invalid_payload"]);
  assert.deepEqual(await run(() => jsonResponse(payload({ checks: [{ id: "Bad Id", status: "ok", latencyMs: 1, detail: "ok", value: null }] }))),
    ["deep_invalid_payload"]);
  assert.deepEqual(await run(() => new Response("not json")), ["deep_invalid_payload"]);
  assert.deepEqual(await run(() => {
    throw new TypeError("network");
  }), ["connect_error"]);
});

void test("runChecks runs every example check and never throws", async () => {
  const targets = fixtureTargets();
  const { fetch } = scriptedFetch((url) => {
    if (url.startsWith("https://cloudflare-dns.com/")) return jsonResponse({ Status: 0, Answer: [{ type: 1, data: "216.150.1.65" }] });
    if (url.endsWith("/api/v2/monitor/health")) throw new Error("boom");
    if (url.endsWith("/api/v2/health")) return new Response('{"ok":true}');
    if (url.endsWith("/api/health")) return new Response('{"status":"ok"}');
    return new Response("<html>");
  });
  const results = await runChecks(targets, { fetch, clock: new FakeClock(), healthKey: KEY });
  assert.equal(results.length, targets.checks.length);
  assert.deepEqual(results.filter((result) => result.status !== "ok").map((result) => [result.checkId, result.detail]), [["platform_deep", "connect_error"]]);
  const noKey = await runChecks(targets, { fetch, clock: new FakeClock(), healthKey: null });
  assert.deepEqual(noKey.filter((result) => result.inconclusive).map((result) => result.detail), ["monitor_error"]);
});
