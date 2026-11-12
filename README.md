# status-monitor

A serverless uptime monitor and pager that runs entirely on Cloudflare Workers. It checks your services every minute
and pages people by SMS and email through tiered escalation. Responders acknowledge by replying to the text, and the
monitor publishes a public status page. There is no server or database for you to run and patch, and nothing to watch
besides the monitor itself.

- **Checks every minute**: HTTP (manual redirect handling, loop and downgrade detection, TLS classification, body and
  latency rules), DNS over HTTPS (including "is this record still DNS-only?"), and an optional signed **deep health
  check** that sees inside your platform without exposing it.
- **Pages, not just notifications**: ordered tiers with acknowledgement timeouts, repeat cycles, reminders after paging
  stops, and failover to a contact's other channel. A wave of failing components is grouped into one escalation with
  one ACK code.
- **Acknowledge by SMS reply** (`ACK K7M2QX`) or from a signed email link. Every contact who was already paged is told
  who has it.
- **A weekly paging drill**, delivery confirmation through Twilio status callbacks, opt-out handling (STOP/START), and,
  with the optional platform integration, maintenance windows.
- **A status page** on Workers Static Assets: whether everything is working, current problems and planned
  maintenance, every service's last 30 days and past incidents, plus an operator view behind Cloudflare Access or a
  key.
- **Fails closed**: an invalid configuration stops the run, so an outside dead-man's switch notices. The monitor never
  limps along half-configured.

