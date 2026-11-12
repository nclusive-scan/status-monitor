// Wall-clock time in an IANA zone (policy.timeZone), computed with Intl.DateTimeFormat. Storage stays in UTC epoch
// milliseconds; only messages and local-time schedules (the weekly drill) use these. Cron Triggers run on UTC, and a
// schedule pinned to a local time must never be written as a cron expression, which would drift an hour at every DST
// change: it is computed here instead.

// An IANA name ("America/New_York", "Etc/GMT+5", "UTC"), the platform validator's TIME_ZONE pattern exactly. Intl alone
// also accepts offsets such as "+05:00", which are not zone names and do not follow DST.
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+){0,2}$/;

/** True for an IANA zone name Intl knows: at most 64 characters, the name pattern, then Intl (the platform's test, exactly). */
export function isTimeZone(value: string): boolean {
  if (value.length > 64 || !TIME_ZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** ISO weekday, Monday = 1 ... Sunday = 7. */
  readonly weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** The wall clock in the zone at the given instant. */
export function wallClock(timeZone: string, ms: number): WallClock {
  const parts = new Map(formatter(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const number = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.get(type) ?? "0");
  return {
    year: number("year"), month: number("month"), day: number("day"), hour: number("hour") % 24, minute: number("minute"), second: number("second"),
    weekday: WEEKDAYS[parts.get("weekday") ?? ""] ?? 1,
  };
}

/** The zone's offset from UTC at the instant (local minus UTC), in milliseconds, to the whole second. */
export function offsetMs(timeZone: string, ms: number): number {
  const wall = wallClock(timeZone, ms);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The UTC instant of a local wall time. An ambiguous time (the repeated hour when DST ends) resolves to its first
 * occurrence; a time that does not exist (skipped when DST starts) moves forward by the gap, e.g. 02:30 on the US
 * spring-forward day becomes 03:30 daylight time.
 */
export function localToUtc(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMs(timeZone, wall - 12 * 3600_000), after = offsetMs(timeZone, wall + 12 * 3600_000);
  const valid = [wall - before, wall - after].filter((candidate) => offsetMs(timeZone, candidate) === wall - candidate).sort((a, b) => a - b);
  return valid[0] ?? wall - before;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** "03:12 EST (08:12 UTC)": the local time with its zone abbreviation, then UTC. In UTC itself, just "08:12 UTC". */
export function formatAlertTime(ms: number, timeZone: string): string {
  const utc = `${new Date(ms).toISOString().slice(11, 16)} UTC`;
  if (timeZone === "UTC") return utc;
  const wall = wallClock(timeZone, ms);
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(ms))
    .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  return `${pad(wall.hour)}:${pad(wall.minute)} ${name} (${utc})`;
}
