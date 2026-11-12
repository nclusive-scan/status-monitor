// The status-page Worker's routing, kept free of Workers-only globals so it runs under Node in the tests. Static files
// (index.html, app.js, styles.css) never reach it: Workers Static Assets serves them, and wrangler.jsonc sends only
// /api/*, /ack/* and /hooks/* here first (plus any path that matches no file). Each route forwards to the monitor
// Worker over the MONITOR service binding with only the headers that route needs; the monitor checks every key and
// signature itself, so this Worker holds no secrets.

/** The part of a service binding this Worker uses. */
export interface MonitorBinding {
  fetch(request: Request): Promise<Response>;
}

/** The part of the Cache API /api/status uses (caches.default in the Worker; absent in tests that do not need it). */
export interface ResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface RouterDeps {
  readonly cache: ResponseCache | null;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Worker responses do not get the _headers file (it applies to static assets only), so every response here carries
 * these. The CSP is the strict one for JSON and plain text; the monitor's HTML pages (ack) set their own CSP, kept.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const MAX_BODY_BYTES = 64 * 1024;
const MONITOR_ORIGIN = "https://monitor.internal";
const MAX_ACK_PATH = 600;

type Method = "GET" | "HEAD" | "POST";

interface Route {
  readonly methods: readonly Method[];
  /** Request headers passed to the monitor; everything else (cookies, client addresses) is dropped. */
  readonly headers: readonly string[];
}

const STATUS: Route = { methods: ["GET"], headers: [] };
const PRIVATE: Route = { methods: ["GET"], headers: ["authorization"] };
// GET renders the confirm page, POST (its buttons) acts. Any path under /ack/ goes through unchanged: the monitor
// verifies the token and answers its own "link not valid" page for anything else.
const ACK: Route = { methods: ["GET", "HEAD", "POST"], headers: ["content-type"] };
// Twilio's inbound SMS webhook and its delivery status callback. The monitor validates X-Twilio-Signature against the
// exact public URL (STATUS_PAGE_URL + path), so the paths here must stay the same as the URLs configured at Twilio.
const TWILIO: Route = { methods: ["POST"], headers: ["content-type", "x-twilio-signature"] };

const EXACT: ReadonlyMap<string, Route> = new Map([
  ["/api/status", STATUS],
  ["/api/private", PRIVATE],
  ["/hooks/twilio", TWILIO],
  ["/hooks/twilio-status", TWILIO],
]);

function withHeaders(response: Response): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) result.headers.set(name, value);
  if (!result.headers.has("content-security-policy")) result.headers.set("content-security-policy", DEFAULT_CSP);
  return result;
}

function jsonError(status: number, error: string, extra: Record<string, string> = {}): Response {
  return withHeaders(new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  }));
}

function routeFor(pathname: string): Route | null {
  const exact = EXACT.get(pathname);
  if (exact !== undefined) return exact;
  if (pathname.startsWith("/ack/") && pathname.length > "/ack/".length && pathname.length <= MAX_ACK_PATH) return ACK;
  return null;
}

const isMethod = (route: Route, method: string): method is Method => route.methods.some((allowed) => allowed === method);

/**
 * Reads a POST body up to MAX_BODY_BYTES; null when it is larger. Chunk by chunk, cancelling the stream once past the
 * cap: a chunked request has no Content-Length, and these routes are anonymous here, so nothing larger is ever buffered.
 */
async function readBody(request: Request): Promise<ArrayBuffer | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = request.body?.getReader();
  if (reader === undefined) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all.buffer;
}

/**
 * Forwards to the monitor. A thrown binding call (the monitor is deploying, over its limits or missing) becomes a
 * JSON 503 that is never cached, so the page shows "unavailable" rather than an HTML error page.
 */
async function forward(request: Request, monitor: MonitorBinding, path: string, route: Route): Promise<Response> {
  const headers = new Headers();
  for (const name of route.headers) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  let body: ArrayBuffer | null = null;
  if (request.method === "POST") {
    body = await readBody(request);
    if (body === null) return jsonError(413, "payload_too_large");
  }
  try {
    const upstream = await monitor.fetch(new Request(`${MONITOR_ORIGIN}${path}`, { method: request.method, headers, body }));
    return withHeaders(upstream);
  } catch (error) {
    console.error(JSON.stringify({ event: "status_page_monitor_unreachable", path: path.startsWith("/ack/") ? "/ack/*" : path,
      code: error instanceof Error ? error.name : "unknown" }));
    return jsonError(503, "unavailable");
  }
}

/** /api/status is public: each data center answers from its edge cache for the response's max-age (15 s). */
async function publicStatus(request: Request, monitor: MonitorBinding, deps: RouterDeps): Promise<Response> {
  const key = new Request(new URL("/api/status", request.url).href, { method: "GET" });
  if (deps.cache !== null) {
    const hit = await deps.cache.match(key).catch(() => undefined);
    if (hit !== undefined) return hit;
  }
  const response = await forward(request, monitor, "/api/status", STATUS);
  if (deps.cache !== null && response.status === 200) deps.waitUntil(deps.cache.put(key, response.clone()).catch(() => undefined));
  return response;
}

/** Routes one request. The query string is never forwarded: no monitor route reads one. */
export async function handle(request: Request, monitor: MonitorBinding, deps: RouterDeps): Promise<Response> {
  const url = new URL(request.url);
  const route = routeFor(url.pathname);
  if (route === null) return jsonError(404, "not_found");
  if (!isMethod(route, request.method)) return jsonError(405, "method_not_allowed", { allow: route.methods.join(", ") });
  if (route === STATUS) return publicStatus(request, monitor, deps);
  return forward(request, monitor, url.pathname, route);
}
