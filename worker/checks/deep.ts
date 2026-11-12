// Deep check: a signed GET of the watched platform's /api/v2/monitor/health (spec/PROTOCOL.md, "Deep health"), mapped
// into components. A server should answer anything unsigned, stale or mis-signed exactly like an unknown path (often
// 401 for an anonymous caller such as this one, or 404), so 401, 403 and 404 all mean "rejected or not deployed" and are
// reported as deep_rejected_or_missing.
//
// Detail codes: a server may send UPPERCASE codes ("OK", "BACKLOG_STALE"); they are lowercased here so they read like
// the monitor's own codes ("backlog_stale") and pass the narrow alphabet that logs and the private view accept.
//
// The request is signed with protocol v2 (signature.ts) and the HEALTH key (MONITOR_HEALTH_KEY), which can read only
// the health counts; the config pull and the report use the separate CONFIG key. Transport failures and unexpected
// statuses are named exactly as the http check names them (classifyFetchError, classifyStatus).
import type { DeepCheckConfig } from "../config.ts";
import { systemRandom } from "../crypto.ts";
import type { RandomSource } from "../crypto.ts";
import { signRequest } from "../signature.ts";
import type { CheckResult, Clock, FetchLike, Status } from "../types.ts";
import { isRecord, isStatus, safeCode, USER_AGENT, worst } from "../types.ts";
import { classifyFetchError, classifyStatus } from "./http.ts";

export interface DeepSubCheck {
  readonly id: string;
  readonly status: Status;
  readonly latencyMs: number;
  readonly detail: string;
  readonly value: number | null;
}

export interface DeepPayload {
  readonly version: 1;
  readonly generatedAt: string;
  readonly release: { readonly version: string; readonly commit: string };
  readonly overall: Status;
  readonly checks: readonly DeepSubCheck[];
}

/** The contract leaves the case of detail codes open; the endpoint sends UPPERCASE. Lowercased, then validated. */
export const deepDetail = (value: unknown): string => safeCode(typeof value === "string" ? value.toLowerCase() : value);

const REJECTED = new Set([401, 403, 404]);

/** Validates the contract's 200 body; null when anything is off. Copies only the contract's fields. */
export function parseDeepPayload(body: unknown): DeepPayload | null {
  if (!isRecord(body) || body["version"] !== 1 || !isStatus(body["overall"]) || typeof body["generatedAt"] !== "string") return null;
  const release = body["release"];
  if (!isRecord(release) || typeof release["version"] !== "string" || typeof release["commit"] !== "string") return null;
  const rawChecks: unknown = body["checks"];
  if (!Array.isArray(rawChecks)) return null;
  const checks: DeepSubCheck[] = [];
  for (const entry of rawChecks) {
    const item: unknown = entry;
    if (!isRecord(item) || typeof item["id"] !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(item["id"]) || !isStatus(item["status"])) return null;
    const latency = item["latencyMs"], value = item["value"];
    if (typeof latency !== "number" || !Number.isFinite(latency)) return null;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return null;
    checks.push({ id: item["id"], status: item["status"], latencyMs: Math.round(latency), detail: deepDetail(item["detail"]), value });
  }
  return {
    version: 1,
    generatedAt: body["generatedAt"].slice(0, 40),
    release: { version: safeCode(release["version"], "unknown"), commit: safeCode(release["commit"], "unknown") },
    overall: body["overall"],
    checks,
  };
}

export interface DeepCheckDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  /** MONITOR_HEALTH_KEY. */
  readonly key: string;
  readonly random?: RandomSource;
}

/**
 * Returns the check's own result plus one result per mapped sub-check (id "<check>.<sub>", on the mapped component).
 * When the endpoint cannot be read, only the check's own result is returned: the mapped components get no evidence
 * this run rather than a second, duplicate failure.
 */
export async function runDeepCheck(check: DeepCheckConfig, deps: DeepCheckDeps): Promise<CheckResult[]> {
  // Called bare, never as deps.fetch(...): the Workers fetch throws "Illegal invocation" when called as a method.
  const { fetch } = deps;
  const started = deps.clock.now();
  const own = (status: Status, detail: string, data: Record<string, unknown> | null, latencyMs?: number): CheckResult => ({
    checkId: check.id,
    componentId: check.component,
    type: "deep",
    status,
    inconclusive: false,
    latencyMs: latencyMs ?? Math.max(0, Math.round(deps.clock.now() - started)),
    detail,
    observedAt: started,
    data,
  });
  let response: Response;
  try {
    response = await fetch(check.url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(check.timeoutMs),
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(await signRequest(deps.key, { method: "GET", url: check.url, body: "" }, started, deps.random ?? systemRandom)),
      },
    });
  } catch (error) {
    return [own("down", classifyFetchError(error), null)];
  }
  const latencyMs = Math.max(0, Math.round(deps.clock.now() - started));
  if (REJECTED.has(response.status)) {
    await response.body?.cancel();
    return [own("down", "deep_rejected_or_missing", null, latencyMs)];
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return [own("down", classifyStatus(response.status), null, latencyMs)];
  }
  let payload: DeepPayload | null = null;
  try {
    payload = parseDeepPayload(await response.json());
  } catch {
    payload = null;
  }
  if (payload === null) return [own("down", "deep_invalid_payload", null, latencyMs)];
  const mapped = payload.checks.filter((sub) => check.componentMap[sub.id] !== undefined);
  const unmapped = payload.checks.filter((sub) => check.componentMap[sub.id] === undefined);
  // With nothing mapped the server's own "overall" is authoritative; otherwise only what this component owns counts.
  let status: Status = mapped.length === 0 ? payload.overall : worst(unmapped.map((sub) => sub.status));
  let detail = status === "ok" ? "ok" : (unmapped.find((sub) => sub.status === status)?.detail ?? `overall_${payload.overall}`);
  if (status === "ok" && latencyMs > check.latencyDegradedMs) {
    status = "degraded";
    detail = "slow";
  }
  const data = { url: check.url, release: payload.release, overall: payload.overall, generatedAt: payload.generatedAt, checks: payload.checks };
  const subResults = mapped.map((sub): CheckResult => ({
    checkId: `${check.id}.${sub.id}`,
    componentId: check.componentMap[sub.id] ?? check.component,
    type: "deep",
    status: sub.status,
    inconclusive: false,
    latencyMs: sub.latencyMs,
    detail: sub.detail,
    observedAt: started,
    data: { value: sub.value },
  }));
  return [own(status, detail, data, latencyMs), ...subResults];
}
