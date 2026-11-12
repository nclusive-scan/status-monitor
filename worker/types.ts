// Shared result shapes. A check produces CheckResults; the monitor object folds them into component state.

export type Status = "ok" | "degraded" | "down";
export const STATUSES: readonly Status[] = ["ok", "degraded", "down"];
const RANK: Readonly<Record<Status, number>> = { ok: 0, degraded: 1, down: 2 };

export const statusRank = (status: Status): number => RANK[status];
export const isStatus = (value: unknown): value is Status => value === "ok" || value === "degraded" || value === "down";

/** The worst of the given statuses; "ok" for none. */
export function worst(statuses: Iterable<Status>): Status {
  let result: Status = "ok";
  for (const status of statuses) if (RANK[status] > RANK[result]) result = status;
  return result;
}

export type CheckType = "http" | "dns" | "deep";

export interface CheckResult {
  readonly checkId: string;
  readonly componentId: string;
  readonly type: CheckType;
  readonly status: Status;
  /**
   * True when the monitor could not tell (its own resolver or a monitor-side error), so the run is no evidence either
   * way: the component's counters are left alone instead of counting a pass or a failure.
   */
  readonly inconclusive: boolean;
  readonly latencyMs: number;
  /** Short machine-readable code such as "ok", "redirect_loop", "tls", "cloudflare_proxy_address". */
  readonly detail: string;
  readonly observedAt: number;
  /** Private diagnostics (final URL, redirect chain, resolved addresses, deep payload). Never shown publicly. */
  readonly data: Readonly<Record<string, unknown>> | null;
}

/**
 * The User-Agent of every request the monitor sends (checks, config pull, report). It names the upstream project so the
 * services being watched can identify the traffic; a modified fork should point it at the fork instead (README).
 */
export const USER_AGENT = "status-monitor/1 (+https://github.com/nclusive-scan/status-monitor)";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Detail codes are copied into logs and the private view, so only a narrow alphabet is kept. */
export const safeCode = (value: unknown, fallback = "invalid_detail"): string =>
  typeof value === "string" && /^[a-z0-9_.:-]{1,64}$/.test(value) ? value : fallback;
