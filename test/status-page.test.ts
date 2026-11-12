// The status-page Worker (status-page/): its wrangler config, its routing to the monitor over the MONITOR binding, the
// static page's security headers and markup, and what the page shows (status-page/src/model.ts) for live, stale,
// unavailable and maintenance responses.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { MonitorBinding, ResponseCache, RouterDeps } from "../status-page/worker/router.ts";
import { handle, MAX_BODY_BYTES } from "../status-page/worker/router.ts";
import type { PublicStatus } from "../status-page/src/model.ts";
import { band, checkName, dayViews, DEFAULT_SITE_NAME, duration, isPublicStatus, siteName, summarize, UNAVAILABLE_HEADLINE, unavailable } from "../status-page/src/model.ts";
import { focusAfterSwap, monitorFacts, refreshFailedText, warningText } from "../status-page/src/operator.ts";
import { ADOPTED_STATUS_HOST, adoptedMonitorWrangler, adoptedStatusPageWrangler } from "./support/adopted.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Strips // line comments outside strings, enough for the committed .jsonc files. */
const jsonc = (source: string): unknown => JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
const ORIGIN = "https://status.example.test";

interface Seen { url: string; method: string; headers: Record<string, string>; body: string }

function fakeMonitor(respond: (seen: Seen) => Response = () => new Response("{}", { headers: { "content-type": "application/json" } })): MonitorBinding & {
  calls: Seen[];
} {
  const calls: Seen[] = [];
  return {
    calls,
    async fetch(request: Request): Promise<Response> {
      const seen = { url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() };
      calls.push(seen);
      return respond(seen);
    },
  };
}

const noCache: RouterDeps = { cache: null, waitUntil: () => undefined };

