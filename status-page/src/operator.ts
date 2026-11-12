// What the operator view says, worked out from /api/private without touching the DOM (app.ts renders it; the tests run
// this module under Node). Times are formatted by the caller (`when`), in the viewer's locale and time zone.
import type { Format } from "./model.ts";

const field = (record: unknown, key: string): unknown => (typeof record === "object" && record !== null ? Reflect.get(record, key) : undefined);

const isoField = (record: unknown, key: string): string | null => {
  const value = field(record, key);
  return typeof value === "string" ? value : null;
};

export const str = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
};

/**
 * Where the configuration comes from (platform revision or the Worker's bootstrap) and how the pull is doing. In
 * standalone mode (no PLATFORM_CONFIG_URL) the Worker's settings are the whole configuration and nothing is pulled.
 */
function configFacts(config: unknown, when: Format): [string, string][] {
  if (field(config, "mode") === "standalone") return [["Config source", "Standalone (Worker settings; no platform)"]];
  const revision = field(config, "revision"), stored = field(config, "storedRevision"), by = field(config, "updatedBy");
  let source = "Bootstrap (Worker settings)";
  if (field(config, "source") === "platform" && typeof revision === "number") {
    source = `Platform revision ${String(revision)}${typeof by === "string" ? `, saved by ${by}` : ""}`;
    if (isoField(config, "updatedAt") !== null) source += ` ${when(isoField(config, "updatedAt"))}`;
  } else if (typeof stored === "number") source += ` (stored revision ${String(stored)} no longer validates)`;
  const code = field(config, "lastErrorCode"), detail = field(config, "lastErrorDetail");
  const error = typeof code === "string"
    ? `${code} at ${when(isoField(config, "lastErrorAt"))}${typeof detail === "string" && detail !== "" ? ` · ${detail}` : ""}`
    : "none";
  return [["Config source", source], ["Last config fetch", when(isoField(config, "lastFetchAt"))], ["Config fetch error", error]];
}

/** Plain-language text for the monitor's warning codes ("code" or "code:id"); unknown codes are shown as they are. */
export function warningText(warning: string): string {
  const [code = "", id = ""] = warning.split(":");
  switch (code) {
    case "heartbeat_missing":
      return "No outside heartbeat is configured: nothing outside Cloudflare notices if the monitor stops. Go-live blocker.";
    case "contact_single_channel":
      return `Contact ${id} has only one channel (mobile or email).`;
    case "tier_single_contact":
      return `Tier ${id} has only one contact.`;
    case "drill_disabled":
      return "The weekly paging drill is off.";
    case "email_alert_no_recipient":
      return "A component alerts by email only, but the first tier has no email address: its alerts reach nobody.";
    case "dns_inconclusive":
      return "Every DNS check has been inconclusive for over 15 minutes (the resolver is failing).";
    case "incidents_pruned_unexported":
      return "Retention removed incidents the platform never archived.";
    case "email_channel_failing":
      return `Alert email is failing for every contact (${id}). Texts still go out; the first tier was told by text. Check Cloudflare Email Service.`;
    case "sms_channel_failing":
      return `Alert texts are failing for every contact (${id}). Email still goes out; the first tier was told by email. `
        + "Check the Twilio account, sender and registration.";
    case "sms_delivery_unknown":
      return "A text sent in the last 24 hours got no delivery confirmation within 10 minutes. It may not have arrived.";
    default:
      return warning;
  }
}

function heartbeatFact(heartbeat: unknown): string {
  if (field(heartbeat, "configured") !== true) return "not configured";
  const paging = field(heartbeat, "paging");
  const failed = field(paging, "failedPages");
  const fail = field(heartbeat, "failUrlConfigured") === true ? ", fail URL set" : "";
  return `configured${fail}${typeof failed === "number" && failed > 0 ? ` · ${String(failed)} page(s) failed for good` : ""}`;
}

function reportFact(report: unknown, when: Format): string {
  const code = field(report, "lastErrorCode");
  const ok = `last accepted ${when(isoField(report, "lastOkAt"))}`;
  return typeof code === "string" ? `${ok} · last error ${code} at ${when(isoField(report, "lastErrorAt"))}` : ok;
}

/** Webhooks refused for a bad X-Twilio-Signature: a probe, or an auth token rotated on one side only. */
function signatureFact(rejected: unknown, when: Format): string {
  const count = field(rejected, "count");
  if (typeof count !== "number" || count === 0) return "none";
  return `${String(count)} refused, last ${when(isoField(rejected, "lastAt"))}`;
}

/** The "Monitor" facts list: label and value, in order. */
export function monitorFacts(monitor: unknown, when: Format): [string, string][] {
  const report: [string, string][] = field(field(monitor, "config"), "mode") === "standalone"
    ? []
    : [["Report to the platform", reportFact(field(monitor, "report"), when)]];
  return [
    ["Last run", when(isoField(monitor, "lastRunAt"))],
    ["Stale", field(monitor, "stale") === true ? "yes" : "no"],
    ["Configuration", str(field(monitor, "configError") ?? "valid")],
    ...configFacts(field(monitor, "config"), when),
    ["Delivery", field(monitor, "deliveryMode") === "log" ? "log only (nothing is sent)" : str(field(monitor, "deliveryMode") ?? "live")],
    ["Heartbeat", heartbeatFact(field(monitor, "heartbeat"))],
    ["Twilio signature rejections", signatureFact(field(monitor, "twilioSignatureRejected"), when)],
    ...report,
    ["Next drill", isoField(monitor, "nextDrillAt") === null ? "drill off" : when(isoField(monitor, "nextDrillAt"))],
  ];
}

/** Shown in the operator view when a refresh fails while older data stays on screen. */
export const refreshFailedText = (loadedAt: string | null, when: Format): string =>
  `Could not refresh. Showing data from ${when(loadedAt)}; it may be out of date.`;

/**
 * Where focus goes when the operator view swaps between the key form and the data: the key field when the form comes
 * back, the "Monitor" heading when the data appears. Only when focus was inside the part being hidden (a submitted key,
 * "Forget key", or a Refresh the server refused with 401); otherwise focus stays where it is, so a swap the user did
 * not start never moves it. Without this the browser drops focus to <body> (WCAG 2.4.3).
 */
export function focusAfterSwap(shown: "form" | "data", focusWasInHidden: boolean): "view-key" | "private-monitor-heading" | null {
  if (!focusWasInHidden) return null;
  return shown === "form" ? "view-key" : "private-monitor-heading";
}
