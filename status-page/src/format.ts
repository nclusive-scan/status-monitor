// Time and number formatting for the page, in the viewer's locale and time zone.
import type { Shown } from "./model.ts";
import type { StatusTone } from "@/components/ui/status-pill";

/** "Nov 11, 9:53 PM" (no seconds, no year). */
const SHORT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
export const short = (iso: string | null): string => (iso === null ? "—" : new Date(iso).toLocaleString(undefined, SHORT));
export const when = (iso: string | null): string => (iso === null ? "—" : new Date(iso).toLocaleString());
export const dayLabel = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
export const hourLabel = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric" });

/** "just now", "12 s ago", "4 min ago", "3 h ago", or the date beyond a day. */
export function ago(iso: string | null, now: number): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${String(seconds)} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return short(iso);
}

export const percent = (value: number | null): string => (value === null ? "—" : `${value.toFixed(value === 100 ? 0 : 2)}%`);
export const ms = (value: number | null): string => (value === null ? "—" : `${String(Math.round(value))} ms`);

export type { Shown } from "./model.ts";
export const TONE: Readonly<Record<Shown, StatusTone>> = {
  ok: "positive", degraded: "warning", down: "negative", unknown: "neutral", maintenance: "brand", none: "neutral",
};