/** The status page wrangler config's invariants; the custom domain is the adopter's (README "Quick start" step 7). */
function assertStatusPageWrangler(source: string, monitorSource: string): void {
  const config = jsonc(source);
  assert.ok(typeof config === "object" && config !== null);
  const get = (key: string): unknown => Reflect.get(config, key);
  assert.equal(get("name"), "status-page");
  assert.equal(get("main"), "worker/index.ts");
  assert.equal(get("workers_dev"), false);
  assert.equal(get("preview_urls"), false);
  // The custom domain is the adopter's: shipped as a commented example, and once set it is the STATUS_PAGE_URL host.
  const monitorConfig: unknown = jsonc(monitorSource);
  const monitorVars: unknown = typeof monitorConfig === "object" && monitorConfig !== null ? Reflect.get(monitorConfig, "vars") : null;
  const statusPageUrl: unknown = typeof monitorVars === "object" && monitorVars !== null ? Reflect.get(monitorVars, "STATUS_PAGE_URL") : null;
  assert.ok(typeof statusPageUrl === "string");
  const routes = get("routes");
  assert.ok(Array.isArray(routes), "routes is a list");
  if (routes.length === 0) {
    assert.match(source, /^\s*\/\/ "routes": \[\{ "pattern": "[^"]+", "custom_domain": true \}\],$/m, "a commented custom domain example");
  } else {
    assert.deepEqual(routes, [{ pattern: new URL(statusPageUrl).hostname, custom_domain: true }], "the custom domain is STATUS_PAGE_URL's host");
  }
  const monitorName: unknown = typeof monitorConfig === "object" && monitorConfig !== null ? Reflect.get(monitorConfig, "name") : null;
  assert.equal(monitorName, "status-monitor");
  assert.deepEqual(get("services"), [{ binding: "MONITOR", service: monitorName }], "the binding names the monitor Worker");
  assert.equal(get("pages_build_output_dir"), undefined);
  const assets = get("assets");
  assert.ok(typeof assets === "object" && assets !== null);
  assert.equal(Reflect.get(assets, "directory"), "./dist");
  assert.deepEqual(Reflect.get(assets, "run_worker_first"), ["/api/*", "/ack/*", "/hooks/*"]);
  assert.equal(Reflect.get(assets, "binding"), undefined, "the Worker never reads assets itself");
  assert.equal(existsSync(new URL("../pages", import.meta.url)), false, "the Pages project is gone");
  // The monitor stays without a public surface.
  const monitor = jsonc(monitorSource);
  assert.ok(typeof monitor === "object" && monitor !== null);
  assert.equal(Reflect.get(monitor, "workers_dev"), false);
  assert.equal(Reflect.get(monitor, "preview_urls"), false);
  assert.deepEqual(Reflect.get(monitor, "routes"), []);
}

void test("status page wrangler config: a Worker with static assets, no workers.dev or preview URL, MONITOR bound, a custom domain example", () => {
  assertStatusPageWrangler(read("status-page/wrangler.jsonc"), read("wrangler.jsonc"));
});

void test("status page wrangler config check holds after an adopter turns on their custom domain", () => {
  const source = adoptedStatusPageWrangler(read("status-page/wrangler.jsonc"));
  const monitorSource = adoptedMonitorWrangler(read("wrangler.jsonc"));
  const config = jsonc(source);
  assert.deepEqual(typeof config === "object" && config !== null ? Reflect.get(config, "routes") : null,
    [{ pattern: ADOPTED_STATUS_HOST, custom_domain: true }], "the custom domain is on");
  assertStatusPageWrangler(source, monitorSource);
  // A custom domain that is not the STATUS_PAGE_URL host is still caught.
  assert.throws(() => {
    assertStatusPageWrangler(adoptedStatusPageWrangler(source, "www.adopter.test"), monitorSource);
  }, { message: /the custom domain is STATUS_PAGE_URL's host/ });
});

void test("static headers set a strict CSP, and the page loads nothing inline or external", () => {
  const headers = read("status-page/public/_headers");
  assert.match(headers, /Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';/);
  assert.match(headers, /frame-ancestors 'none'/);
  const html = read("status-page/index.html");
  assert.doesNotMatch(html, /<script(?![^>]*src="\/src\/main\.tsx")/, "one module script, no inline scripts");
  assert.doesNotMatch(html, /\sstyle="|<style[\s>]/, "no inline styles (the CSP refuses them)");
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, "no external resources");
  const build = read("scripts/build-status-page.ts");
  assert.match(build, /STATUS_PAGE_INLINE_CODE/, "the build refuses a page with inline script or style");
  assert.match(read("status-page/vite.config.ts"), /assetsInlineLimit: 0/, "no assets inlined as data: URLs");
});

void test("the freshness line is outside every live region; one polite region carries the overall status", () => {
  const view = read("status-page/src/PublicView.tsx");
  const own = ["App.tsx", "PublicView.tsx", "OperatorView.tsx"].map((file) => read(`status-page/src/${file}`)).join("\n");
  assert.equal([...own.matchAll(/aria-live=/g)].length, 1, "exactly one live region in the page's own code");
  assert.match(view, /<p id="announce" role="status" aria-live="polite" aria-atomic="true" className="sr-only">\{announced\}<\/p>/);
  assert.match(view, /useEffect\(\(\) => \{\s*setAnnounced\(headline\);\s*\}, \[headline\]\);/, "announces only a changed headline");
  const banner = /function Banner\([\s\S]*?\n\}/.exec(view)?.[0] ?? "";
  assert.ok(banner.includes("Updated <Time"), "the banner holds the ticking \"Updated …\" time");
  assert.doesNotMatch(banner, /aria-live|role="status"/, "and it is not live");
});

void test("router: each route reaches the monitor at the same path with only its own headers", async () => {
  const monitor = fakeMonitor();
  const common = { cookie: "session=x", "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9" };
  await handle(new Request(`${ORIGIN}/api/status?cb=1`, { headers: { ...common, authorization: "Bearer leak" } }), monitor, noCache);
  await handle(new Request(`${ORIGIN}/api/private`, { headers: { ...common, authorization: "Bearer k" } }), monitor, noCache);
  await handle(new Request(`${ORIGIN}/ack/abc.DEF-1_2`, { headers: common }), monitor, noCache);
  await handle(new Request(`${ORIGIN}/ack/abc.DEF-1_2`, {
    method: "POST", headers: { ...common, "content-type": "application/x-www-form-urlencoded" }, body: "action=ack",
  }), monitor, noCache);
  for (const path of ["/hooks/twilio", "/hooks/twilio-status"]) {
    await handle(new Request(`${ORIGIN}${path}`, {
      method: "POST", headers: { ...common, "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "sig=" }, body: "MessageSid=SM1",
    }), monitor, noCache);
  }
  assert.deepEqual(monitor.calls.map((call) => [call.method, call.url, call.headers, call.body]), [
    ["GET", "https://monitor.internal/api/status", {}, ""],
    ["GET", "https://monitor.internal/api/private", { authorization: "Bearer k" }, ""],
    ["GET", "https://monitor.internal/ack/abc.DEF-1_2", {}, ""],
    ["POST", "https://monitor.internal/ack/abc.DEF-1_2", { "content-type": "application/x-www-form-urlencoded" }, "action=ack"],
    ["POST", "https://monitor.internal/hooks/twilio", { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "sig=" }, "MessageSid=SM1"],
    [
      "POST", "https://monitor.internal/hooks/twilio-status", { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "sig=" },
      "MessageSid=SM1",
    ],
  ]);
});

void test("router: unknown paths and wrong methods never reach the monitor", async () => {
  const monitor = fakeMonitor();
  const cases: [string, string, number][] = [
    ["GET", "/api/other", 404], ["GET", "/hooks/other", 404], ["GET", "/ack/", 404], ["GET", "/nothing-here", 404],
    ["GET", "/hooks/twilio", 405], ["GET", "/hooks/twilio-status", 405], ["POST", "/api/status", 405], ["DELETE", "/api/private", 405],
    ["GET", `/ack/${"a".repeat(700)}`, 404],
  ];
  for (const [method, path, status] of cases) {
    const response = await handle(new Request(`${ORIGIN}${path}`, { method }), monitor, noCache);
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  }
  assert.equal(monitor.calls.length, 0);
});

void test("a thrown binding call becomes a JSON 503 with no-store, on every route, and is never cached", async () => {
  const monitor: MonitorBinding = { fetch: () => Promise.reject(new Error("binding down")) };
  const puts: string[] = [];
  const cache: ResponseCache = { match: () => Promise.resolve(undefined), put: (request) => { puts.push(request.url); return Promise.resolve(); } };
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(...args); };
  try {
    const routes = [["GET", "/api/status"], ["GET", "/api/private"], ["GET", "/ack/x"], ["POST", "/hooks/twilio"], ["POST", "/hooks/twilio-status"]] as const;
    for (const [method, path] of routes) {
      const response = await handle(new Request(`${ORIGIN}${path}`, { method, ...(method === "POST" ? { body: "a=b" } : {}) }), monitor, {
        cache, waitUntil: () => undefined,
      });
      assert.equal(response.status, 503, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "unavailable" });
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(puts, []);
  assert.ok(errors.every((line) => typeof line === "string" && !line.includes("binding down")), "logs the error name, not its message");
});

void test("router: bodies over 64 KiB are refused before the monitor sees them", async () => {
  const monitor = fakeMonitor();
  const big = "a".repeat(MAX_BODY_BYTES + 1);
  const response = await handle(new Request(`${ORIGIN}/hooks/twilio`, { method: "POST", body: big }), monitor, noCache);
  assert.equal(response.status, 413);
  const declared = await handle(new Request(`${ORIGIN}/hooks/twilio-status`, {
    method: "POST", body: "a=b", headers: { "content-length": String(MAX_BODY_BYTES + 1) },
  }), monitor, noCache);
  assert.equal(declared.status, 413);
  assert.equal(monitor.calls.length, 0);
  const exact = await handle(new Request(`${ORIGIN}/hooks/twilio`, { method: "POST", body: "é".repeat(MAX_BODY_BYTES / 2) }), monitor, noCache);
  assert.equal(exact.status, 200, "64 KiB exactly (in bytes) passes");
});

void test("router: a chunked body with no Content-Length is cut off past 64 KiB, never buffered whole", async () => {
  const monitor = fakeMonitor();
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(97);
  let left = 320; // 20 MiB
  const body = new ReadableStream<Uint8Array>({
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
  // A streamed request body needs duplex "half" (Fetch standard); it has no Content-Length.
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
  const request = new Request(`${ORIGIN}/hooks/twilio`, init);
  assert.equal(request.headers.get("content-length"), null);
  const response = await handle(request, monitor, noCache);
  assert.equal(response.status, 413);
  assert.equal(monitor.calls.length, 0);
  assert.ok(pulled <= 4 * chunk.byteLength, `pulled ${String(pulled)} bytes of 20 MiB`);
});

void test("router: security headers on every forwarded response; the monitor's own CSP on its HTML pages is kept", async () => {
  const pageCsp = "default-src 'none'; style-src 'self'";
  const monitor = fakeMonitor((seen) => seen.url.includes("/ack/")
    ? new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html", "content-security-policy": pageCsp } })
    : new Response("{}", { headers: { "content-type": "application/json", "cache-control": "public, max-age=15" } }));
  const ack = await handle(new Request(`${ORIGIN}/ack/bad`), monitor, noCache);
  assert.equal(ack.status, 404, "the monitor's status passes through");
  assert.equal(ack.headers.get("content-security-policy"), pageCsp);
  const status = await handle(new Request(`${ORIGIN}/api/status`), monitor, noCache);
  assert.equal(status.headers.get("cache-control"), "public, max-age=15");
  for (const response of [ack, status]) {
    assert.equal(response.headers.get("strict-transport-security"), "max-age=63072000; includeSubDomains");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.ok(response.headers.get("content-security-policy") !== null);
  }
});

void test("router: /api/status answers from the edge cache when it can and stores only a 200", async () => {
  const store = new Map<string, Response>();
  const waits: Promise<unknown>[] = [];
  const cache: ResponseCache = {
    match: (request) => Promise.resolve(store.get(request.url)?.clone()),
    put: (request, response) => { store.set(request.url, response); return Promise.resolve(); },
  };
  const deps: RouterDeps = { cache, waitUntil: (promise) => { waits.push(promise); } };
  let status = 500;
  const monitor = fakeMonitor(() => new Response(JSON.stringify({ n: status }), { status }));
  assert.equal((await handle(new Request(`${ORIGIN}/api/status`), monitor, deps)).status, 500);
  await Promise.all(waits);
  assert.equal(store.size, 0, "an error is not cached");
  status = 200;
  assert.equal((await handle(new Request(`${ORIGIN}/api/status?x=1`), monitor, deps)).status, 200);
  await Promise.all(waits);
  assert.deepEqual([...store.keys()], [`${ORIGIN}/api/status`], "one key whatever the query");
  status = 503;
  const hit = await handle(new Request(`${ORIGIN}/api/status`), monitor, deps);
  assert.deepEqual(await hit.json(), { n: 200 });
  assert.equal(monitor.calls.length, 2, "the hit never reached the monitor");
});

// ---- What the page shows ----

const fmt = (iso: string | null): string => (iso === null ? "—" : iso.slice(11, 16));
const component = (id: string, status: "ok" | "degraded" | "down" | "unknown", maintenanceUntil: string | null = null) => ({
  id, name: id.toUpperCase(), status, since: null, uptime: { h24: 100, d7: 99.5, d30: null }, maintenanceUntil,
});
function payload(overrides: Partial<PublicStatus> = {}): PublicStatus {
  return {
    overall: "ok", generatedAt: "2026-11-11T14:00:00.000Z", monitor: { lastRunAt: "2026-11-11T13:59:00.000Z", stale: false },
    components: [component("signup", "ok"), component("api", "ok")], maintenance: [], incidents: [], ...overrides,
  };
}

void test("page model: live status, worst component wins, incidents split into open and past", () => {
  const summary = summarize(payload({
    components: [component("signup", "ok"), component("api", "degraded")],
    incidents: [
      { id: "i1", component: "API", title: "API is degraded", startedAt: "2026-11-11T13:50:00.000Z", acknowledged: true, resolved: false, resolvedAt: null },
      {
        id: "i0", component: "Signup", title: "Signup is down", startedAt: "2026-11-10T10:00:00.000Z", acknowledged: false, resolved: true,
        resolvedAt: "2026-11-10T10:30:00.000Z",
      },
    ],
  }), fmt);
  assert.equal(summary.overall, "degraded");
  assert.equal(summary.headline, "Some services are having problems");
  assert.equal(summary.freshness, "Updated 13:59.");
  assert.deepEqual(summary.components.map((row) => [row.name, row.label]), [["SIGNUP", "Operational"], ["API", "Partial outage"]]);
  assert.ok(summary.incidents !== null);
  assert.deepEqual(summary.incidents.open, [["API is degraded", "API · started 13:50 · Being fixed"]]);
  assert.deepEqual(summary.incidents.past, [["Signup is down", "Signup · started 10:00 · Resolved 10:30"]]);
});

void test("page model: a stale monitor shows every component Unknown, a maintenance window included", () => {
  const summary = summarize(payload({
    monitor: { lastRunAt: "2026-11-11T13:40:00.000Z", stale: true }, overall: "unknown",
    components: [component("signup", "unknown", "2026-11-11T15:00:00.000Z"), component("api", "unknown")],
  }), fmt);
  assert.equal(summary.overall, "unknown");
  assert.equal(summary.headline, "We can't confirm status right now");
  assert.equal(summary.freshness, "Last confirmed 13:40.");
  assert.deepEqual(summary.components.map((row) => [row.shown, row.note]), [["unknown", null], ["unknown", null]]);
});

void test("page model: maintenance shows Maintenance with the window end, and does not turn the headline red", () => {
  const until = "2026-11-11T15:00:00.000Z";
  const later = { components: "all" as const, startsAt: "2026-11-12T02:00:00.000Z", endsAt: "2026-11-12T03:00:00.000Z", active: false };
  const windows = [{ components: ["api"], startsAt: "2026-11-11T13:00:00.000Z", endsAt: until, active: true }, later];
  const summary = summarize(payload({ overall: "down", components: [component("signup", "ok"), component("api", "down", until)], maintenance: windows }), fmt);
  assert.equal(summary.overall, "maintenance", "the failing component is under maintenance; the rest is fine");
  assert.equal(summary.headline, "Scheduled maintenance in progress");
  assert.deepEqual(summary.components.map((row) => [row.label, row.note]), [["Operational", null], ["Maintenance", "until 15:00"]]);
  assert.deepEqual(summary.maintenance, [
    { components: "API", when: "Until 15:00", active: true, startsAt: "2026-11-11T13:00:00.000Z", endsAt: until },
    { components: "All services", when: "02:00 to 03:00", active: false, startsAt: later.startsAt, endsAt: later.endsAt },
  ]);
  const outage = summarize(payload({ components: [component("signup", "down"), component("api", "ok", until)], maintenance: windows }), fmt);
  assert.equal(outage.overall, "down", "a real outage elsewhere still shows");
  const upcoming = summarize(payload({ maintenance: [later] }), fmt);
  assert.equal(upcoming.overall, "ok", "a window that has not started changes nothing");
});

void test("page model: on a failed load the pills reset to Unknown and the lists are unavailable, not empty", () => {
  const good = summarize(payload({ components: [component("signup", "ok", "2026-11-11T15:00:00.000Z"), component("api", "ok")] }), fmt);
  const failed = unavailable(good);
  assert.equal(failed.overall, "unknown");
  assert.equal(failed.headline, UNAVAILABLE_HEADLINE);
  assert.deepEqual(failed.components.map((row) => [row.name, row.shown, row.label, row.note, row.uptime.h24]), [
    ["SIGNUP", "unknown", "Status unavailable", null, null], ["API", "unknown", "Status unavailable", null, null],
  ]);
  assert.equal(failed.incidents, null);
  assert.deepEqual(failed.maintenance, []);
  assert.deepEqual(unavailable(null).components, [], "nothing loaded yet: no rows to keep");
  assert.equal(isPublicStatus({ error: "unavailable" }), false, "the 503 body is not a status");
  assert.equal(isPublicStatus(payload()), true);
});


void test("operator view: Twilio signature rejections are shown, and every delivery warning reads as plain language", () => {
  const facts = new Map(monitorFacts({ twilioSignatureRejected: { count: 3, lastAt: "2026-11-11T14:05:00.000Z" } }, fmt));
  assert.equal(facts.get("Twilio signature rejections"), "3 refused, last 14:05");
  assert.equal(new Map(monitorFacts({ twilioSignatureRejected: { count: 0, lastAt: null } }, fmt)).get("Twilio signature rejections"), "none");
  for (const warning of ["email_channel_failing:account_suspended", "sms_channel_failing:twilio_30034", "sms_delivery_unknown", "heartbeat_missing",
    "contact_single_channel:primary_oncall", "tier_single_contact:primary", "drill_disabled", "dns_inconclusive", "incidents_pruned_unexported"]) {
    assert.notEqual(warningText(warning), warning, `${warning} has plain wording`);
  }
  assert.match(warningText("email_channel_failing:account_suspended"), /Alert email is failing for every contact \(account_suspended\)/);
  assert.match(warningText("sms_channel_failing:twilio_30034"), /Alert texts are failing for every contact \(twilio_30034\)/);
});

void test("operator view: a failed refresh says so inside the data (visible and announced), not in the hidden key form", () => {
  const view = read("status-page/src/OperatorView.tsx");
  const content = /<div ref=\{contentRef\} id="private-content"[\s\S]*?<Tabs/.exec(view)?.[0] ?? "";
  assert.match(content, /<p id="private-error" role="alert"/, "an alert region inside the operator data");
  const form = /<form[\s\S]*?<\/form>/.exec(view)?.[0] ?? "";
  assert.doesNotMatch(form, /private-error/);
  assert.match(view, /if \(loadedAt\.current === null\) \{[\s\S]*?\} else \{\s*\/\/[^\n]*\n\s*setRefreshError\(refreshFailedText\(loadedAt\.current, when\)\);/,
    "with data on screen, the failure goes to the visible region");
  assert.equal(refreshFailedText("2026-11-11T14:05:00.000Z", fmt), "Could not refresh. Showing data from 14:05; it may be out of date.");
  assert.match(read("status-page/src/App.tsx"), /lazy\(async \(\) => \(\{ default: \(await import\("\.\/OperatorView\.tsx"\)\)\.OperatorView \}\)\)/,
    "the operator view is its own chunk, loaded when opened");
});

void test("operator view: swapping between the key form and the data hands focus over instead of dropping it to <body>", () => {
  // Focus inside the part being hidden: a submitted key (form -> data), "Forget key" or a 401 on Refresh (data -> form).
  assert.equal(focusAfterSwap("data", true), "private-monitor-heading");
  assert.equal(focusAfterSwap("form", true), "view-key");
  // A swap the user did not start (opening the view, a background reload) never moves focus.
  assert.equal(focusAfterSwap("data", false), null);
  assert.equal(focusAfterSwap("form", false), null);
  const view = read("status-page/src/OperatorView.tsx");
  assert.match(view, /<h1 id="private-monitor-heading" tabIndex=\{-1\}/, "the heading can take focus");
  assert.match(/<form[\s\S]*?<\/form>/.exec(view)?.[0] ?? "", /id="view-key"/);
  assert.match(view, /pendingFocus\.current = focusAfterSwap\(next, hidden !== null && hidden\.contains\(document\.activeElement\)\);/, "judged before hiding");
  assert.match(view, /const locked = \(\): void => \{\s*swap\("form"\);/, "every lock (no key, Forget key, 401) goes through the swap");
  assert.match(view, /setRefreshError\(""\);\s*swap\("data"\);/, "and so does a successful load");
  assert.equal([...view.matchAll(/setShown\(/g)].length, 1, "no other path switches the parts");
});

/** The light and dark values of the page's colour tokens. */
function tokens(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const block = (source: string): Map<string, string> =>
    new Map([...source.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6})/g)].map((match) => [match[1] ?? "", match[2] ?? ""]));
  const light = block(/:root \{([^}]*)\}/.exec(css)?.[1] ?? "");
  const dark = block(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(css)?.[1] ?? "");
  return { light, dark };
}
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r = 0, g = 0, bl = 0] = [1, 3, 5].map((index) => {
      const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

void test("styles: the acknowledge page's escalate button is outlined, not the silver primary, with a 3:1 edge in both themes", () => {
  const css = read("status-page/public/styles.css");
  const secondary = /\.button\.secondary \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(secondary, /background: transparent/, "the escalate button (class \"button secondary\") is outlined, not solid");
  assert.match(read("worker/responses.ts"), /class="button secondary">Escalate to the next tier/);
  const { light, dark } = tokens(css);
  for (const [theme, values] of [["light", light], ["dark", dark]] as const) {
    const ratio = contrast(values.get("--border-strong") ?? "#000000", values.get("--inset") ?? "#000000");
    assert.ok(ratio >= 3, `${theme} button edge on the card: ${ratio.toFixed(2)}:1`);
  }
});

void test("styles: operator facts never widen the page on a long unbreakable value; they stack on a phone", () => {
  const view = read("status-page/src/OperatorView.tsx");
  assert.match(view, /sm:grid-cols-\[12rem_minmax\(0,1fr\)\]/, "label and value side by side from sm, the value column can shrink");
  assert.match(view, /<dd className="\[overflow-wrap:anywhere\]">\{value\}<\/dd>/);
});

void test("page model: the site name comes from the snapshot's brand, with a neutral fallback for anything odd", () => {
  assert.equal(DEFAULT_SITE_NAME, "Status");
  assert.equal(siteName("Acme"), "Acme status");
  assert.equal(siteName("A&B Clinics"), "A&B Clinics status");
  assert.equal(siteName("Status"), "Status", "never \"Status status\"");
  for (const odd of [undefined, null, 7, "", " Acme", "Acme ", "<b>Acme</b>", "x".repeat(25), "Acme\nHealth"]) assert.equal(siteName(odd), "Status", String(odd));
  assert.match(read("status-page/index.html"), /<title>Status<\/title>/, "the static fallback is neutral");
  assert.match(read("status-page/src/App.tsx"), /useState<[^>]+>\(\{ summary: null, brand: "Status" \}\)/, "and so is the masthead");
});

void test("operator view: standalone names its source and leaves out the platform pull and report", () => {
  const fmt = (iso: string | null): string => iso ?? "never";
  const standalone = new Map(monitorFacts({ config: { mode: "standalone", source: "bootstrap" } }, fmt));
  assert.equal(standalone.get("Config source"), "Standalone (Worker settings; no platform)");
  assert.equal(standalone.has("Last config fetch"), false);
  assert.equal(standalone.has("Report to the platform"), false);
  const platform = new Map(monitorFacts({ config: { mode: "platform", source: "platform", revision: 7 } }, fmt));
  assert.equal(platform.get("Config source"), "Platform revision 7");
  assert.equal(platform.has("Report to the platform"), true);
});

void test("page model: a day is operational from 99.95 %, degraded from 99 %, an outage below, and blank with no runs", () => {
  assert.deepEqual([band(100), band(99.95), band(99.949), band(99), band(98.99), band(null)], ["ok", "ok", "degraded", "degraded", "down", "none"]);
});

void test("page model: the uptime bars are always 30 UTC days ending today, filled from whatever history arrived", () => {
  const days = dayViews([{ date: "2026-11-12", uptime: 99.5 }, { date: "2026-10-01", uptime: 1 }], "2026-11-12T15:00:00.000Z");
  assert.equal(days.length, 30);
  assert.equal(days[0]?.date, "2026-10-14");
  assert.deepEqual(days.at(-1), { date: "2026-11-12", uptime: 99.5, band: "degraded" });
  assert.equal(days.filter((day) => day.band === "none").length, 29, "a date outside the window is ignored");
  assert.equal(dayViews(undefined, "2026-11-12T15:00:00.000Z").length, 30, "an older monitor without history still gets 30 blank days");
});

void test("page model: incident durations read as people say them", () => {
  assert.deepEqual([duration(45_000), duration(14 * 60_000), duration(125 * 60_000), duration(120 * 60_000), duration(76 * 3600_000)],
    ["45 s", "14 min", "2 h 5 min", "2 h", "3 d 4 h"]);
});

void test("page model: headline numbers average the public components and count the last 30 days' incidents", () => {
  const fmt = (iso: string | null): string => iso ?? "—";
  const hour = (h: number, ms: number | null) => ({ hour: `2026-11-12T${String(h).padStart(2, "0")}:00:00.000Z`, avgMs: ms, maxMs: ms });
  const summary = summarize({
    overall: "ok", generatedAt: "2026-11-12T15:00:00.000Z", monitor: { lastRunAt: "2026-11-12T14:59:00.000Z", stale: false },
    components: [
      { id: "a", name: "A", status: "ok", since: null, uptime: { h24: 100, d7: 100, d30: 99.9 }, latency: [hour(13, 100), hour(14, 300)] },
      { id: "b", name: "B", status: "degraded", since: null, uptime: { h24: 99, d7: 99, d30: 99.5 }, latency: [hour(13, null), hour(14, 200)] },
    ],
    incidents: [
      { id: "1", component: "A", title: "A is down", startedAt: "2026-11-10T10:00:00.000Z", acknowledged: true, resolved: true, resolvedAt: "2026-11-10T10:31:00.000Z" },
      { id: "2", component: "B", title: "B is down", startedAt: "2026-09-01T10:00:00.000Z", acknowledged: true, resolved: true, resolvedAt: "2026-09-01T11:00:00.000Z" },
    ],
  }, fmt);
  const stats = summary.stats;
  assert.ok(stats);
  assert.equal(stats.uptime30, 99.7);
  assert.equal(stats.latency24, 200, "the mean of the hours that were measured");
  assert.equal(stats.incidents30, 1, "an incident from September is outside the window");
  assert.deepEqual([stats.operational, stats.total], [1, 2]);
  assert.equal(summary.components[1]?.latencyNow, 200);
  assert.equal(summary.timeline?.past[0]?.detail, "Resolved 2026-11-10T10:31:00.000Z · 31 min");
});

void test("page model: checks are named for people, and the affected list names each failing operation, worst first", () => {
  assert.deepEqual(["notification_backlog_age", "staging_deep.publications", "api_http", "web-dns"].map(checkName),
    ["Notification backlog age", "Publications", "API HTTP", "Web DNS"]);
  const at = "2026-11-12T20:46:35.000Z";
  const data: PublicStatus = {
    overall: "down", generatedAt: at, monitor: { lastRunAt: at, stale: false, staleAfterSeconds: 300, rules: { openAfterFailures: 2, resolveAfterPasses: 3 } },
    incidents: [],
    components: [
      { id: "web", name: "Web app", status: "down", since: at, uptime: { h24: 90, d7: 99, d30: 99.5 }, lastCheckedAt: at, checks: [
        { id: "web_http", kind: "http", status: "ok", latencyMs: 58, checkedAt: at },
        { id: "deep", kind: "deep", status: "down", latencyMs: 51, checkedAt: at },
        { id: "deep.database", kind: "part", status: "ok", latencyMs: 2, checkedAt: at },
        { id: "deep.migrations", kind: "part", status: "degraded", latencyMs: 3, checkedAt: at },
        { id: "deep.publications", kind: "part", status: "down", latencyMs: 2, checkedAt: at },
      ] },
      { id: "reader", name: "Reader", status: "ok", since: at, uptime: { h24: 100, d7: 100, d30: 100 }, lastCheckedAt: at,
        checks: [{ id: "reader_http", kind: "http", status: "ok", latencyMs: 40, checkedAt: at }] },
    ],
  };
  const summary = summarize(data, fmt);
  assert.deepEqual(summary.rules, { openAfterFailures: 2, resolveAfterPasses: 3 });
  assert.equal(summary.lastRunAt, at);
  const web = summary.components[0];
  assert.deepEqual(web?.checks.map((check) => [check.name, check.kindLabel, check.shown]), [
    ["Web HTTP", "HTTP request", "ok"], ["Deep health check", "Signed health check", "down"],
    ["Database", "Platform check", "ok"], ["Migrations", "Platform check", "degraded"], ["Publications", "Platform check", "down"],
  ]);
  assert.equal(web.lastCheckedAt, at);
  assert.deepEqual(summary.attention.map(({ component, check }) => [component, check.name, check.shown]),
    [["Web app", "Publications", "down"], ["Web app", "Migrations", "degraded"]], "the deep check itself is not repeated: its parts say what is wrong");

  const stale = summarize({ ...data, monitor: { ...data.monitor, stale: true } }, fmt);
  assert.ok(stale.components.flatMap((component) => component.checks).every((check) => check.shown === "unknown"), "a stale monitor vouches for no check");
  assert.deepEqual(stale.attention, []);
  const failed = unavailable(summary);
  assert.ok(failed.components.flatMap((component) => component.checks).every((check) => check.shown === "unknown" && check.latencyMs === null));
  assert.deepEqual(failed.attention, []);

  const withoutChecks = data.components.map(({ id, name, status, since, uptime }) => ({ id, name, status, since, uptime }));
  const older = summarize({ ...data, monitor: { lastRunAt: at, stale: false }, components: withoutChecks }, fmt);
  assert.deepEqual([older.rules, older.staleAfterSeconds, older.components[0]?.checks, older.components[0]?.lastCheckedAt], [null, 300, [], null],
    "an older monitor without checks still renders");
});
