// The weekly paging drill (policy.drill). PURE: schedule arithmetic and the rotation, no clock or I/O.
//
// Once a week, at policy.drill.time on ISO weekday policy.drill.weekday in policy.timeZone, ONE contact gets a "[TEST]"
// page, rotating through every contact in tier order. It is acknowledged like a real page (ACK <code> or the email
// link) within that contact's tier ackTimeoutMinutes, never escalates to anyone else, and a miss marks the contact
// drill_missed in contact health and emails the first tier's email contacts. The slot is computed from the IANA zone
// in code (time.ts), never from a cron expression, so it stays at the same local time across DST changes.
import type { Contact, EscalationPolicy, Tier } from "./config.ts";
import { localToUtc, wallClock } from "./time.ts";

export interface DrillSchedule {
  readonly enabled: boolean;
  /** ISO weekday: Monday = 1 ... Sunday = 7. */
  readonly weekday: number;
  /** "HH:MM", 24-hour, in policy.timeZone. */
  readonly time: string;
}

export const DEFAULT_DRILL: DrillSchedule = { enabled: false, weekday: 3, time: "10:00" };
export const DRILL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** A slot missed by more than this (the monitor was not running) is skipped rather than run late. */
export const DRILL_GRACE_MS = 15 * 60_000;
const DAY = 86_400_000;

function slotOnDay(schedule: DrillSchedule, timeZone: string, ms: number, days: number): number {
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  const wall = wallClock(timeZone, ms);
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * DAY);
  return localToUtc(timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute);
}

/** The latest drill slot at or before `ms` (UTC epoch ms). */
export function latestDrillSlot(schedule: DrillSchedule, timeZone: string, ms: number): number {
  let back = (wallClock(timeZone, ms).weekday - schedule.weekday + 7) % 7;
  for (;;) {
    const slot = slotOnDay(schedule, timeZone, ms, -back);
    if (slot <= ms) return slot;
    back += 7;
  }
}

/** The first drill slot strictly after `ms`. */
export function nextDrillSlot(schedule: DrillSchedule, timeZone: string, ms: number): number {
  let ahead = (schedule.weekday - wallClock(timeZone, ms).weekday + 7) % 7;
  for (;;) {
    const slot = slotOnDay(schedule, timeZone, ms, ahead);
    if (slot > ms) return slot;
    ahead += 7;
  }
}

/** The ISO week (Monday to Sunday, in the zone) holding the instant, as the day number of its Monday since 1970-01-01. */
export function isoWeekOf(timeZone: string, ms: number): number {
  const wall = wallClock(timeZone, ms);
  return Math.round(Date.UTC(wall.year, wall.month - 1, wall.day) / DAY) - (wall.weekday - 1);
}

/**
 * The slot a drill should start for now, or null: disabled, already run, missed by more than the grace, or in the same
 * ISO week (in policy.timeZone) as the last slot. The week rule keeps the drill weekly when its time or weekday moves
 * later in a week whose drill already ran: the moved slot is newer than the last one, but it waits for next week.
 */
export function dueDrillSlot(policy: EscalationPolicy, lastSlot: number | null, now: number): number | null {
  if (!policy.drill.enabled) return null;
  const slot = latestDrillSlot(policy.drill, policy.timeZone, now);
  if (lastSlot !== null && (slot <= lastSlot || isoWeekOf(policy.timeZone, slot) === isoWeekOf(policy.timeZone, lastSlot))) return null;
  return now - slot <= DRILL_GRACE_MS ? slot : null;
}

/** The contact after `lastContactId` in tier order (the first one when it is unknown or was the last). */
export function nextDrillContact(policy: EscalationPolicy, lastContactId: string | null): { readonly contact: Contact; readonly tier: Tier } | null {
  const all = policy.tiers.flatMap((tier) => tier.contacts.map((contact) => ({ contact, tier })));
  const index = all.findIndex((entry) => entry.contact.id === lastContactId);
  return all[index + 1] ?? all[0] ?? null;
}

/** A one-tier, one-cycle policy holding only the drilled contact, with its own tier's acknowledgement timeout. */
export const drillPolicy = (policy: EscalationPolicy, tier: Tier, contact: Contact): EscalationPolicy => ({
  ...policy,
  maxCycles: 1,
  reminderMinutes: 0,
  tiers: [{ ...tier, contacts: [contact] }],
});
