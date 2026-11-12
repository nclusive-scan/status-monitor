// Optional Cloudflare Access sign-in for the operator view. Put a self-hosted Access application (Google or any other
// identity provider) in front of the status page's /operator and /api/private paths, then set ACCESS_TEAM_DOMAIN
// ("<team>.cloudflareaccess.com") and ACCESS_AUD (the application's audience tag). Access signs every request it lets
// through with a Cf-Access-Jwt-Assertion header; /api/private accepts that token when it verifies here, as well as the
// STATUS_VIEW_KEY bearer key (kept as the break-glass way in).
//
// Verification follows Cloudflare's guidance (developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/
// validating-json): RS256 only, a key from the team's own certs endpoint by kid, the application's audience, the team
// issuer, and the token's expiry and not-before times with a minute of clock skew. Anything else, including a certs
// endpoint that cannot be read, is a refusal: this check fails closed.

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[a-f0-9]{64}$/;
const SKEW_S = 60;
const CERTS_TTL_MS = 3600_000;
/** An unknown kid refetches the certs (Access rotates keys), at most this often. */
const REFETCH_AFTER_MS = 60_000;
const MAX_TOKEN = 8192;

export interface AccessSettings {
  readonly teamDomain: string;
  readonly audience: string;
}

/** The Access settings, or null when either is missing or malformed (then only the bearer key opens /api/private). */
export function accessSettings(env: Readonly<Record<string, unknown>>): AccessSettings | null {
  const team = env["ACCESS_TEAM_DOMAIN"], audience = env["ACCESS_AUD"];
  if (typeof team !== "string" || typeof audience !== "string") return null;
  const teamDomain = team.trim().toLowerCase(), aud = audience.trim().toLowerCase();
  return TEAM_DOMAIN.test(teamDomain) && AUDIENCE.test(aud) ? { teamDomain, audience: aud } : null;
}

export interface AccessDeps {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Epoch ms. */
  readonly now: () => number;
}

interface Certs {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly fetchedAt: number;
}

/** Per team domain, for the isolate's lifetime. */
const cache = new Map<string, Certs>();

/** For tests: forget every fetched key set. */
export function clearAccessCache(): void {
  cache.clear();
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function base64UrlBytes(part: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function base64UrlJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(part);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function loadCerts(settings: AccessSettings, deps: AccessDeps): Promise<Certs | null> {
  // Called bare, never as deps.fetch(...): the Workers fetch throws "Illegal invocation" when called as a method.
  const { fetch } = deps;
  let body: unknown;
  try {
    const response = await fetch(`https://${settings.teamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    return null;
  }
  const list = isRecord(body) ? body["keys"] : null;
  if (!Array.isArray(list)) return null;
  const keys = new Map<string, CryptoKey>();
  for (const entry of list) {
    if (!isRecord(entry) || entry["kty"] !== "RSA" || typeof entry["kid"] !== "string" || typeof entry["n"] !== "string" || typeof entry["e"] !== "string") continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: entry["n"], e: entry["e"], alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      keys.set(entry["kid"], key);
    } catch {
      // A key this runtime cannot import is skipped; a token signed with it fails as an unknown kid.
    }
  }
  return keys.size === 0 ? null : { keys, fetchedAt: deps.now() };
}

async function keyFor(kid: string, settings: AccessSettings, deps: AccessDeps): Promise<CryptoKey | null> {
  const now = deps.now();
  let certs = cache.get(settings.teamDomain) ?? null;
  const expired = certs === null || now - certs.fetchedAt > CERTS_TTL_MS;
  const unknownKid = certs !== null && !certs.keys.has(kid) && now - certs.fetchedAt > REFETCH_AFTER_MS;
  if (expired || unknownKid) {
    const fresh = await loadCerts(settings, deps);
    if (fresh !== null) {
      cache.set(settings.teamDomain, fresh);
      certs = fresh;
    } else if (expired) {
      return null;
    }
  }
  return certs?.keys.get(kid) ?? null;
}

/** The signed-in identity, or null for anything that does not verify. */
export async function verifyAccessToken(token: string, settings: AccessSettings, deps: AccessDeps): Promise<{ readonly email: string } | null> {
  if (token.length === 0 || token.length > MAX_TOKEN) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader = "", rawPayload = "", rawSignature = ""] = parts;
  const header = base64UrlJson(rawHeader), payload = base64UrlJson(rawPayload), signature = base64UrlBytes(rawSignature);
  if (header === null || payload === null || signature === null) return null;
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return null;

  const nowS = deps.now() / 1000;
  const aud = payload["aud"];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(settings.audience)) return null;
  if (payload["iss"] !== `https://${settings.teamDomain}`) return null;
  const exp = payload["exp"], nbf = payload["nbf"];
  if (typeof exp !== "number" || exp + SKEW_S < nowS) return null;
  if (nbf !== undefined && (typeof nbf !== "number" || nbf - SKEW_S > nowS)) return null;
  const email = payload["email"];
  if (typeof email !== "string" || email.length === 0) return null;

  const key = await keyFor(header["kid"], settings, deps);
  if (key === null) return null;
  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  return valid ? { email } : null;
}
