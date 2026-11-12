// The status-page Worker (status-page/): its wrangler config, its routing to the monitor over the MONITOR binding, the
// static page's security headers and markup, and what the page shows (status-page/src/model.ts) for live, stale,
// unavailable and maintenance responses.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { MonitorBinding, ResponseCache, RouterDeps } from "../status-page/worker/router.ts";
import { handle, MAX_BODY_BYTES } from "../status-page/worker/router.ts";
import type { PublicStatus } from "../status-page/src/model.ts";
import { DEFAULT_SITE_NAME, isPublicStatus, siteName, summarize, UNAVAILABLE_HEADLINE, unavailable } from "../status-page/src/model.ts";
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
  const html = read("status-page/public/index.html");
  assert.doesNotMatch(html, /<script(?![^>]*src="\/app\.js")/, "no inline scripts");
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, "no external resources");
});

void test("the freshness line is outside every live region; one polite region carries the overall status", () => {
  const html = read("status-page/public/index.html");
  const live = [...html.matchAll(/<(\w+)[^>]*aria-live="polite"[^>]*>/g)];
  assert.equal(live.length, 1, "exactly one live region");
  assert.match(live[0]?.[0] ?? "", /id="announce"/);
  assert.match(html, /<p id="announce"[^>]*><\/p>/, "the live region holds nothing but the announcement");
  const banner = /<div id="overall"[^>]*>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(banner, /aria-live|role="status"/, "the banner with the freshness line is not live");
  const app = read("status-page/src/app.ts");
  assert.match(app, /if \(announced !== summary\.headline\)/, "announces only a changed headline");
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
  assert.equal(summary.headline, "Some systems are degraded");
  assert.equal(summary.freshness, "Last checked 13:59.");
  assert.deepEqual(summary.components.map((row) => [row.name, row.label]), [["SIGNUP", "Operational"], ["API", "Degraded"]]);
  assert.ok(summary.incidents !== null);
  assert.deepEqual(summary.incidents.open, [["API is degraded", "API · started 13:50 · Acknowledged, being worked on"]]);
  assert.deepEqual(summary.incidents.past, [["Signup is down", "Signup · started 10:00 · Resolved 10:30"]]);
});

void test("page model: a stale monitor shows every component Unknown, a maintenance window included", () => {
  const summary = summarize(payload({
    monitor: { lastRunAt: "2026-11-11T13:40:00.000Z", stale: true }, overall: "unknown",
    components: [component("signup", "unknown", "2026-11-11T15:00:00.000Z"), component("api", "unknown")],
  }), fmt);
  assert.equal(summary.overall, "unknown");
  assert.equal(summary.headline, "Monitoring is delayed");
  assert.match(summary.freshness, /has not reported since 13:40/);
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
    { components: "API", when: "In progress, until 15:00", active: true },
    { components: "All components", when: "02:00 to 03:00", active: false },
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
    ["SIGNUP", "unknown", "Unknown", null, null], ["API", "unknown", "Unknown", null, null],
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
  const html = read("status-page/public/index.html");
  const content = /<div id="private-content"[^>]*>([\s\S]*?)<h2 id="private-monitor-heading"[^>]*>Monitor<\/h2>/.exec(html)?.[1] ?? "";
  assert.match(content, /<p id="private-error" class="error" role="alert"><\/p>/, "an alert region inside the operator data");
  const form = /<form id="key-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(form, /private-error/);
  const app = read("status-page/src/app.ts");
  assert.match(app, new RegExp(String.raw`if \(content\.hidden !== false\) error\.textContent = [^;]+;\s*else \{\s*\/\/[^\n]*\n\s*`
    + String.raw`refreshError\.textContent = refreshFailedText\(privateLoadedAt, when\);`),
    "with data on screen, the failure goes to the visible region");
  assert.equal(refreshFailedText("2026-11-11T14:05:00.000Z", fmt), "Could not refresh. Showing data from 14:05; it may be out of date.");
  assert.match(read("scripts/build-status-page.ts"), /"operator\.js"/, "the build checks the module is emitted");
});

