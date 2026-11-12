// Acknowledgement links. A token names one incident and one contact, expires, and is HMAC-SHA256 signed with
// ACK_SIGNING_KEY: "<base64url(JSON claims)>.<base64url(tag)>". GET on the link only renders a confirm page; the
// acknowledgement is the POST from its button, so mail scanners that prefetch links cannot acknowledge by accident.
import { base64url, fromBase64url, hmacSha256, utf8, verifyHmacSha256 } from "./crypto.ts";
import { isRecord } from "./types.ts";

export interface AckClaims {
  readonly v: 1;
  /** Incident id. */
  readonly i: string;
  /** Contact id. */
  readonly c: string;
  /** Expiry, unix seconds. */
  readonly e: number;
}

export type AckVerification =
  | { readonly ok: true; readonly claims: AckClaims }
  | { readonly ok: false; readonly reason: "malformed" | "bad_signature" | "expired" };

const MAX_TOKEN = 512;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function createAckToken(key: string, incidentId: string, contactId: string, expiresAtMs: number): Promise<string> {
  if (!ID.test(incidentId) || !ID.test(contactId)) throw new Error("ACK_TOKEN_ID_INVALID");
  const claims: AckClaims = { v: 1, i: incidentId, c: contactId, e: Math.floor(expiresAtMs / 1000) };
  const payload = base64url(utf8(JSON.stringify(claims)));
  return `${payload}.${base64url(await hmacSha256(key, payload))}`;
}

export async function verifyAckToken(key: string, token: string, nowMs: number): Promise<AckVerification> {
  if (token.length > MAX_TOKEN) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payload = "", tagText = ""] = parts;
  const tag = fromBase64url(tagText);
  if (tag?.byteLength !== 32 || payload === "") return { ok: false, reason: "malformed" };
  // Signature first: nothing in an unsigned payload is parsed or trusted.
  if (!(await verifyHmacSha256(key, payload, tag))) return { ok: false, reason: "bad_signature" };
  const bytes = fromBase64url(payload);
  if (bytes === null) return { ok: false, reason: "malformed" };
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isRecord(claims) || claims["v"] !== 1) return { ok: false, reason: "malformed" };
  const incidentId = claims["i"], contactId = claims["c"], expires = claims["e"];
  if (typeof incidentId !== "string" || !ID.test(incidentId) || typeof contactId !== "string" || !ID.test(contactId)) {
    return { ok: false, reason: "malformed" };
  }
  if (typeof expires !== "number" || !Number.isInteger(expires)) return { ok: false, reason: "malformed" };
  if (nowMs >= expires * 1000) return { ok: false, reason: "expired" };
  return { ok: true, claims: { v: 1, i: incidentId, c: contactId, e: expires } };
}
