// Cloudflare Access sign-in for /api/private (worker/access.ts): real RS256 tokens signed with keys made here, served
// from a fake certs endpoint. A token is accepted only with the team's key, the application's audience, the team
// issuer and a current lifetime; everything else, including an unreadable certs endpoint, is refused.
import assert from "node:assert/strict";
import test from "node:test";
import type { AccessDeps, AccessSettings } from "../worker/access.ts";
import { accessSettings, clearAccessCache, verifyAccessToken } from "../worker/access.ts";
import { handle } from "../status-page/worker/router.ts";

const TEAM = "nclusive.cloudflareaccess.com";
const AUD = "a".repeat(64);
const SETTINGS: AccessSettings = { teamDomain: TEAM, audience: AUD };
const NOW = Date.UTC(2026, 10, 12, 21, 0, 0);

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const json = (value: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function keyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true,
    ["sign", "verify"]);
}

async function jwk(pair: CryptoKeyPair, kid: string): Promise<Record<string, unknown>> {
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kty: "RSA", kid, n: exported.n, e: exported.e, alg: "RS256", use: "sig" };
}

async function sign(pair: CryptoKeyPair, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const body = `${json(header)}.${json(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(signature))}`;
}

const claims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: [AUD], iss: `https://${TEAM}`, email: "ops@getnclusive.com", iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, exp: NOW / 1000 + 3600, sub: "u1",
  ...overrides,
});

