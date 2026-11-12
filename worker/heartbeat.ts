// The external dead-man's switch. After every successful run the Worker pings HEARTBEAT_URL; an outside service
// (Healthchecks-style, hosted off Cloudflare and alerting through its own channels) alarms when the pings stop. A run
// that refuses its configuration sends no ping, so the switch fires.
//
// HEARTBEAT_FAIL_URL (optional, Healthchecks' "/fail" endpoint) is pinged INSTEAD while paging itself is failing: an
// action send (page, notice, reminder) failed for good for an incident nobody has acknowledged, or one has waited in
// the outbox for more than PENDING_PAGE_ALARM_MS. Then the outside service alarms even though the checks still run.
//
// A missing HEARTBEAT_URL never stops monitoring; a live Worker without one carries the heartbeat_missing warning in
// the private view and the report (warnings.ts).
import type { PagingHealth } from "./store.ts";
import type { FetchLike } from "./types.ts";

export const PENDING_PAGE_ALARM_MS = 5 * 60_000;
export const HEARTBEAT_TIMEOUT_MS = 5000;

export const pagingFailing = (health: PagingHealth): boolean =>
  health.failedPages > 0 || (health.oldestPendingMs !== null && health.oldestPendingMs > PENDING_PAGE_ALARM_MS);

/** Which URL to ping after a successful run: the fail URL while paging is failing (when one is set), else the heartbeat. */
export function heartbeatTarget(urls: { readonly heartbeatUrl: string | null; readonly heartbeatFailUrl: string | null }, health: PagingHealth): string | null {
  if (pagingFailing(health) && urls.heartbeatFailUrl !== null) return urls.heartbeatFailUrl;
  return urls.heartbeatUrl;
}

/** One GET, bounded; never throws (the switch notices a missing ping by itself). True when it was answered 2xx. */
export async function ping(url: string | null, fetch: FetchLike): Promise<boolean> {
  if (url === null) return false;
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
