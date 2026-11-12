// Time and number formatting, in the viewer's locale and time zone.
import type { Shown } from "./model.ts";

/** "Nov 11, 9:53 PM EST": no seconds or year, with the zone so nobody has to guess it. */
const SHORT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
export const short = (iso: string | null): string => (iso === null ? "—" : new Date(iso).toLocaleString(undefined, SHORT));
/** Full date and time, for the operator view. */
export const when = (iso: string | null): string => (iso === null ? "—" : new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
/** "Nov 11" for a UTC day. */
export const dayLabel = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
/** "9:53 PM" today, "Nov 11, 9:53 PM" otherwise. */
export function clock(iso: string, now: number): string {
  const at = new Date(iso);
  const today = new Date(now).toDateString() === at.toDateString();
  return at.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export const hourLabel = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" });

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
/** "just now", "2 minutes ago", "3 hours ago", or the date beyond a day. */
export function ago(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return RELATIVE.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return RELATIVE.format(-hours, "hour");
  return short(iso);
}

export const percent = (value: number | null): string => (value === null ? "—" : `${value.toFixed(value === 100 ? 0 : 2)}%`);
export const ms = (value: number | null): string => (value === null ? "—" : `${String(Math.round(value))} ms`);

/** Text and mark colours per status (tokens in app.css). */
export const TONE_TEXT: Readonly<Record<Shown, string>> = {
  ok: "text-ok", degraded: "text-warn", down: "text-bad", unknown: "text-muted-foreground", maintenance: "text-info", none: "text-muted-foreground",
};
export const TONE_BG: Readonly<Record<Shown, string>> = {
  ok: "bg-ok", degraded: "bg-warn", down: "bg-bad", unknown: "bg-muted-foreground", maintenance: "bg-info", none: "bg-muted-foreground",
};
