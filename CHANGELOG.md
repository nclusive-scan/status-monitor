# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org).

## 0.3.0 - 2026-11-12

### Changed

- The public status page answers two questions first: is everything working, and is there anything to know. One
  status sentence with when it was last updated, then current notices (open problems and planned maintenance, in
  plain words), then every service as one row with its status, what is not working when it is not, and 30 daily
  uptime bars, then past incidents. Plain wording throughout ("Partial outage", "Being fixed"), times with their zone.
- Built as a React app with Vite and Tailwind CSS v4 on [shadcn/ui](https://ui.shadcn.com) components. The operator
  view keeps the charts, from [TUFFUI](https://tuffui.com) (stat grid, uptime gauge, response-time chart), restyled
  as plain hairline cards. Line icons from Lucide are stored in the repository as SVG; no icon library loads.
- The operator view moved to its own path, `/operator`, linked quietly from the footer, so it can sit behind
  Cloudflare Access. It loads only there.
- The CSP is unchanged: the build emits only files and refuses a page with inline script or style.
- The acknowledgement pages' `styles.css` now carries only what they use, restyled to match.
- `spec/PROTOCOL.md`: a status page MAY show a deep check's sub-check ids, statuses and latencies publicly; `value`,
  `detail` and `release` stay private.

### Added

- Operator sign-in through Cloudflare Access: with `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, `/api/private` accepts
  the token Access attaches once someone has signed in (Google or any identity provider), verified against the team's
  keys. The operator key still works.
- Branding: a logo and favicons (`favicon.ico`, `favicon.svg`, `apple-touch-icon.png`), neutral by default and
  replaced at build time from `STATUS_PAGE_BRAND_DIR`.
- `/api/status` gives each component `lastCheckedAt` and `checks` (id, kind `http`/`dns`/`deep`/`part`, status,
  latency, `checkedAt`), each incident its `impact` (`down` or `degraded`), and `monitor` gives `staleAfterSeconds` and
  `rules`. The public path reads `check_latest` (one row per check); still no run history or logs.

## 0.2.0 - 2026-11-12

### Added

- A redesigned, data-first status page: an overall status card with four headline numbers (30-day uptime, 24-hour
  average response, components operational, incidents in 30 days), 30 daily uptime bars per component with a legend
  and per-day tooltips, 24-hour response-time charts with a hover crosshair, and an incident timeline with durations.
  Light and dark themes follow the system setting, with a toggle kept on the device. Geist and Geist Mono are
  self-hosted under the SIL Open Font License (`status-page/public/fonts/OFL.txt`); the CSPs allow `font-src 'self'`.
- `/api/status` and `/api/private` give each component `history` (30 UTC days of daily uptime, today last) and
  `latency` (24 hours of hourly average and maximum response time, the current hour last), read from the hourly
  rollups. Schema migration 9 adds the latency columns; hours rolled up before it show no latency.

## 0.1.1 - 2026-11-12

### Fixed

- The monitor Worker could not start on Cloudflare: its entry module exported plain constants (`MONITOR_JURISDICTION`,
  `MONITOR_OBJECT_NAME`) next to its handler, and the Workers runtime refuses any entry export that is not a handler
  or class. The bundling dry runs did not notice. The addressing moved to `worker/monitor-id.ts`, a test pins the
  entry module's exports, and CI now starts the monitor in the local Workers runtime.
- Local development (`wrangler dev`) failed on every request because the local runtime does not implement Durable
  Object jurisdictions. `LOCAL_DEV=true`, honoured only with `DELIVERY_MODE=log`, addresses the object without one.

## 0.1.0 - 2026-11-12

First public release.

### Added

- The monitor Worker: HTTP, DNS-over-HTTPS and signed deep health checks every minute; incidents with flap detection;
  tiered escalation with cycles, reminders, failover and grouped outages; SMS (Twilio) and email (Cloudflare Email
  Service) paging; acknowledgement by SMS reply or signed email link; a weekly paging drill; delivery confirmation and
  opt-out handling.
- The status page Worker: a public status page and a key-protected operator view.
- Standalone mode, the default: the Worker's own settings (`MONITOR_TARGETS`, `ESCALATION_POLICY`) are the whole
  configuration.
- Optional platform integration: signed configuration pull and report (`PLATFORM_CONFIG_URL`), specified in
  `spec/PROTOCOL.md` (protocol version 2), with shared test vectors.
- Configurable branding (`BRAND_NAME`) and alert sender (`ALERT_EMAIL_FROM`, `ALERT_EMAIL_FROM_NAME`).
