// Responses the Worker hands back through the status page's binding. The static _headers file does not apply to
// Worker responses, so every response here carries its own security headers.
import { withNoun } from "./brand.ts";
import { formatAlertTime } from "./time.ts";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export function json(body: unknown, status = 200, cache = "no-store"): Response {
  return jsonText(JSON.stringify(body), status, cache);
}

/** A body that is already JSON text. */
export function jsonText(body: string, status = 200, cache = "no-store"): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": cache },
  });
}

export const notFound = (): Response => json({ error: "not_found" }, 404);

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${String(character.charCodeAt(0))};`);
}

/** An HTML page titled "<title> · <brand> status" (BRAND_NAME, brand.ts). */
export function html(brand: string, title: string, body: string, status = 200): Response {
  const site = escapeHtml(withNoun(brand, "status"));
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${site}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="page narrow">
<p class="eyebrow"><a href="/">${site}</a></p>
${body}
</main>
</body>
</html>`;
  return new Response(page, { status, headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export interface AckPageIncident {
  readonly title: string;
  readonly openedAt: number;
  readonly acknowledged: boolean;
  readonly resolved: boolean;
  /** A drill page offers no escalation. */
  readonly drill?: boolean;
  /** policy.timeZone for the "open since" time (default UTC). */
  readonly timeZone?: string;
}

/**
 * GET: a confirm page. Its buttons POST back to the same URL (form field action=ack or action=escalate); nothing is
 * acknowledged or escalated by opening the link.
 */
export function ackConfirmPage(incident: AckPageIncident, brand: string): Response {
  const opened = formatAlertTime(incident.openedAt, incident.timeZone ?? "UTC");
  if (incident.resolved) return html(brand, "Resolved", `<h1>Already resolved</h1><p>${escapeHtml(incident.title)} recovered. Nothing to acknowledge.</p>`);
  if (incident.acknowledged) return html(brand, "Acknowledged", `<h1>Already acknowledged</h1><p>${escapeHtml(incident.title)} has been acknowledged.</p>`);
  const escalate = incident.drill === true
    ? ""
    : `
<p>Can't take it? Escalating pages the next tier now, without waiting for the timeout.</p>
<form method="post"><button type="submit" name="action" value="escalate" class="button secondary">Escalate to the next tier</button></form>`;
  return html(
    brand,
    "Acknowledge incident",
    `<h1>Acknowledge this incident?</h1>
<p><strong>${escapeHtml(incident.title)}</strong>, open since ${escapeHtml(opened)}.</p>
<p>Acknowledging stops paging and tells everyone already paged that you have it.</p>
<form method="post"><button type="submit" name="action" value="ack" class="button">Acknowledge</button></form>${escalate}`,
  );
}

/** After the escalate button: what happened. */
export function escalateResultPage(outcome: string, tierName: string | null, brand: string): Response {
  switch (outcome) {
    case "escalated":
      return html(brand, "Escalated", tierName === null
        ? "<h1>Escalated</h1><p>Every tier has now been tried. Everyone in every tier is being told the incident is still unacknowledged.</p>"
        : `<h1>Escalated</h1><p>Now paging ${escapeHtml(tierName)}. Everyone already paged is being told.</p>`);
    case "already_acknowledged":
      return html(brand, "Acknowledged", "<h1>Already acknowledged</h1><p>Someone acknowledged this incident; nothing to escalate.</p>");
    case "exhausted":
      return html(brand, "Paging stopped", "<h1>Every tier has been tried</h1><p>Paging already went through every tier. You can still acknowledge it.</p>");
    case "resolved":
      return html(brand, "Resolved", "<h1>Already resolved</h1><p>The incident recovered. Nothing to escalate.</p>");
    default:
      return invalidAckPage(brand);
  }
}

export function ackResultPage(outcome: string, brand: string): Response {
  switch (outcome) {
    case "acknowledged":
      return html(brand, "Acknowledged", "<h1>Acknowledged</h1><p>Paging has stopped. Everyone already paged has been told you have it.</p>");
    case "already_acknowledged":
      return html(brand, "Acknowledged", "<h1>Already acknowledged</h1><p>Someone acknowledged this incident first.</p>");
    case "resolved":
      return html(brand, "Resolved", "<h1>Already resolved</h1><p>The incident recovered before it was acknowledged.</p>");
    default:
      return invalidAckPage(brand);
  }
}

export const invalidAckPage = (brand: string): Response =>
  html(brand, "Link not valid", "<h1>This link is not valid</h1><p>It may have expired. Reply to the page by SMS with the ACK code instead.</p>", 404);

export function twiml(message: string | null): Response {
  const body = message === null ? "<Response/>" : `<Response><Message>${escapeHtml(message)}</Message></Response>`;
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
