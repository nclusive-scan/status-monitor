// Signed request protocol v2: how the monitor authenticates itself to the platform it watches. One signer covers every
// request the monitor sends there: the deep check (GET /api/v2/monitor/health, HEALTH key), the config pull
// (GET /api/v2/monitor/config, CONFIG key) and the report (POST /api/v2/monitor/report, CONFIG key).
//
// Headers: X-Status-Monitor-Timestamp (unix seconds), X-Status-Monitor-Nonce (32 lowercase hex) and
// X-Status-Monitor-Signature: "v2=" + lowercase hex HMAC-SHA256 over the canonical string (UTF-8, LF separated, no
// trailing LF):
//
//   v2
//   <METHOD, uppercase>
//   <authority: lowercase host, plus ":port" only when the port is not the scheme's default>
//   <path, without the query>
//   <timestamp>
//   <nonce>
//   <lowercase hex SHA-256 of the exact body bytes; the SHA-256 of the empty string for a GET>
//
// The key is the UTF-8 bytes of the secret exactly as stored (never trimmed; config refuses a padded key). Binding the
// authority means a signature captured by one host cannot be replayed to another, and binding the body means a report
// cannot be altered in flight. The server refuses any request with a query string, so the signer refuses to sign one.
// spec/vectors/signature-v2.json holds the shared test vectors (byte-identical on the platform side).
import { hex, hmacSha256, randomHex, sha256Hex, systemRandom, utf8 } from "./crypto.ts";
import type { RandomSource } from "./crypto.ts";

export const SIGNATURE_VERSION = "v2";
export const TIMESTAMP_HEADER = "x-status-monitor-timestamp";
export const NONCE_HEADER = "x-status-monitor-nonce";
export const SIGNATURE_HEADER = "x-status-monitor-signature";

export interface CanonicalParts {
  readonly method: string;
  readonly authority: string;
  readonly path: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly bodySha256: string;
}

export const canonicalString = (parts: CanonicalParts): string =>
  [SIGNATURE_VERSION, parts.method.toUpperCase(), parts.authority, parts.path, String(parts.timestamp), parts.nonce, parts.bodySha256].join("\n");

/**
 * The authority and path a URL is signed with, or null when it cannot be signed: not https, credentials, a query
 * string (the server refuses any "?") or a fragment. URL.host is already lowercase and omits the default port.
 */
export function signedTarget(url: string): { readonly authority: string; readonly path: string } | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  if (url.includes("?") || url.includes("#")) return null;
  return { authority: parsed.host, path: parsed.pathname };
}

export interface SignInput {
  readonly method: "GET" | "POST";
  readonly url: string;
  /** The exact body that will be sent; "" for a GET. */
  readonly body: string;
}

/** Signs one request. Throws SIGNATURE_TARGET_INVALID for a URL that cannot be signed (config validation prevents it). */
export async function signRequest(key: string, input: SignInput, nowMs: number, random: RandomSource = systemRandom): Promise<Record<string, string>> {
  const target = signedTarget(input.url);
  if (target === null) throw new Error("SIGNATURE_TARGET_INVALID");
  const timestamp = Math.floor(nowMs / 1000);
  const nonce = randomHex(random, 16);
  const canonical = canonicalString({ method: input.method, ...target, timestamp, nonce, bodySha256: await sha256Hex(utf8(input.body)) });
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: `${SIGNATURE_VERSION}=${hex(await hmacSha256(key, canonical))}`,
  };
}