void test("operator view: swapping between the key form and the data hands focus over instead of dropping it to <body>", () => {
  // Focus inside the part being hidden: a submitted key (form -> data), "Forget key" or a 401 on Refresh (data -> form).
  assert.equal(focusAfterSwap("data", true), "private-monitor-heading");
  assert.equal(focusAfterSwap("form", true), "view-key");
  // A swap the user did not start (opening the view, a background reload) never moves focus.
  assert.equal(focusAfterSwap("data", false), null);
  assert.equal(focusAfterSwap("form", false), null);
  const html = read("status-page/public/index.html");
  assert.match(html, /<h2 id="private-monitor-heading" tabindex="-1">Monitor<\/h2>/, "the heading can take focus");
  assert.match(/<form id="key-form"[\s\S]*?<\/form>/.exec(html)?.[0] ?? "", /<input id="view-key"/);
  const app = read("status-page/src/app.ts");
  assert.match(app, /const target = focusAfterSwap\(shown, hidden\.hidden === false && hidden\.contains\(document\.activeElement\)\);/, "judged before hiding");
  assert.match(app, /const locked = \(\): void => \{\s*swap\("form"\);/, "every lock (no key, Forget key, 401) goes through the swap");
  assert.match(app, /refreshError\.textContent = "";\s*swap\("data"\);/, "and so does a successful load");
  assert.doesNotMatch(app, /(content|form)\.hidden = (true|false);/, "no other path toggles the parts");
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

void test("styles: the key field's edge and the selected view toggle have 3:1 contrast in both themes; the ack page's secondary button is not primary", () => {
  const css = read("status-page/public/styles.css");
  const border = /\.key-form input \{[^}]*border: 1px solid var\((--[a-z-]+)\)/.exec(css)?.[1] ?? "";
  // The pressed Status / Operator view button sits on the masthead (--surface) and fills itself with --bg.
  const pressed = /\.link\[aria-pressed="true"\] \{[^}]*border-color: var\((--[a-z-]+)\)/.exec(css)?.[1] ?? "";
  const { light, dark } = tokens(css);
  for (const [theme, values] of [["light", light], ["dark", dark]] as const) {
    for (const edge of [border, pressed]) {
      for (const against of ["--surface", "--bg"]) {
        const ratio = contrast(values.get(edge) ?? "#000000", values.get(against) ?? "#000000");
        assert.ok(ratio >= 3, `${theme} ${edge} on ${against}: ${ratio.toFixed(2)}:1`);
      }
    }
  }
  const secondary = /\.button\.secondary \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(secondary, /background: transparent/, "the escalate button (class \"button secondary\") is outlined, not solid");
  assert.match(read("worker/responses.ts"), /class="button secondary">Escalate to the next tier/);
});

void test("styles: operator facts never widen the page on a long unbreakable value; they stack on a phone", () => {
  const css = read("status-page/public/styles.css");
  assert.match(css, /\.facts \{[^}]*grid-template-columns: max-content minmax\(0, 1fr\)/, "the value column can shrink below its longest token");
  assert.match(css, /\.facts dd \{[^}]*overflow-wrap: anywhere/);
  const phone = /@media \(max-width: 40rem\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.match(phone, /\.facts \{ grid-template-columns: minmax\(0, 1fr\)/);
});

void test("page model: the site name comes from the snapshot's brand, with a neutral fallback for anything odd", () => {
  assert.equal(DEFAULT_SITE_NAME, "Status");
  assert.equal(siteName("Acme"), "Acme status");
  assert.equal(siteName("A&B Clinics"), "A&B Clinics status");
  assert.equal(siteName("Status"), "Status", "never \"Status status\"");
  for (const odd of [undefined, null, 7, "", " Acme", "Acme ", "<b>Acme</b>", "x".repeat(25), "Acme\nHealth"]) assert.equal(siteName(odd), "Status", String(odd));
  const html = read("status-page/public/index.html");
  assert.match(html, /<title>Status<\/title>/, "the static fallback is neutral");
  assert.match(html, /<p class="brand" id="brand">Status<\/p>/);
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
