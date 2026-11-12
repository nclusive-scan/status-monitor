// Small WebCrypto helpers shared by the deep-check signer, acknowledgement tokens and the Twilio signature check.
// Everything here runs unchanged in the Workers runtime and in Node 24 (the unit tests).

const encoder = new TextEncoder();

export const utf8 = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(value));

export const byteLength = (value: string | undefined | null): number => (typeof value === "string" ? utf8(value).byteLength : 0);

export function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function base64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const base64url = (bytes: ArrayBuffer | Uint8Array): string => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Decodes unpadded base64url; null for anything that is not strictly base64url. */
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, hash: "SHA-256" | "SHA-1", usages: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash }, false, usages);
}

/** Lowercase hex SHA-256 of the given bytes (the body hash in signed requests). */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacSha256(secret: string, message: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign("HMAC", await hmacKey(secret, "SHA-256", ["sign"]), utf8(message));
}

/** Constant-time verification of an HMAC-SHA256 tag (WebCrypto verify does not short-circuit). */
export async function verifyHmacSha256(secret: string, message: string, tag: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "SHA-256", ["verify"]), tag, utf8(message));
}

export async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  return base64(await crypto.subtle.sign("HMAC", await hmacKey(secret, "SHA-1", ["sign"]), utf8(message)));
}

/**
 * Compares two strings without an early exit on the first difference. The length difference is folded into the
 * result rather than returned early, so timing reveals at most the length of the expected value (fixed for our keys).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = utf8(a);
  const right = utf8(b);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export interface RandomSource {
  bytes(count: number): Uint8Array;
}

export const systemRandom: RandomSource = {
  bytes(count) {
    return crypto.getRandomValues(new Uint8Array(count));
  },
};

export const randomHex = (random: RandomSource, bytes: number): string => hex(random.bytes(bytes));

// No 0/O, 1/I/L: the code is read off a phone screen and typed back.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function randomCode(random: RandomSource, length: number): string {
  let out = "";
  // 248 is the largest multiple of 31 below 256: rejecting bytes at or above it keeps every letter equally likely.
  while (out.length < length) {
    for (const byte of random.bytes(length * 2)) {
      if (byte < 248 && out.length < length) out += CODE_ALPHABET[byte % CODE_ALPHABET.length] ?? "";
    }
  }
  return out;
}
