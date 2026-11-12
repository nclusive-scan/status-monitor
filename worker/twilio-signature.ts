// X-Twilio-Signature validation, per Twilio's algorithm (https://www.twilio.com/docs/usage/security#validating-requests):
// take the full public URL Twilio requested (exactly as configured in the console, including any query string), append
// every POST parameter as name followed by value, sorted by name (repeated names: their values sorted), HMAC-SHA1 the
// result with the account auth token, and base64 it. The URL is the configured public one, never the request URL the
// Worker sees (the request arrives through the Pages service binding under another host).
import { constantTimeEqual, hmacSha1Base64 } from "./crypto.ts";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function twilioSignatureBase(url: string, params: readonly (readonly [string, string])[]): string {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of params) grouped.set(name, [...(grouped.get(name) ?? []), value]);
  let base = url;
  for (const name of [...grouped.keys()].sort(byCodeUnit)) {
    for (const value of [...(grouped.get(name) ?? [])].sort(byCodeUnit)) base += name + value;
  }
  return base;
}

export const computeTwilioSignature = (authToken: string, url: string, params: readonly (readonly [string, string])[]): Promise<string> =>
  hmacSha1Base64(authToken, twilioSignatureBase(url, params));

export async function validateTwilioSignature(
  authToken: string,
  url: string,
  params: readonly (readonly [string, string])[],
  header: string | null,
): Promise<boolean> {
  if (header === null || header.length === 0 || header.length > 128 || authToken.length === 0) return false;
  return constantTimeEqual(await computeTwilioSignature(authToken, url, params), header);
}

/**
 * Valid under any of the tokens (the auth token, and during a rotation the secondary one). Each is computed in
 * full, so the time taken does not depend on which matched.
 */
export async function validateTwilioSignatureAny(
  authTokens: readonly (string | null)[],
  url: string,
  params: readonly (readonly [string, string])[],
  header: string | null,
): Promise<boolean> {
  let valid = false;
  for (const token of authTokens) if (token !== null && (await validateTwilioSignature(token, url, params, header))) valid = true;
  return valid;
}
