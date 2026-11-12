# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org).

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
