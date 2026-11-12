// Runs every configured check, at most CHECK_CONCURRENCY connections at a time (limit.ts): the Workers runtime lets
// one invocation wait on only 6 connections, and the config pull runs beside the checks on the sixth. Each check
// starts its own timer once it holds a slot, so a queue behind hung origins never turns into false timeouts. A check
// never throws out of here: an unexpected error becomes an inconclusive result so one broken check cannot stop the run
// (or count as an outage of its component).
import type { CheckConfig, TargetsConfig } from "../config.ts";
import type { RandomSource } from "../crypto.ts";
import type { Limiter } from "../limit.ts";
import { createLimiter } from "../limit.ts";
import type { CheckResult, Clock, FetchLike } from "../types.ts";
import { runDeepCheck } from "./deep.ts";
import { runDnsCheck } from "./dns.ts";
import { runHttpCheck } from "./http.ts";

export const CHECK_CONCURRENCY = 5;

export interface RunDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  /** MONITOR_HEALTH_KEY, which signs the deep check. */
  readonly healthKey: string | null;
  /** An optional second DoH resolver (DNS_SECONDARY_RESOLVER). */
  readonly dnsSecondaryResolver?: string | null;
  readonly random?: RandomSource;
  readonly limiter?: Limiter;
}

async function runOne(check: CheckConfig, deps: RunDeps): Promise<CheckResult[]> {
  switch (check.type) {
    case "http":
      return [await runHttpCheck(check, deps)];
    case "dns":
      return [await runDnsCheck(check, { fetch: deps.fetch, clock: deps.clock, secondaryResolver: deps.dnsSecondaryResolver ?? null })];
    case "deep": {
      if (deps.healthKey === null) throw new Error("MONITOR_HEALTH_KEY_MISSING");
      const random = deps.random;
      return runDeepCheck(check, { fetch: deps.fetch, clock: deps.clock, key: deps.healthKey, ...(random === undefined ? {} : { random }) });
    }
  }
}

export async function runChecks(targets: TargetsConfig, deps: RunDeps): Promise<CheckResult[]> {
  const limiter = deps.limiter ?? createLimiter(CHECK_CONCURRENCY);
  const settled = await Promise.all(
    targets.checks.map((check): Promise<CheckResult[]> =>
      limiter.run(async () => {
        const observedAt = deps.clock.now();
        try {
          return await runOne(check, deps);
        } catch {
          return [{ checkId: check.id, componentId: check.component, type: check.type, status: "degraded", inconclusive: true, latencyMs: 0,
            detail: "monitor_error", observedAt, data: null }];
        }
      }, check.type === "dns" ? 2 : 1)
    ),
  );
  return settled.flat();
}
