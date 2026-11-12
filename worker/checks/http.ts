// HTTP check: follows redirects by hand (so a loop such as a host 308-ing to itself is caught and named), checks the
// final status against the expected range, optionally looks for a body substring, and grades latency.
import type { HttpCheckConfig } from "../config.ts";
import type { CheckResult, Clock, FetchLike, Status } from "../types.ts";
import { USER_AGENT } from "../types.ts";

const BODY_LIMIT = 256 * 1024;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Classifies a thrown fetch error into a stable detail code. Node and undici name TLS failures in the message ("tls").
 * The Workers runtime does not: a bad certificate or failed handshake reaches the Worker only as
 * Error("internal error; reference = <id>"), with the cause in the runtime log alone (seen under wrangler 4.154.0 with
 * expired, wrong-host, self-signed and untrusted-root certificates). That opaque error is "tls_or_network", not "tls":
 * on the Workers runtime a thrown TLS failure cannot be told from other connection failures. Cloudflare's 525/526
 * answers are still "tls" (classifyStatus).
 */
const describe = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!(value instanceof Error)) return "";
  const code: unknown = Reflect.get(value, "code");
  return typeof code === "string" ? `${value.message} ${code}` : value.message;
};

export function classifyFetchError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? `${describe(error)} ${describe(error.cause)}` : describe(error);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) return "timeout";
  if (/\b(?:tls|ssl|certificate|cert|handshake|x509)\b|ERR_TLS|CERT_|SSL_/i.test(message)) return "tls";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns|resolve/i.test(message)) return "dns_error";
  if (/^internal error; reference = /i.test(error instanceof Error ? error.message : "")) return "tls_or_network";
  return "connect_error";
}

/**
 * Cloudflare answers some edge failures with its own status codes: 525 (SSL handshake failed) and 526 (invalid origin
 * certificate) are TLS failures; 520-524 and 530 are origin errors. Named separately so the private view says which.
 */
export function classifyStatus(status: number): string {
  if (status === 525 || status === 526) return "tls";
  if ((status >= 520 && status <= 524) || status === 530) return `cloudflare_${String(status)}`;
  return `status_${String(status)}`;
}

async function readLimited(response: Response): Promise<string> {
  const body: ReadableStream<Uint8Array> | null = response.body;
  const reader = body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (size >= BODY_LIMIT) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
};

export interface HttpCheckDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
}

export async function runHttpCheck(check: HttpCheckConfig, deps: HttpCheckDeps): Promise<CheckResult> {
  // Called bare, never as deps.fetch(...): the Workers fetch throws "Illegal invocation" when called as a method.
  const { fetch } = deps;
  const started = deps.clock.now();
  const chain: { url: string; status: number }[] = [];
  const result = (status: Status, detail: string, extra: Record<string, unknown> = {}): CheckResult => ({
    checkId: check.id,
    componentId: check.component,
    type: "http",
    status,
    inconclusive: false,
    latencyMs: Math.max(0, Math.round(deps.clock.now() - started)),
    detail,
    observedAt: started,
    data: { url: check.url, chain, ...extra },
  });
  const signal = AbortSignal.timeout(check.timeoutMs);
  const visited = new Set<string>();
  let url = check.url;
  try {
    for (let hop = 0; ; hop += 1) {
      if (visited.has(url)) return result("down", "redirect_loop");
      visited.add(url);
      const response = await fetch(url, {
        method: check.method,
        redirect: "manual",
        signal,
        cache: "no-store",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
      });
      chain.push({ url, status: response.status });
      if (REDIRECT.has(response.status)) {
        await discard(response);
        const location = response.headers.get("location");
        if (location === null || !URL.canParse(location, url)) return result("down", "redirect_without_location");
        if (hop >= check.maxRedirects) return result("down", "too_many_redirects");
        url = new URL(location, url).href;
        if (!url.startsWith("https://")) return result("down", "redirect_to_insecure");
        continue;
      }
      if (response.status < check.expectStatus.min || response.status > check.expectStatus.max) {
        await discard(response);
        return result("down", classifyStatus(response.status), { finalUrl: url });
      }
      if (check.bodyIncludes !== null && check.method === "GET") {
        const body = await readLimited(response);
        if (!body.includes(check.bodyIncludes)) return result("down", "body_mismatch", { finalUrl: url });
      } else await discard(response);
      const latency = deps.clock.now() - started;
      return latency > check.latencyDegradedMs ? result("degraded", "slow", { finalUrl: url }) : result("ok", "ok", { finalUrl: url });
    }
  } catch (error) {
    return result("down", classifyFetchError(error));
  }
}
