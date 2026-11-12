# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org).

## 0.3.0 - 2026-11-12

### Changed

- The status page is rebuilt as a React app on [TUFFUI](https://tuffui.com) components (Surface, Status Pill, Stat
  Grid, Tick Gauge, Chart Card, Data Table, Disclosure, Tab Panels, Text Field, Action Button, Empty State, Loading
  Skeleton), added with the shadcn CLI and built with Vite and Tailwind CSS v4. It leads with what is affected right
  now and when the monitor last checked (a live "12 s ago"), then each service with its uptime bars and every
  operation checked, a sortable table of every check, response times, incidents and how status is decided. The CSP
  is unchanged: the build emits only files (no inline script or style), fonts stay self-hosted. The operator view is
  a separate chunk loaded when opened, with tabs for checks, incidents, notifications, contacts, maintenance and the
  deep payload.
- The acknowledgement pages' `styles.css` now carries only what they use, restyled to match.
- `spec/PROTOCOL.md`: a status page MAY show a deep check's sub-check ids, statuses and latencies publicly; `value`,
  `detail` and `release` stay private.

### Added

- `/api/status` gives each component `lastCheckedAt` and `checks` (id, kind `http`/`dns`/`deep`/`part`, status,
  latency, `checkedAt`; a deep check's sub-checks that no other component claims are listed under it), and `monitor`
  gives `staleAfterSeconds` and `rules` (`openAfterFailures`, `resolveAfterPasses`). The public path reads
  `check_latest` (one row per check); still no run history or logs.

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
