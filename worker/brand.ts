// The name the monitor signs its messages and pages with (BRAND_NAME, optional, default "Status"): "[<brand>]" leads
// every SMS and email subject, "Sent by the <brand> status monitor." closes every email, and the pages are titled
// "<brand> status". The public status page reads it from /api/status.
//
// The SMS composer never cuts the brand prefix (sms-text.ts keeps the first line's start), so the brand is held to what
// cannot break a two-segment page: 1 to 24 characters, all of them in GSM-7's basic set (one character outside it
// switches the whole text to UCS-2, 70 characters a segment instead of 160), with no characters that need care in an
// email header or HTML (quotes, angle brackets). A value outside these rules refuses the configuration (config.ts),
// as every other invalid setting does; brandOf() falls back to the default for the pages, which must render anyway.

export const DEFAULT_BRAND_NAME = "Status";
export const BRAND_NAME_MAX_CHARS = 24;
/** Letters, digits, space and . , & ' ( ) + _ -; starts with a letter or digit, no double spaces, no trailing space. */
const BRAND = /^[A-Za-z0-9](?:[A-Za-z0-9.,&'()+_-]| (?! ))*$/;

/** Null when the value is a usable brand name, otherwise the problem to report for BRAND_NAME. */
export function brandNameProblem(value: string): string | null {
  if (value.length < 1 || value.length > BRAND_NAME_MAX_CHARS || !BRAND.test(value) || value.endsWith(" ")) {
    return `must be 1 to ${String(BRAND_NAME_MAX_CHARS)} characters: letters, digits, single spaces and . , & ' ( ) + _ - (starting with a letter or digit)`;
  }
  return null;
}

/** BRAND_NAME as configured (trimmed), the default when unset, or null when it is set but invalid. */
export function configuredBrandName(env: Readonly<Record<string, unknown>>): string | null {
  const raw = env["BRAND_NAME"];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_BRAND_NAME;
  const value = raw.trim();
  return brandNameProblem(value) === null ? value : null;
}

/** The brand for pages that must render even when the configuration is refused: an invalid value reads as the default. */
export const brandOf = (env: Readonly<Record<string, unknown>>): string => configuredBrandName(env) ?? DEFAULT_BRAND_NAME;

/** "<brand> <noun>", or the brand alone when it already is the noun (the default brand "Status" gives "Status", not "Status status"). */
export const withNoun = (brand: string, noun: string): string => (brand.toLowerCase() === noun.toLowerCase() ? brand : `${brand} ${noun}`);
