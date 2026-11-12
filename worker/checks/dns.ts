// DNS check over DNS-over-HTTPS (cloudflare-dns.com JSON API). The host must resolve, and for a DNS-only (grey cloud)
// host no A or AAAA answer may sit inside Cloudflare's proxy ranges: a record switched to proxied (orange cloud) under
// Flexible SSL is a classic way to break a site (308 redirect loops, TLS failures on second-level names).
//
// The resolver is Cloudflare's own, like the zone it checks. An optional second resolver (DNS_SECONDARY_RESOLVER, any
// DoH JSON API such as https://dns.google/resolve) is asked when the first one fails; each then gets half the
// check's timeout. Only when every resolver fails is the result inconclusive (resolver_unavailable).
import type { DnsCheckConfig } from "../config.ts";
import type { CheckResult, Clock, FetchLike, Status } from "../types.ts";
import { isRecord } from "../types.ts";

// https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6 (checked 2026-11-11).
export const CLOUDFLARE_IPV4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
export const CLOUDFLARE_IPV6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

const DOH = "https://cloudflare-dns.com/dns-query";
const TYPE_A = 1, TYPE_CNAME = 5, TYPE_AAAA = 28;

export function parseIpv4(value: string): bigint | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    out = (out << 8n) | BigInt(part);
  }
  return out;
}

export function parseIpv6(value: string): bigint | null {
  const input = value.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(input) || input.split("::").length > 2) return null;
  const [head = "", tail] = input.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out = (out << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return out;
}

export function inCidr(address: string, cidr: string): boolean {
  const [network = "", bitsText = ""] = cidr.split("/");
  const v6 = network.includes(":");
  const width = v6 ? 128n : 32n;
  const parse = v6 ? parseIpv6 : parseIpv4;
  const ip = parse(address), base = parse(network), bits = BigInt(Number.parseInt(bitsText, 10));
  if (ip === null || base === null || bits < 0n || bits > width) return false;
  const shift = width - bits;
  return ip >> shift === base >> shift;
}

export const isCloudflareAddress = (address: string): boolean =>
  (address.includes(":") ? CLOUDFLARE_IPV6 : CLOUDFLARE_IPV4).some((cidr) => inCidr(address, cidr));

interface Answer {
  readonly type: number;
  readonly data: string;
}

type Lookup = { readonly ok: true; readonly status: number; readonly answers: readonly Answer[] } | { readonly ok: false };

async function lookup(fetch: FetchLike, resolver: string, hostname: string, type: "A" | "AAAA", signal: AbortSignal): Promise<Lookup> {
  const url = `${resolver}?name=${encodeURIComponent(hostname)}&type=${type}`;
  const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal, cache: "no-store" });
  if (!response.ok) return { ok: false };
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body["Status"] !== "number") return { ok: false };
  const raw = Array.isArray(body["Answer"]) ? body["Answer"] : [];
  const answers = raw.flatMap((item: unknown) =>
    isRecord(item) && typeof item["type"] === "number" && typeof item["data"] === "string" ? [{ type: item["type"], data: item["data"] }] : []
  );
  return { ok: true, status: body["Status"], answers };
}

const RCODES: Readonly<Record<number, string>> = { 2: "servfail", 3: "nxdomain", 5: "refused" };

export interface DnsCheckDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly secondaryResolver?: string | null;
}

/** Both lookups from one resolver within `timeoutMs`; null when the resolver failed (threw or answered badly). */
async function resolve(
  fetch: FetchLike, resolver: string, hostname: string, timeoutMs: number,
): Promise<[Lookup & { ok: true }, Lookup & { ok: true }] | null> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const [a, aaaa] = await Promise.all([lookup(fetch, resolver, hostname, "A", signal), lookup(fetch, resolver, hostname, "AAAA", signal)]);
    return a.ok && aaaa.ok ? [a, aaaa] : null;
  } catch {
    return null;
  }
}

export async function runDnsCheck(check: DnsCheckConfig, deps: DnsCheckDeps): Promise<CheckResult> {
  const started = deps.clock.now();
  const result = (status: Status, detail: string, data: Record<string, unknown>, inconclusive = false): CheckResult => ({
    checkId: check.id,
    componentId: check.component,
    type: "dns",
    status,
    inconclusive,
    latencyMs: Math.max(0, Math.round(deps.clock.now() - started)),
    detail,
    observedAt: started,
    data: { hostname: check.hostname, ...data },
  });
  const secondary = deps.secondaryResolver ?? null;
  const budget = secondary === null ? check.timeoutMs : Math.floor(check.timeoutMs / 2);
  let resolver = DOH;
  let answers = await resolve(deps.fetch, DOH, check.hostname, budget);
  if (answers === null && secondary !== null) {
    resolver = secondary;
    answers = await resolve(deps.fetch, secondary, check.hostname, budget);
  }
  // Every resolver failed: no evidence about the host, so the run does not count either way.
  if (answers === null) return result("degraded", "resolver_unavailable", {}, true);
  const [a, aaaa] = answers;
  if (a.status !== 0) return result("down", RCODES[a.status] ?? `rcode_${String(a.status)}`, {});
  const v4 = a.answers.filter((answer) => answer.type === TYPE_A).map((answer) => answer.data);
  const v6 = aaaa.status === 0 ? aaaa.answers.filter((answer) => answer.type === TYPE_AAAA).map((answer) => answer.data) : [];
  const cnames = a.answers.filter((answer) => answer.type === TYPE_CNAME).map((answer) => answer.data.replace(/\.$/, ""));
  const data = { addresses: [...v4, ...v6], cnames, ...(resolver === DOH ? {} : { resolver: new URL(resolver).host }) };
  if (v4.length === 0 && v6.length === 0) return result("down", "no_address", data);
  if (check.dnsOnly) {
    const proxied = [...v4, ...v6].filter(isCloudflareAddress);
    if (proxied.length > 0) return result("down", "cloudflare_proxy_address", { ...data, proxied });
  }
  return result("ok", "ok", data);
}
