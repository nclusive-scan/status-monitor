// A component's recent history for the status page, from the hourly rollups (component_hourly): uptime per UTC day for
// the last 30 days (the bars) and latency per hour for the last 24 hours (the chart). Both series always have every
// slot, oldest first and ending at the slot that holds `now`; a slot without runs (or without a latency sample) is null.
// Hours are counted from the Unix epoch, so 24 of them make a UTC day.

export const HISTORY_DAYS = 30;
export const LATENCY_HOURS = 24;
const HOUR_MS = 3600_000;

export interface DayUptime {
  /** "YYYY-MM-DD", a UTC day. */
  readonly date: string;
  /** Percent of runs not down, to 3 decimals (like Uptime); null when the component had no run that day. */
  readonly uptime: number | null;
}

export interface HourLatency {
  /** The hour's start, UTC, as an ISO time. */
  readonly hour: string;
  /** Mean and worst of the hour's samples (one per run: its slowest conclusive result that was not down), in ms. */
  readonly avgMs: number | null;
  readonly maxMs: number | null;
}

export interface ComponentHistory {
  readonly history: readonly DayUptime[];
  readonly latency: readonly HourLatency[];
}

/** Rollup sums for one UTC day (keyed by days since the epoch) and one hour (keyed by hours since the epoch). */
export interface DaySums { readonly up: number; readonly total: number }
export interface HourSums { readonly sum: number; readonly count: number; readonly max: number }

/** The full series for one component; missing days and hours read as null (an empty map gives an all-null history). */
export function historySeries(
  now: number,
  days: ReadonlyMap<number, DaySums> = new Map(),
  hours: ReadonlyMap<number, HourSums> = new Map(),
): ComponentHistory {
  const hour = Math.floor(now / HOUR_MS), today = Math.floor(hour / 24);
  const history = Array.from({ length: HISTORY_DAYS }, (_, index): DayUptime => {
    const day = today - (HISTORY_DAYS - 1) + index;
    const sums = days.get(day);
    const uptime = sums === undefined || sums.total === 0 ? null : Math.round((sums.up / sums.total) * 100_000) / 1000;
    return { date: new Date(day * 24 * HOUR_MS).toISOString().slice(0, 10), uptime };
  });
  const latency = Array.from({ length: LATENCY_HOURS }, (_, index): HourLatency => {
    const at = hour - (LATENCY_HOURS - 1) + index;
    const sums = hours.get(at);
    const sampled = sums !== undefined && sums.count > 0;
    return { hour: new Date(at * HOUR_MS).toISOString(), avgMs: sampled ? Math.round(sums.sum / sums.count) : null, maxMs: sampled ? sums.max : null };
  });
  return { history, latency };
}
