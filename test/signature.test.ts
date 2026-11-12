// Signed request protocol v2 against the shared test vectors (spec/vectors/signature-v2.json, the set a server
// implementation should also pass): the canonical string and signature of every signing vector, and every verification
// vector replayed through a reference verifier built on the same canonical string.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalString, signedTarget, signRequest } from "../worker/signature.ts";
import { isRecord } from "../worker/types.ts";
import { countingRandom } from "./support/fakes.ts";

const vectors: unknown = JSON.parse(readFileSync(new URL("../spec/vectors/signature-v2.json", import.meta.url), "utf8"));
const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
};
const list = (value: unknown): Readonly<Record<string, unknown>>[] => (Array.isArray(value) ? value.map(record) : []);
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
};
const root = record(vectors);
const server = record(root["server"]);
const sha256 = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");
const hmac = (key: string, message: string): string => createHmac("sha256", Buffer.from(key, "utf8")).update(message).digest("hex");

void test("vectors: the file is the shared one, with at least six cases covering GET, POST, a non-default port and refusals", () => {
  const signatures = list(root["signatures"]), verifications = list(root["verifications"]);
  assert.ok(signatures.length + verifications.length >= 6);
  assert.ok(signatures.some((vector) => vector["method"] === "POST" && vector["body"] !== ""));
  assert.ok(signatures.some((vector) => str(vector["authority"]).includes(":")));
  assert.ok(verifications.some((vector) => vector["accept"] === false));
  assert.equal(root["emptyBodySha256"], sha256(""));
});

for (const vector of list(root["signatures"])) {
  void test(`vectors: signs "${str(vector["name"])}" exactly`, () => {
    assert.equal(sha256(str(vector["body"])), vector["bodySha256"], "body hash over the UTF-8 bytes");
    const canonical = canonicalString({
      method: str(vector["method"]), authority: str(vector["authority"]), path: str(vector["path"]), timestamp: Number(vector["timestamp"]),
      nonce: str(vector["nonce"]), bodySha256: str(vector["bodySha256"]),
    });
    assert.equal(canonical, vector["canonical"]);
    assert.equal(`v2=${hmac(str(vector["key"]), canonical)}`, vector["signature"]);
  });
}

void test("vectors: signRequest produces the vector's signature for the same URL, time and nonce", async () => {
  for (const vector of list(root["signatures"])) {
    const nonce = str(vector["nonce"]);
    const random = { bytes: (count: number): Uint8Array => Uint8Array.from(Buffer.from(nonce, "hex").subarray(0, count)) };
    const method = vector["method"] === "POST" ? "POST" : "GET";
    const url = `https://${str(vector["authority"])}${str(vector["path"])}`;
    const headers = await signRequest(str(vector["key"]), { method, url, body: str(vector["body"]) }, Number(vector["timestamp"]) * 1000, random);
    assert.deepEqual(headers, {
      "x-status-monitor-timestamp": vector["timestamp"], "x-status-monitor-nonce": nonce, "x-status-monitor-signature": vector["signature"],
    }, str(vector["name"]));
  }
});

/** A reference verifier with the server's rules, on the Worker's canonical string. */
function verify(request: Readonly<Record<string, unknown>>): { readonly accept: boolean; readonly reason: string | null } {
  const headers = record(request["headers"]);
  const timestamp = headers["x-status-monitor-timestamp"], nonce = headers["x-status-monitor-nonce"], signature = headers["x-status-monitor-signature"];
  if (timestamp === undefined && nonce === undefined && signature === undefined) return { accept: false, reason: "headers_missing" };
  const target = str(request["target"]);
  if (target.includes("?")) return { accept: false, reason: "query_present" };
  if (typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp) || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)
    || typeof signature !== "string" || !/^v2=[0-9a-f]{64}$/.test(signature)) {
    return { accept: false, reason: "headers_malformed" };
  }
  if (Math.abs(Number(server["nowSeconds"]) - Number(timestamp)) > Number(server["maxSkewSeconds"])) return { accept: false, reason: "timestamp_skew" };
  const purpose = record(server["keyPurposeByPath"])[target];
  const key = purpose === "health" ? str(server["healthKey"]) : str(server["configKey"]);
  const hosts = Array.isArray(server["hosts"]) ? server["hosts"].map(str) : [];
  const matches = hosts.some((authority) => signature === `v2=${hmac(key, canonicalString({
    method: str(request["method"]), authority, path: target, timestamp: Number(timestamp), nonce, bodySha256: sha256(str(request["body"])),
  }))}`);
  return matches ? { accept: true, reason: null } : { accept: false, reason: "signature_mismatch" };
}

for (const vector of list(root["verifications"])) {
  void test(`vectors: ${str(vector["name"])}`, () => {
    const outcome = verify(record(vector["request"]));
    assert.equal(outcome.accept, vector["accept"]);
    if (vector["accept"] === false) assert.equal(outcome.reason, vector["reason"]);
  });
}

void test("signer: refuses what the server would refuse (query, fragment, http, credentials) and keeps a non-default port", async () => {
  for (const url of ["https://h.example.com/api/v2/monitor/config?x=1", "https://h.example.com/api/v2/monitor/config?", "https://h.example.com/p#f",
    "http://h.example.com/api/v2/monitor/config", "https://u:p@h.example.com/api/v2/monitor/config", "not a url"]) {
    assert.equal(signedTarget(url), null, url);
    await assert.rejects(signRequest("k".repeat(40), { method: "GET", url, body: "" }, 0), /SIGNATURE_TARGET_INVALID/);
  }
  assert.deepEqual(
    signedTarget("https://Status.Example.com:8443/api/v2/monitor/config"), { authority: "status.example.com:8443", path: "/api/v2/monitor/config" },
  );
  assert.deepEqual(signedTarget("https://h.example.com:443/api/v2/monitor/health"), { authority: "h.example.com", path: "/api/v2/monitor/health" },
    "the default port is left out");
  const headers = await signRequest("k".repeat(40), { method: "GET", url: "https://h.example.com/x", body: "" }, 1_762_862_400_999, countingRandom());
  assert.equal(headers["x-status-monitor-timestamp"], "1762862400", "unix seconds, rounded down");
  assert.match(headers["x-status-monitor-nonce"] ?? "", /^[0-9a-f]{32}$/);
});
