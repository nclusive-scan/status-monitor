// Maintenance windows (the platform document's top-level "maintenance" array). During a window, failures of the
// covered components are still recorded and counted, and the status page shows them as "Maintenance", but no incident
// opens and nothing pages. A component still failing when its window ends opens (and pages) on its next failing run,
// because the consecutive-failure count kept growing through the window. An incident already open when a window starts
// keeps escalating: someone is already being asked to act on it.
import type { Problems } from "./config.ts";
import { isPlainLine } from "./config.ts";
import { isRecord } from "./types.ts";

export interface MaintenanceWindow {
  readonly id: string;
  /** Component ids, or "all". */
  readonly components: readonly string[] | "all";
  readonly startsAt: number;
  readonly endsAt: number;
  readonly note: string;
}

export const MAINTENANCE_LIMITS = Object.freeze({ windows: 20, minMinutes: 5, maxMinutes: 12 * 60, noteChars: 120 });
const ID = /^[a-z][a-z0-9_]{0,47}$/;
// The platform validator's UTC_TIME, exactly: seconds, then either no fraction or exactly three digits.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Milliseconds of an ISO-8601 UTC timestamp ("2026-11-12T03:00:00Z", or with exactly 3 fractional digits), or null. */
export function parseIsoUtc(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const ms = Date.parse(value);
  // Date.parse rolls 2026-02-30 over to March: the round trip refuses a date that does not exist.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return ms;
}

/**
 * Validates the maintenance array. `known` is the effective set of component ids: the document's targets, or the
 * Worker's built-in MONITOR_TARGETS when the document's targets are null; null skips that check (the targets were
 * themselves invalid, which is already a problem).
 */
export function parseMaintenance(value: unknown, known: ReadonlySet<string> | null, problems: Problems): MaintenanceWindow[] {
  if (!Array.isArray(value) || value.length > MAINTENANCE_LIMITS.windows) {
    problems.add("maintenance", `must be an array of at most ${String(MAINTENANCE_LIMITS.windows)} windows`);
    return [];
  }
  const seen = new Set<string>();
  const windows: MaintenanceWindow[] = [];
  value.forEach((item: unknown, index) => {
    const path = `maintenance[${String(index)}]`;
    if (!isRecord(item)) {
      problems.add(path, "must be an object");
      return;
    }
    const id = item["id"];
    if (typeof id !== "string" || !ID.test(id)) problems.add(`${path}.id`, `must match ${ID.source}`);
    else if (seen.has(id)) problems.add("maintenance", `duplicate id ${id}`);
    else seen.add(id);
    const rawComponents = item["components"];
    let components: readonly string[] | "all" = "all";
    if (rawComponents !== "all") {
      if (!Array.isArray(rawComponents) || rawComponents.length === 0 || rawComponents.length > 50
        || !rawComponents.every((entry): entry is string => typeof entry === "string")) {
        problems.add(`${path}.components`, "must be \"all\" or a non-empty array of component ids");
        components = [];
      } else {
        // Refused, not deduplicated: the platform's validator refuses a repeated id, and both sides apply the same rules.
        const listed = new Set<string>();
        for (const component of rawComponents) {
          if (listed.has(component)) problems.add(`${path}.components`, `duplicate id ${component}`);
          listed.add(component);
        }
        components = [...listed];
        for (const component of components) if (known !== null && !known.has(component)) problems.add(`${path}.components`, `unknown component ${component}`);
      }
    }
    const startsAt = parseIsoUtc(item["startsAt"]), endsAt = parseIsoUtc(item["endsAt"]);
    if (startsAt === null) problems.add(`${path}.startsAt`, "must be an ISO-8601 UTC timestamp");
    if (endsAt === null) problems.add(`${path}.endsAt`, "must be an ISO-8601 UTC timestamp");
    if (startsAt !== null && endsAt !== null) {
      const minutes = (endsAt - startsAt) / 60_000;
      if (minutes < MAINTENANCE_LIMITS.minMinutes || minutes > MAINTENANCE_LIMITS.maxMinutes) {
        problems.add(path, "must end after it starts and last from 5 minutes to 12 hours");
      }
    }
    const rawNote = item["note"] ?? "";
    let note = "";
    if (typeof rawNote !== "string" || rawNote.length > MAINTENANCE_LIMITS.noteChars || (rawNote !== "" && !isPlainLine(rawNote))) {
      problems.add(`${path}.note`, `must be at most ${String(MAINTENANCE_LIMITS.noteChars)} printable characters on one line`);
    } else note = rawNote;
    if (typeof id === "string" && startsAt !== null && endsAt !== null) windows.push({ id, components, startsAt, endsAt, note });
  });
  return windows;
}

const covers = (window: MaintenanceWindow, componentId: string): boolean => window.components === "all" || window.components.includes(componentId);

/** The active window covering the component (the one ending last), or null. */
export function activeWindow(windows: readonly MaintenanceWindow[], componentId: string, now: number): MaintenanceWindow | null {
  let found: MaintenanceWindow | null = null;
  for (const window of windows) {
    if (window.startsAt <= now && now < window.endsAt && covers(window, componentId) && (found === null || window.endsAt > found.endsAt)) found = window;
  }
  return found;
}

/** Windows that are active now or start within `horizonMs`, earliest first (what the status page lists). */
export const currentAndUpcoming = (windows: readonly MaintenanceWindow[], now: number, horizonMs = 7 * 86_400_000): MaintenanceWindow[] =>
  windows.filter((window) => window.endsAt > now && window.startsAt <= now + horizonMs).sort((a, b) => a.startsAt - b.startsAt);
