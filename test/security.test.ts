// Acknowledgement tokens, the Twilio signature algorithm (Twilio's published vectors), and constant-time comparison.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createAckToken, verifyAckToken } from "../worker/ack.ts";
import { constantTimeEqual, randomCode } from "../worker/crypto.ts";
import { computeTwilioSignature, twilioSignatureBase, validateTwilioSignature } from "../worker/twilio-signature.ts";
import { countingRandom, MINUTE, T0 } from "./support/fakes.ts";

const KEY = "k".repeat(32) + "-ack-signing-key-for-tests";

void test("an acknowledgement token verifies before expiry and names its incident and contact", async () => {
  const token = await createAckToken(KEY, "inc_abc_1234", "primary_oncall", T0 + 60 * MINUTE);
  const verified = await verifyAckToken(KEY, token, T0);
  assert.deepEqual(verified, { ok: true, claims: { v: 1, i: "inc_abc_1234", c: "primary_oncall", e: (T0 + 60 * MINUTE) / 1000 } });
});

void test("an acknowledgement token is refused when expired, re-signed, tampered or malformed", async () => {
  const token = await createAckToken(KEY, "inc_abc_1234", "primary_oncall", T0 + MINUTE);
  assert.deepEqual(await verifyAckToken(KEY, token, T0 + MINUTE), { ok: false, reason: "expired" });
  assert.deepEqual(await verifyAckToken(`${KEY}x`, token, T0), { ok: false, reason: "bad_signature" });
  const [payload = "", tag = ""] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, i: "inc_other", c: "primary_oncall", e: 9e9 })).toString("base64url");
  assert.deepEqual(await verifyAckToken(KEY, `${forged}.${tag}`, T0), { ok: false, reason: "bad_signature" });
  assert.deepEqual(await verifyAckToken(KEY, `${payload}.`, T0), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifyAckToken(KEY, "not-a-token", T0), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifyAckToken(KEY, `${payload}.${tag}.extra`, T0), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifyAckToken(KEY, "a".repeat(600), T0), { ok: false, reason: "malformed" });
  // A correctly signed payload that is not a claims object is still refused.
  const junk = Buffer.from("[1,2]").toString("base64url");
  const junkTag = createHmac("sha256", KEY).update(junk).digest("base64url");
  assert.deepEqual(await verifyAckToken(KEY, `${junk}.${junkTag}`, T0), { ok: false, reason: "malformed" });
  await assert.rejects(createAckToken(KEY, "bad.id", "x", T0), /ACK_TOKEN_ID_INVALID/);
});

// Twilio's own example inputs. The first set, with token "12345" and its expected signature, is the known answer in
// Twilio's official Python helper library's tests (twilio-python, tests/unit/test_request_validator.py). The second set
// uses the parameters of the validation sample in Twilio's webhook security guide
// (https://www.twilio.com/docs/usage/webhooks/webhooks-security) with the same URL and token, and its expected value is
// the HMAC-SHA1 of those inputs. The URL and phone numbers are Twilio's, kept as published so the cases can be checked
// against those sources; they are the one allowed exception to the fixture rule in CONTRIBUTING.md (example.com hosts
// and +15555550100 to +15555550199 only). Do not reuse them anywhere else.
const URL_WITH_QUERY = "https://mycompany.com/myapp.php?foo=1&bar=2";

void test("Twilio signatures match Twilio's known answer and its documented example inputs", async () => {
  const params: [string, string][] = [
    ["Digits", "1234"], ["To", "+18005551212"], ["From", "+14158675309"], ["Caller", "+14158675309"], ["CallSid", "CA1234567890ABCDE"],
  ];
  assert.equal(await computeTwilioSignature("12345", URL_WITH_QUERY, params), "RSOYDt4T1cUTdK1PDd93/VVr8B8=");
  const docs: [string, string][] = [
    ["CallSid", "CA1234567890ABCDE"], ["Caller", "+12349013030"], ["Digits", "1234"], ["From", "+12349013030"], ["To", "+18005551212"],
  ];
  assert.equal(await computeTwilioSignature("12345", URL_WITH_QUERY, docs), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

void test("Twilio signature base sorts names, and the values of a repeated name", () => {
  assert.equal(twilioSignatureBase("https://x/hook", [["b", "2"], ["a", "9"], ["a", "1"]]), "https://x/hooka1a9b2");
});

void test("Twilio signature validation refuses a wrong URL, changed body, other token or missing header", async () => {
  const url = "https://status.example.com/hooks/twilio";
  const params: [string, string][] = [["From", "+15555550100"], ["Body", "ACK ABC234"]];
  const good = createHmac("sha1", "token").update(twilioSignatureBase(url, params)).digest("base64");
  assert.equal(await validateTwilioSignature("token", url, params, good), true);
  assert.equal(await validateTwilioSignature("token", "https://monitor.internal/hooks/twilio", params, good), false);
  assert.equal(await validateTwilioSignature("token", url, [["From", "+15555550100"], ["Body", "ACK ZZZ234"]], good), false);
  assert.equal(await validateTwilioSignature("other", url, params, good), false);
  assert.equal(await validateTwilioSignature("token", url, params, null), false);
  assert.equal(await validateTwilioSignature("", url, params, good), false);
});

void test("constant-time comparison is exact", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
});

void test("acknowledgement codes use the unambiguous alphabet", () => {
  const random = countingRandom();
  for (let index = 0; index < 50; index += 1) assert.match(randomCode(random, 6), /^[2-9A-HJKMNP-Z]{6}$/);
});
