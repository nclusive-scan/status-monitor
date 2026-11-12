// SMS sizing. A carrier bills and delivers an SMS in segments: 160 GSM-7 septets alone or 153 per part, and as
// soon as one character falls outside GSM-7 the whole message switches to UCS-2, 70 UTF-16 units alone or 67 per part
// (https://www.twilio.com/docs/glossary/what-sms-character-limit). Every extra segment is another chance for a carrier to
// deliver the parts late or out of order, so a page aims at two segments at most.
//
// composeSms keeps the first line (headline, ACK code, status link) whole and cuts the detail after it, on code points so a
// surrogate pair is never split. Typographic punctuation that would force UCS-2 (smart quotes, dashes, ellipses,
// non-breaking spaces) is replaced with its GSM-7 equivalent first.

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** Characters sent as an escape plus one septet: two septets each. */
const GSM_EXTENDED = "^{}\\[~]|€\f";
const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENDED = new Set(Array.from(GSM_EXTENDED));

export const SMS_MAX_SEGMENTS = 2;
const ELLIPSIS = "...";

const REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/[‘’‚‛′`´]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―−]/g, "-"],
  [/…/g, "..."],
  [/[  -   　]/g, " "],
  [/[•·]/g, "-"],
  [/[​-‍⁠﻿]/g, ""],
];

/** Replaces typographic punctuation with GSM-7 equivalents; other characters are left as they are. */
export function toGsmFriendly(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REPLACEMENTS) result = result.replace(pattern, replacement);
  return result;
}

export const isGsm7 = (text: string): boolean => Array.from(text).every((character) => BASIC.has(character) || EXTENDED.has(character));

export interface SmsSize {
  readonly encoding: "gsm7" | "ucs2";
  /** Septets (GSM-7) or UTF-16 code units (UCS-2). */
  readonly units: number;
  readonly segments: number;
}

/**
 * Segments of a concatenated message, filled character by character: a character never straddles two segments, so a
 * 2-septet GSM-7 extension (escape plus character, e.g. "€", "[", "|") or a UTF-16 surrogate pair that does not fit in
 * what is left of a segment starts the next one, and that segment holds one unit less than a plain division suggests.
 */
function segmentsOf(sizes: readonly number[], perSegment: number): number {
  let segments = 1, used = 0;
  for (const size of sizes) {
    if (used + size > perSegment) {
      segments += 1;
      used = 0;
    }
    used += size;
  }
  return segments;
}

export function smsSize(text: string): SmsSize {
  const characters = Array.from(text);
  if (isGsm7(text)) {
    const sizes = characters.map((character) => (EXTENDED.has(character) ? 2 : 1));
    const units = sizes.reduce((sum, size) => sum + size, 0);
    return { encoding: "gsm7", units, segments: units <= 160 ? 1 : segmentsOf(sizes, 153) };
  }
  const units = text.length;
  return { encoding: "ucs2", units, segments: units <= 70 ? 1 : segmentsOf(characters.map((character) => character.length), 67) };
}

const fits = (text: string, maxSegments: number): boolean => smsSize(text).segments <= maxSegments;

/** The longest prefix of `points` (code points) that, followed by the suffix, still fits; binary search. */
function longestFitting(points: readonly string[], build: (prefix: string) => string, maxSegments: number): string | null {
  let low = 0, high = points.length, best: string | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(points.slice(0, middle).join(""));
    if (fits(candidate, maxSegments)) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/**
 * `headline` and `keep` (the ACK instruction and the status link) on the first line, then the detail on the next,
 * within maxSegments. The detail is cut first (ending in "..."); only if the first line alone is too long is the
 * headline cut too, never `keep`. Never splits a code point.
 */
export function composeSms(headline: string, keep: string, detail: string, maxSegments = SMS_MAX_SEGMENTS): string {
  const title = toGsmFriendly(headline).trim(), tail = toGsmFriendly(keep).trim(), rest = toGsmFriendly(detail).trim();
  const join = (first: string): string => (tail === "" ? first : `${first} ${tail}`);
  const top = join(title);
  const full = rest === "" ? top : `${top}\n${rest}`;
  if (fits(full, maxSegments)) return full;
  const cutDetail = longestFitting(Array.from(rest), (prefix) => `${top}\n${prefix.trimEnd()}${ELLIPSIS}`, maxSegments);
  if (cutDetail !== null && !cutDetail.endsWith(`\n${ELLIPSIS}`)) return cutDetail;
  if (fits(top, maxSegments)) return top;
  return longestFitting(Array.from(title), (prefix) => join(`${prefix.trimEnd()}${ELLIPSIS}`), maxSegments) ?? tail;
}