It was built for, and is used by, [Nclusive](https://getnclusive.com).

> **Status:** 0.1.0, the first public release. See [CHANGELOG.md](CHANGELOG.md) and the maintenance policy below.

## Contents

- [Why another monitor?](#why-another-monitor)
- [Architecture](#architecture)
- [Quick start (standalone)](#quick-start-standalone)
- [Configuration reference](#configuration-reference)
- [Operator sign-in](#operator-sign-in)
- [Escalation](#escalation)
- [Platform integration (optional)](#platform-integration-optional)
- [Operations](#operations)
- [What this cannot detect](#what-this-cannot-detect)
- [Security](#security)
- [Maintenance policy](#maintenance-policy)
- [Disclaimer](#disclaimer)
- [License](#license)

## Why another monitor?

Projects that page well need an always-on server and a database. Projects that run on serverless platforms usually
send one-way alerts only. We wanted escalation with SMS-reply acknowledgement, on infrastructure that has no host of its
own to keep alive, plus a signed way to check a platform's internals. These projects are excellent and shaped this one.
We credit them here and say why we did not simply adopt them.

| Project | What it does well | Why we did not adopt it | What we borrowed (ideas only, no code) |
| --- | --- | --- | --- |
| [UptimeFlare](https://github.com/lyc8503/UptimeFlare) | Uptime checks and a status page on Cloudflare Workers, the same hosting model as ours | No escalation, acknowledgement, inbound SMS, DNS-record checks or signed checks: its scope is a status page | Proof that Workers and Durable Objects make a solid monitoring host |
| [GoAlert](https://github.com/target/goalert) | A real pager: SMS-reply acknowledgement grammar, Twilio signature validation, escalation repeat counts | Needs a Go server and PostgreSQL: one more host that must itself be monitored. No probing and no status page | The SMS reply grammar, a per-number reply limiter, delivery-status callbacks |
| [Gatus](https://github.com/TwiN/gatus) | A clean check model, maintenance windows, push heartbeats | Needs a server. Twilio alerts are one-way, to a single number | The DNS check shape, minimum reminder intervals, maintenance windows |
| [OneUptime](https://github.com/OneUptime/oneuptime) | The most complete all-in-one platform | Needs a large server. Acknowledgement is by link only, with no SMS reply. Open-core | Escalation vocabulary: per-level wait, "repeat from level 1 N times", "escalate now" |
| [Upptime](https://github.com/upptime/upptime) | Monitoring and a status page with nothing but GitHub Actions and Pages | Scheduled Actions have a 5-minute floor, and scheduled runs may be dropped: too coarse and too uncertain for paging | The example of a monitor with no server at all |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | A friendly self-hosted monitor with many notification channels | A long-running host, and one-way notifications | Nothing specific; it set the bar for ease of use |

For the outside dead-man's switch that watches this monitor, we recommend
[Healthchecks.io](https://healthchecks.io) (or self-hosted [Healthchecks](https://github.com/healthchecks/healthchecks),
somewhere other than Cloudflare). See [What this cannot detect](#what-this-cannot-detect).

## Architecture

```text
                       cron "* * * * *"
                              |
                              v
  +---------------------------------------------+   http / dns / signed deep checks
  | Worker "status-monitor"                     |-----------------------------------> your services
  |  no workers.dev, no preview URLs, no routes |
  |  (unreachable from the internet)            |   optional: signed config pull and report
  |                                             |-----------------------------------> your platform
  |  scheduled(): load config (fail closed)     |
  |   -> run checks (5 connections at a time)   |   SMS                +-------------------+
  |   -> MonitorObject.ingest()                 |--------------------> | Twilio            |
  |   -> ping HEARTBEAT_URL                     |   email (binding)    +-------------------+
  |                                             |--------------------> Cloudflare Email Service
  |  MonitorObject: one SQLite Durable Object,  |
  |   jurisdiction "us": 35 days of history,    |   heartbeat          +-------------------+
  |   incidents, escalation state, outbox;      |--------------------> | Healthchecks.io   |
  |   its alarm drives deadlines and retries    |                      +-------------------+
  +---------------------------------------------+
                 ^ service binding MONITOR (the only way in)
                 |
  +---------------------------------------------+
  | Worker "status-page"                        |  <- https://status.example.com (custom domain)
  |  Static Assets: index.html, app.js, CSS     |
  |  worker/router.ts runs first for:           |
  |   GET  /api/status        public, cached    |
  |   GET  /api/private       Bearer key        |
  |   GET|POST /ack/*         confirm page      |
  |   POST /hooks/twilio      inbound SMS       |
  |   POST /hooks/twilio-status delivery status |
  +---------------------------------------------+
```

| Path | What it is |
| --- | --- |
| `worker/index.ts` | Cron entry, config pull and report, and the router behind the service binding |
| `worker/monitor-object.ts`, `worker/store*.ts`, `worker/schema.ts` | The Durable Object, its SQLite schema, history, incidents and their groups, and the outbox |
| `worker/engine.ts`, `worker/escalation.ts` | Component state (open after 2 failing runs, resolve after 3 passing runs, flap detection) and the pure escalation state machine |
| `worker/checks/` | `http.ts`, `dns.ts`, `deep.ts` (signed client) and `run.ts` (the connection limiter) |
| `worker/notify/`, `worker/deliver.ts` | Twilio, Email Service, the message composer (two-segment SMS budget) and delivery routing |
| `worker/signature.ts`, `spec/` | The signed protocol, its specification and the shared test vectors |
| `worker/config*.ts`, `worker/brand.ts` | Strict config loading; `BRAND_NAME` |
| `worker/platform-config.ts`, `worker/report.ts` | Optional platform integration: config pull, revision acceptance, report |
| `status-page/` | The status page Worker (`worker/router.ts`) and the page: a React app in `src/` built with Vite, on [shadcn/ui](https://ui.shadcn.com) components, with [TUFFUI](https://tuffui.com) charts in the operator view (`src/components/ui`, added with the shadcn CLI, `components.json`), line icons from Lucide stored as SVG (`src/icons`, `scripts/icons.ts`), and `public/` (fonts, the default `brand/`, `_headers`, the acknowledgement pages' `styles.css`) |
| `config/*.example.json` | Example targets, escalation policy and platform configuration document |

## Quick start (standalone)

Standalone mode is the default and the most common way to run it: everything is configured on the Worker, with no
other system involved.

**You need:** a Cloudflare account on the Workers Paid plan (Email Service sends to arbitrary recipients only on paid
plans), a zone on that account for the status page hostname, Node.js 24.20 or later (below 25), and, for SMS, a Twilio
account with a sending number or Messaging Service. Email-only paging works without Twilio.

1. **Get the code and check it.**

   ```sh
   git clone https://github.com/nclusive-scan/status-monitor.git
   cd status-monitor
   npm ci && npm run check
   ```

2. **Describe what to watch.** Edit `MONITOR_TARGETS` in `wrangler.jsonc` (the same shape as
   `config/targets.example.json`; `test/config.test.ts` keeps the two identical, so update both or adjust the test).
   Set `STATUS_PAGE_URL` and `TWILIO_WEBHOOK_URL` to your status page hostname, and optionally `BRAND_NAME`.

3. **Set up email.** Onboard your sending domain in the Cloudflare dashboard (Email Service > Email Sending), then put
   the sender address in both `send_email[0].allowed_sender_addresses` and `ALERT_EMAIL_FROM` in `wrangler.jsonc`.
   They must match.

4. **Write the escalation policy** to a local file that you never commit, starting from
   `config/escalation.example.json`, and store it as a secret:

   ```sh
   npx wrangler secret put ESCALATION_POLICY < escalation.json
   ```

5. **Set the keys and provider secrets.** Each key must be at least 32 bytes. Use a different value for each, and store
   them with no trailing newline:

   ```sh
   openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put ACK_SIGNING_KEY
   openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put STATUS_VIEW_KEY   # keep a copy: it opens the operator view
   npx wrangler secret put TWILIO_ACCOUNT_SID
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put TWILIO_FROM            # or TWILIO_MESSAGING_SERVICE_SID
   ```

6. **Deploy the monitor:** `npx wrangler deploy`. It has no public address. Never rename the `MonitorObject` class or
   change its jurisdiction after this first deploy: either one starts a new, empty object.

7. **Deploy the status page.** In `status-page/wrangler.jsonc`, uncomment the `routes` example and set your hostname
   (the same as `STATUS_PAGE_URL`). Then:

   ```sh
   npm run build:status-page
   npx wrangler deploy --config status-page/wrangler.jsonc
   ```

   To use your own logo and favicons, point `STATUS_PAGE_BRAND_DIR` at a directory holding `logo.svg` (shown on
   light), `logo-dark.svg` (on dark), `favicon.svg`, `favicon.ico` and `apple-touch-icon.png` (180 px) when you build:
   `STATUS_PAGE_BRAND_DIR=../my-brand npm run build:status-page`. The logo sits 20 px high beside `BRAND_NAME`.

8. **Point Twilio at it.** On the sending number, set the inbound messaging webhook to
   `https://<your status host>/hooks/twilio` (HTTP POST). It must equal `TWILIO_WEBHOOK_URL` exactly, because the
   signature is checked against that URL.

9. **Arm the outside heartbeat (do not skip this).** Create a check in Healthchecks.io (or similar) with a 1-minute
   period, about 5 minutes of grace, and alerts through its own channels (its app, SMS or voice, never this monitor's
   Twilio account or Cloudflare email). Store its ping URL as `HEARTBEAT_URL` and its `/fail` URL as
   `HEARTBEAT_FAIL_URL`. Until then, the monitor shows the `heartbeat_missing` warning.

10. **Test a real page end to end.** Use a policy containing only yourself, with `ackTimeoutMinutes: 1` and
    `maxCycles: 1`. Add a check that always fails (for example `https://<your status host>/does-not-exist`) and deploy.
    Within two minutes you get the page. Open the operator view (the "Operator view" button, then your
    `STATUS_VIEW_KEY`), reply `ACK <code>` by SMS, and watch the incident change. Remove the failing check: after three
    passing runs the incident resolves and you are told. Then restore your real policy.

`npm run dry-run` and `npm run dry-run:status-page` bundle both Workers without deploying anything.

## Configuration reference

Configuration fails closed. An invalid value, a missing or short key, or a contact channel without its provider stops
the run entirely (no checks, no pages, no heartbeat). The problem is recorded, the operator view shows it, the public
page shows the monitor as delayed, and your outside heartbeat alarms.

### Variables (`vars` in `wrangler.jsonc`)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MONITOR_TARGETS` | yes (standalone) | none | Components and checks (`config/targets.example.json`). In platform mode, the bootstrap until a first revision arrives |
| `STATUS_PAGE_URL` | yes | none | The public status page, `https://...`. Used in messages and acknowledgement links, and for Twilio's status callback (`<STATUS_PAGE_URL>/hooks/twilio-status`) |
| `TWILIO_WEBHOOK_URL` | yes | none | The exact URL Twilio posts inbound SMS to (`<STATUS_PAGE_URL>/hooks/twilio`) |
| `ALERT_EMAIL_FROM` | when a contact has an email address | none | The sender address. It must equal the `ALERT_EMAIL` binding's `allowed_sender_addresses` entry |
| `ALERT_EMAIL_FROM_NAME` | no | `<BRAND_NAME> Status` (`Status` for the default brand) | The email From name: 1 to 60 printable characters, no quotes or angle brackets |
| `BRAND_NAME` | no | `Status` | Shown as `[<BRAND_NAME>]` at the start of every SMS and email subject, as "Sent by the `<BRAND_NAME>` status monitor." in email footers, and as "`<BRAND_NAME>` status" in page titles. 1 to 24 characters: letters, digits, single spaces and `. , & ' ( ) + _ -`. The limit keeps every SMS within two GSM-7 segments; any other value refuses the configuration |
| `DELIVERY_MODE` | no | `live` | `live` calls Twilio and Email Service. `log` records every delivery without sending anything (local development) |
| `LOCAL_DEV` | no | unset | `true` only under `wrangler dev`, with `DELIVERY_MODE=log`: addresses the monitor object without a jurisdiction, which the local runtime lacks. Ignored when `DELIVERY_MODE` is `live` |
| `PLATFORM_CONFIG_URL` | no | unset (standalone) | `https://<host>/api/v2/monitor/config`. Turns on [platform integration](#platform-integration-optional) |
| `DEEP_CHECK_HOSTS` | for a deep check in standalone mode | the host of `PLATFORM_CONFIG_URL` | Comma-separated `host` or `host:port` values that a deep check may call (case-insensitive, `:443` ignored; a stray comma makes the whole value unusable) |
| `DNS_SECONDARY_RESOLVER` | no | none | A second DNS-over-HTTPS JSON resolver (for example `https://dns.google/resolve`), asked when Cloudflare's fails |
| `ACCESS_TEAM_DOMAIN` | no | unset | Your Cloudflare Access team domain, `<team>.cloudflareaccess.com`. With `ACCESS_AUD`, [operator sign-in through Access](#operator-sign-in) |
| `ACCESS_AUD` | no | unset | The Access application's audience (AUD) tag, 64 hex characters |

Every request the monitor sends (checks, config pull, report) carries a `User-Agent` of `status-monitor/1` and this
repository's URL, so the services you watch can tell it apart in their logs. If you run a modified fork, change
`USER_AGENT` in `worker/types.ts` to point at your fork.

### Bindings

| Binding | Meaning |
| --- | --- |
| `MONITOR_STATE` | The `MonitorObject` Durable Object (SQLite). Keep the class name and the `us` jurisdiction forever |
| `ALERT_EMAIL` | Cloudflare Email Service `send_email` binding, restricted to one sender. Required when a contact has an email address (in `live` mode) |
| `MONITOR` (status page) | Service binding to the monitor Worker. It must name the monitor's `name` |

### Secrets (`npx wrangler secret put <NAME>`)

| Secret | Required | Meaning |
| --- | --- | --- |
| `ESCALATION_POLICY` | yes (standalone) | The policy JSON (`config/escalation.example.json`). It holds people's numbers and addresses, which is why it is a secret |
| `ACK_SIGNING_KEY` | yes | Signs acknowledgement links. At least 32 bytes. Rotating it invalidates links already sent (SMS `ACK` still works) |
| `STATUS_VIEW_KEY` | no | The operator view key, at least 32 bytes. Absent or short: the operator view is off |
| `TWILIO_ACCOUNT_SID` | when a contact has `sms` | `AC...` |
| `TWILIO_AUTH_TOKEN` | when a contact has `sms` | Validates `X-Twilio-Signature` on both webhooks, and sends unless an API key is set |
| `TWILIO_AUTH_TOKEN_SECONDARY` | no | Also accepted for webhook signatures while you rotate the auth token |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | no | An `SK...` API key used for sending instead of the auth token. Set both or neither |
| `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | when a contact has `sms` | An E.164 sending number, or an `MG...` Messaging Service |
| `HEARTBEAT_URL` | strongly recommended | The outside dead-man's switch, pinged after every successful run. Without it a live monitor shows the `heartbeat_missing` warning |
| `HEARTBEAT_FAIL_URL` | no | A Healthchecks-style `/fail` URL, pinged instead while paging itself is failing |
| `MONITOR_HEALTH_KEY` | for a `deep` check | Signs the deep health check, at least 32 bytes ([spec](spec/PROTOCOL.md)) |
| `MONITOR_CONFIG_KEY` | platform mode | Signs the config pull and the report, at least 32 bytes, and different from `MONITOR_HEALTH_KEY` |

Signing keys are used byte for byte as stored. A key with leading or trailing whitespace is refused as a configuration
error, so store keys with `printf '%s'` or `tr -d '\n'`, never plain `echo`.

### Targets

```json
{
  "version": 1,
  "openAfterFailures": 2,
  "resolveAfterPasses": 3,
  "components": [{ "id": "website", "name": "Website", "alert": "page", "public": true }],
  "checks": [
    { "id": "website_http", "component": "website", "type": "http", "url": "https://example.com/", "expectStatus": 200 },
    { "id": "website_dns", "component": "website", "type": "dns", "hostname": "example.com", "dnsOnly": false },
    { "id": "platform_deep", "component": "website", "type": "deep", "url": "https://app.example.com/api/v2/monitor/health" }
  ]
}
```

- **http**: the URL must end in the expected status (default 200 to 299) within `maxRedirects` (default 5). Redirects
  are followed by hand: a URL seen twice is `redirect_loop`, too many hops is `too_many_redirects`, and a downgrade to
  http is `redirect_to_insecure`. Optional `bodyIncludes` text and `latencyDegradedMs` (a slow answer is `degraded`).
  On Cloudflare, a bad certificate shows as `tls_or_network`, because the runtime does not name TLS failures.
- **dns**: A and AAAA over DNS-over-HTTPS. NXDOMAIN, SERVFAIL or no address is `down`. With `dnsOnly: true` (the
  default), any address in Cloudflare's proxy ranges is `cloudflare_proxy_address`, which catches a record accidentally
  switched to proxied. Set `dnsOnly: false` for a host that is meant to be proxied.
  A failing resolver is inconclusive and counts neither way.
- **deep**: a signed request to your platform's `/api/v2/monitor/health` ([spec](spec/PROTOCOL.md#3-deep-health-get-apiv2monitorhealth)).
  It needs `MONITOR_HEALTH_KEY`, and its host must be on `DEEP_CHECK_HOSTS`.

Each component sets `pageOn` (`down` by default, or `degraded`), `alert` (`page` by default; `email` sends one
informational email to the first tier on open and one on resolve; `none` records only) and `public` (`true` by default;
`false` keeps it off the public page). An incident opens after `openAfterFailures` consecutive failing runs (or when a
component flaps) and resolves after `resolveAfterPasses` passing runs, so a single blip never pages anyone.

## Operator sign-in

The operator view lives at `/operator`, linked quietly from the page footer. There are two ways in:

- **Cloudflare Access (recommended).** In Zero Trust, add a self-hosted application for your status hostname with two
  paths, `/operator` and `/api/private`, an identity provider (Google, for example) and a policy naming who may sign in.
  Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` on the monitor. Access then asks people to sign in before the page loads,
  and the monitor verifies the token Access attaches to every `/api/private` request (RS256 with the team's published
  keys, the application's audience and issuer, and its expiry) before answering. A token that does not verify is
  refused, and so is every token while the team's keys cannot be read.
- **The operator key** (`STATUS_VIEW_KEY`). The page asks for it when there is no Access sign-in. Keep it as a
  break-glass way in even with Access; with Access in front of `/api/private`, only signed-in people can reach it.

## Escalation

The policy (`config/escalation.example.json`) is a list of ordered tiers. Each tier has an acknowledgement timeout and
contacts with `sms` and/or `email`. It also sets `maxCycles` (default 3), `ackLinkTtlMinutes`, `timeZone` (message times
are local, with UTC after them), `reminderMinutes` and the weekly `drill`.

1. An incident opens: every contact in the first tier is paged on each of their channels.
2. A tier times out without an acknowledgement: the next tier is paged, and everyone already paged is told who it went
   to (names only, never numbers).
3. After the last tier, the cycle starts again at the first tier, up to `maxCycles`.
4. After the last cycle, everyone gets a final "unacknowledged after N cycles" message and paging stops. The incident
   stays open, and everyone is reminded every `reminderMinutes` (default 60; 0 turns reminders off).
5. Anyone acknowledges, by replying `ACK <code>` from a contact's number or through the email link's confirm page.
   Paging stops, and everyone already paged is told who acknowledged.
6. The component recovers: everyone paged is told it is resolved.

A send that fails for good falls over to the contact's other channel. When every channel of every contact in the tier
being paged has failed for a reason about the contact (opted out, invalid number, suppressed address), the next tier is
paged at once. A provider-wide failure never escalates early, because it would fail every tier the same way. Incidents
that open while another is still paging, within 10 minutes, join its group: one escalation, one ACK code, and messages
that name the other affected components.

Urgent pages are never held for quiet hours.

## Platform integration (optional)

If you run your own platform, it can own the monitor's settings. Set `PLATFORM_CONFIG_URL` (and `MONITOR_CONFIG_KEY`),
and on every run the monitor pulls its escalation policy, targets, sender identities and maintenance windows with a
signed `GET`. It reports its state, contact health and resolved incidents back to the same origin with a signed `POST`,
so your platform can show them and archive incidents. The monitor keeps no inbound admin surface: configuration is
pulled, never pushed.

- A revision is accepted only when it validates with the monitor's own parsers, would leave the monitor usable, and is
  above the stored one. A platform outage or a bad document never stops monitoring: the monitor keeps its last known
  good revision.
- When a revision changes who is paged, every old and new email contact gets an informational email (the tamper
  signal).
- A platform `senders.emailFrom` is accepted only when it equals `ALERT_EMAIL_FROM`.
- Removing `PLATFORM_CONFIG_URL` returns the monitor to standalone mode. It then ignores any stored revision and uses
  `MONITOR_TARGETS` and `ESCALATION_POLICY`.

The wire protocol (canonical string, headers, key separation, replay and skew rules, the configuration document, the
report and refusal behaviour) is specified in [spec/PROTOCOL.md](spec/PROTOCOL.md), with shared test vectors in
[spec/vectors/signature-v2.json](spec/vectors/signature-v2.json) that a server implementation should pass.

## Operations

### Local development

Run with deliveries logged, never sent:

```sh
npx wrangler dev --port 8788 --test-scheduled --var DELIVERY_MODE:log --var LOCAL_DEV:true
curl "http://127.0.0.1:8788/__scheduled?cron=*+*+*+*+*"     # runs one cron tick
```

`LOCAL_DEV=true` is needed because the local runtime does not implement Durable Object jurisdictions: it addresses the
monitor object without the `us` jurisdiction. It only works together with `DELIVERY_MODE=log`, so a live deployment
always uses the jurisdiction.

You can instead put `DELIVERY_MODE=log` in a git-ignored `.dev.vars` file. Use test values only, never real
credentials. **Without `DELIVERY_MODE=log`, an incident calls the real Twilio API** with whatever credentials
`.dev.vars` holds. In `log` mode every delivery is recorded in the outbox and the log, with the recipient masked, and
shown as "logged, not sent" in the operator view. To try the page against the local monitor, run
`npm run build:status-page`, then, in a second terminal, `npx wrangler dev -c status-page/wrangler.jsonc --port 8787`
(it finds the running monitor through Wrangler's local registry) and open http://127.0.0.1:8787. For a local copy of
the page config, drop its `routes`.

### Email prerequisites

- **Leave "Drop suppressed recipients" off** for the sending domain (the default). With it off, a send to a suppressed
  address fails with `E_RECIPIENT_SUPPRESSED`: the monitor records it, tells the first tier, and falls over to SMS.
  With it on, Email Service silently drops the message and reports success.
- Keep exactly one `_dmarc` record when onboarding adds its own.

### Warnings

None of these stops monitoring. They appear in the operator view (and in the report in platform mode):
`heartbeat_missing`, `contact_single_channel:<contact>`, `tier_single_contact:<tier>`, `drill_disabled`,
`email_alert_no_recipient`, `dns_inconclusive`, `email_channel_failing:<code>`, `sms_channel_failing:<code>`,
`sms_delivery_unknown` and `incidents_pruned_unexported`.

### Key rotation

- `STATUS_VIEW_KEY`: put a new value; operators enter the new key.
- `ACK_SIGNING_KEY`: rotating invalidates acknowledgement links already sent. Prefer a quiet period.
- Twilio auth token: create a secondary token in the Twilio console and set it as `TWILIO_AUTH_TOKEN_SECONDARY`.
  Promote it in the console, then move it to `TWILIO_AUTH_TOKEN` and remove the secondary. If you send with the auth
  token rather than an API key, sends fail between the promotion and that update, so do the two steps together.
- `MONITOR_HEALTH_KEY` / `MONITOR_CONFIG_KEY`: have your server accept the previous value next to the new one, update
  the Worker, then retire the old value ([spec](spec/PROTOCOL.md#1-keys)).

### Failure modes

| Failure | Behaviour |
| --- | --- |
| Invalid configuration, missing or short key | The run stops: no checks, no pages, no heartbeat. The operator view names the problem, the public page says monitoring is delayed, and the outside heartbeat alarms |
| The monitor stops running (Worker error, Cloudflare incident) | `lastRunAt` goes stale. After 5 minutes the page says monitoring is delayed and shows components as unknown, and the outside heartbeat alarms |
| Twilio down or refusing | SMS rows fail and retry with backoff (30 s doubling to 15 minutes, 8 attempts). Email rows are independent and still go out. A page that fails for good, or waits more than 5 minutes, switches the heartbeat to `HEARTBEAT_FAIL_URL` |
| Email Service rate-limited or unavailable | Email rows fail and retry. SMS still goes out. Codes that will not succeed on retry (sender not verified, suppressed recipient, daily limit) are not retried and show in the operator view |
| "Drop suppressed recipients" turned on for the sending domain | Pages to a suppressed address are reported as sent and never arrive, with no contact-health change, failover or warning. Keep the setting off |
| A provider failing for every recipient (credentials, sender, registration) | No early escalation: tiers move on at their deadlines, so paging is still running when the provider recovers. The other channel still goes out, the `sms_channel_failing` or `email_channel_failing` warning shows, and the first tier is told on the other channel, at most hourly |
| An escalation step or the alarm's bookkeeping throws | The alarm is re-armed anyway (falling back to 30 s), so the alarm chain never ends on an error |
| Durable Object alarm lost or delayed | Every cron run also advances due escalation steps. A late step restarts its timeout instead of bursting through several tiers |
| Several origins hang | Checks run 5 connections at a time, each timing out from when it starts, so the healthy checks behind them still pass |
| DNS-over-HTTPS resolver unavailable | The second resolver is asked when configured. Otherwise DNS results are inconclusive and change no component state; after 15 minutes the `dns_inconclusive` warning goes out, with one email to the first tier |
| Many components fail at once | One group of paging components: one page per contact and channel, one code, one acknowledgement |
| `/api/status` traffic spike during an incident | Answered from the edge cache and the object's 15-second cache. The public path never reads run history or logs, so checks and alarms are not starved |
| Crash during a delivery | A claimed row is retried after its claim expires (3 minutes), so a crash during a provider call can repeat that one message. No escalation step is ever generated twice |
| Platform mode: platform down or a bad document saved | The monitor keeps running on its last known good revision. A document that would leave it unusable is refused (`config_unusable`), never applied |

### Retention

Run history is kept for 35 days. In standalone mode, resolved incidents are kept for 35 days. In platform mode, a
resolved incident is pruned at 35 days only once the platform has archived it. An incident the platform never
archived is kept up to 180 days, then pruned with the `incidents_pruned_unexported` warning.

## What this cannot detect

The monitor, the status page, alert email, the DNS-over-HTTPS resolver (by default) and Durable Object alarms all run
on Cloudflare. **This is not an independent monitor of Cloudflare.** A Cloudflare incident affecting Workers, cron
triggers or Durable Objects is an outage of the monitor itself, and you may not be able to deploy or log in while it
lasts.

Only something outside Cloudflare can notice that. This is why `HEARTBEAT_URL` exists: point it at a dead-man's switch
hosted elsewhere, such as [Healthchecks.io](https://healthchecks.io), that alerts you through its own channels when the
pings stop. Treat a missing heartbeat as a go-live blocker.

It also cannot see what its checks do not ask: it knows only what HTTP, DNS and your deep health endpoint tell it, from
Cloudflare's network. Probes leave from varying Cloudflare locations, so your firewall or geo rules must allow them.

## Security

- The monitor Worker has no public route. The status page Worker is its only caller and forwards only the five paths
  above, with only the headers each one needs.
- `/api/status` is sanitized: component names, status, uptime (with 30 days of daily uptime and 24 hours of hourly
  latency per component), the operations checked for each public component (each check's id, kind, status, response
  time and when it last ran, a deep check's sub-checks by id), the rules that open and resolve an incident, incident
  titles and times, and whether an incident is acknowledged. Never URLs, hostnames, detail codes, deep values or
  release data. `/api/private` requires
  the operator key in an `Authorization` header, compared in constant time. The page keeps the key in `sessionStorage`
  only, never in a URL.
- Acknowledgement links are HMAC-signed, expire, and name one incident and one contact. Opening a link only shows a
  confirm page, so link scanners cannot acknowledge anything.
- Inbound SMS is accepted only with a valid `X-Twilio-Signature` for the exact public URL, and only from a number in the
  policy.
- The status page loads nothing external and sets a strict CSP. With Cloudflare Access configured, the operator view and `/api/private` sit behind your identity provider, and the monitor verifies Access's token itself.

Please report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Maintenance policy

- This is maintained on a best-effort basis, with no support SLA. Issues and pull requests are welcome
  ([CONTRIBUTING.md](CONTRIBUTING.md)).
- Releases follow [Semantic Versioning](https://semver.org). A change to the signed protocol, the configuration
  document's schema, or anything that needs a Durable Object migration is a major release.
- Only the latest release receives security fixes.
- Dependencies are updated weekly through Dependabot. The Workers `compatibility_date` is reviewed periodically.
- Vendor facts in this README (plans, Email Service behaviour, Twilio rules) were accurate at the time of writing.
  Check them against current vendor documentation.

## Disclaimer

This software is provided **"AS IS"**, without warranties or conditions of any kind (see the
[Apache License 2.0](LICENSE), sections 7 and 8). In particular:

- **It is not a medical device** and is not intended for diagnosing, treating or monitoring patients.
- **It does not by itself make a deployment HIPAA compliant** (or compliant with any other regulation). Compliance
  depends on how you deploy, operate and govern it.
- **It is designed to carry no PHI.** Never put patient data, or any other sensitive personal information, in
  component names, incident titles, check URLs, maintenance notes or anything else in its configuration. That text can
  reach SMS, email and a public status page.
- **Adopters own their own risk analysis and their agreements with vendors**, including any Business Associate
  Agreements with Cloudflare, Twilio or others, and the decision whether this tool fits their obligations.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