/** A certs endpoint serving `keys`, counting fetches; `fail` makes it answer 503. */
function certs(keys: () => Record<string, unknown>[], state = { fail: false, fetches: 0 }): { deps: AccessDeps; state: typeof state; at: { now: number } } {
  const at = { now: NOW };
  const deps: AccessDeps = {
    now: () => at.now,
    fetch: (url: string) => {
      state.fetches += 1;
      assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`);
      return Promise.resolve(state.fail ? new Response("no", { status: 503 }) : Response.json({ keys: keys() }));
    },
  };
  return { deps, state, at };
}

void test("access settings: both values, well-formed, or none at all", () => {
  assert.deepEqual(accessSettings({ ACCESS_TEAM_DOMAIN: " Nclusive.cloudflareaccess.com ", ACCESS_AUD: AUD.toUpperCase() }), SETTINGS);
  assert.equal(accessSettings({ ACCESS_TEAM_DOMAIN: TEAM }), null);
  assert.equal(accessSettings({ ACCESS_AUD: AUD }), null);
  assert.equal(accessSettings({ ACCESS_TEAM_DOMAIN: "evil.example.com", ACCESS_AUD: AUD }), null, "only a cloudflareaccess.com team domain");
  assert.equal(accessSettings({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "short" }), null);
});

void test("a token Access signed for this application verifies and names the person", async () => {
  clearAccessCache();
  const pair = await keyPair();
  const key = await jwk(pair, "k1");
  const { deps, state } = certs(() => [key]);
  const token = await sign(pair, { alg: "RS256", kid: "k1", typ: "JWT" }, claims());
  assert.deepEqual(await verifyAccessToken(token, SETTINGS, deps), { email: "ops@getnclusive.com" });
  assert.deepEqual(await verifyAccessToken(token, SETTINGS, deps), { email: "ops@getnclusive.com" });
  assert.equal(state.fetches, 1, "the certs are cached");
  const single = await sign(pair, { alg: "RS256", kid: "k1" }, claims({ aud: AUD }));
  assert.notEqual(await verifyAccessToken(single, SETTINGS, deps), null, "aud may be a single string");
});

void test("refused: another audience or issuer, expired, not yet valid, no email, a forged or tampered signature, other algorithms", async () => {
  clearAccessCache();
  const pair = await keyPair(), stranger = await keyPair();
  const key = await jwk(pair, "k1");
  const { deps } = certs(() => [key]);
  const header = { alg: "RS256", kid: "k1" };
  const refused = async (token: string, why: string): Promise<void> => {
    assert.equal(await verifyAccessToken(token, SETTINGS, deps), null, why);
  };
  await refused(await sign(pair, header, claims({ aud: ["b".repeat(64)] })), "another application");
  await refused(await sign(pair, header, claims({ iss: "https://other.cloudflareaccess.com" })), "another team");
  await refused(await sign(pair, header, claims({ exp: NOW / 1000 - 61 })), "expired beyond the skew");
  await refused(await sign(pair, header, claims({ nbf: NOW / 1000 + 120 })), "not valid yet");
  await refused(await sign(pair, header, claims({ email: undefined })), "no email");
  await refused(await sign(pair, header, claims({ exp: "never" })), "a non-numeric expiry");
  await refused(await sign(stranger, header, claims()), "signed with a key that is not the team's");
  const good = await sign(pair, header, claims());
  const [h, , s] = good.split(".");
  await refused(`${h ?? ""}.${json(claims({ email: "attacker@example.com" }))}.${s ?? ""}`, "payload changed after signing");
  await refused(`${json({ alg: "none", kid: "k1" })}.${json(claims())}.`, "alg none");
  await refused(await sign(pair, { alg: "HS256", kid: "k1" }, claims()), "another algorithm");
  await refused(await sign(pair, { alg: "RS256" }, claims()), "no kid");
  for (const junk of ["", "a.b", "a.b.c.d", "!!!.###.$$$", "x".repeat(9000)]) await refused(junk, `malformed: ${junk.slice(0, 12)}`);
  assert.equal(await verifyAccessToken(good, { ...SETTINGS, audience: "c".repeat(64) }, deps), null, "settings decide the audience");
});

void test("a rotated key is fetched once it is seen; an unreadable certs endpoint refuses every token", async () => {
  clearAccessCache();
  const first = await keyPair(), second = await keyPair();
  let served = [await jwk(first, "k1")];
  const { deps, state, at } = certs(() => served);
  assert.notEqual(await verifyAccessToken(await sign(first, { alg: "RS256", kid: "k1" }, claims()), SETTINGS, deps), null);
  served = [await jwk(first, "k1"), await jwk(second, "k2")];
  const rotated = await sign(second, { alg: "RS256", kid: "k2" }, claims());
  assert.equal(await verifyAccessToken(rotated, SETTINGS, deps), null, "an unknown kid right after a fetch waits a minute before refetching");
  at.now += 61_000;
  assert.notEqual(await verifyAccessToken(rotated, SETTINGS, deps), null, "then the new key is fetched and used");
  assert.equal(state.fetches, 2);

  clearAccessCache();
  state.fail = true;
  assert.equal(await verifyAccessToken(rotated, SETTINGS, deps), null, "fails closed when the certs cannot be read");
  state.fail = false;
  at.now += 2 * 3600_000;
  assert.equal(await verifyAccessToken(rotated, SETTINGS, deps), null, "a token that expired meanwhile is refused even with good certs");
});

void test("the status page forwards the Access token to /api/private, and to nothing else", async () => {
  const seen: Request[] = [];
  const monitor = { fetch: (request: Request) => { seen.push(request); return Promise.resolve(new Response("{}")); } };
  const deps = { cache: null, waitUntil: () => undefined };
  const headers = { "cf-access-jwt-assertion": "tok", authorization: "Bearer k" };
  await handle(new Request("https://status.example.com/api/private", { headers }), monitor, deps);
  await handle(new Request("https://status.example.com/api/status", { headers }), monitor, deps);
  assert.equal(seen[0]?.headers.get("cf-access-jwt-assertion"), "tok");
  assert.equal(seen[1]?.headers.get("cf-access-jwt-assertion"), null, "the public route gets no identity");
});

void test("concurrent requests share one certs fetch; a failing endpoint is retried at most once a minute", async () => {
  clearAccessCache();
  const pair = await keyPair();
  const key = await jwk(pair, "k1");
  const { deps, state, at } = certs(() => [key]);
  const token = await sign(pair, { alg: "RS256", kid: "k1" }, claims());
  const results = await Promise.all(Array.from({ length: 5 }, () => verifyAccessToken(token, SETTINGS, deps)));
  assert.ok(results.every((result) => result !== null));
  assert.equal(state.fetches, 1, "one fetch for five concurrent requests");

  clearAccessCache();
  state.fetches = 0;
  state.fail = true;
  for (let index = 0; index < 4; index += 1) assert.equal(await verifyAccessToken(token, SETTINGS, deps), null);
  assert.equal(state.fetches, 1, "an outage is not hammered: failed attempts count toward the limit");
  state.fail = false;
  at.now += 61_000;
  assert.notEqual(await verifyAccessToken(await sign(pair, { alg: "RS256", kid: "k1" }, claims({ exp: at.now / 1000 + 3600 })), SETTINGS, deps), null,
    "after a minute it tries again and recovers");
  assert.equal(state.fetches, 2);
});
