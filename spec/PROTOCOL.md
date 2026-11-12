# Status monitor signed protocol, version 2

This document specifies how the status monitor talks to the platform it watches when the operator turns on the
optional platform integration. It covers three HTTPS requests that the monitor sends and the platform answers:

| Request | Purpose | Key |
| --- | --- | --- |
| `GET /api/v2/monitor/health` | Deep health check: aggregate health of the platform's internals | HEALTH |
| `GET /api/v2/monitor/config` | Configuration pull: escalation policy, check targets, senders, maintenance windows | CONFIG |
| `POST /api/v2/monitor/report` | Report: the monitor's state, contact health and resolved incidents for archiving | CONFIG |

A monitor running standalone (no `PLATFORM_CONFIG_URL`) sends none of the configuration or report requests. It sends
the deep health check only when its targets include a `deep` check.

The monitor in this repository is the reference client. A platform implements the server side. Nothing in this
protocol requires the server to run on any particular stack.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT
RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14
([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and
only when, they appear in all capitals, as shown here.

## 1. Keys

There are two keys, each a shared secret held by both the monitor and the server:

- The **HEALTH** key signs the deep health check. Anyone who holds it can read the health counts and nothing else.
- The **CONFIG** key signs the configuration pull and the report. Anyone who holds it can read every contact's name,
  phone number and email address, and can write reports.

Key separation requirements:

- Each key MUST be at least 32 bytes.
- The two keys MUST have different values. The monitor refuses to run with the same value in both (`MONITOR_CONFIG_KEY:
  must differ from MONITOR_HEALTH_KEY`), and a server SHOULD refuse to start with the same value in both.
- A key is the UTF-8 bytes of the secret exactly as stored. Neither side trims it. A key with leading or trailing
  whitespace MUST be treated as a configuration error, never silently trimmed. (Store keys with `printf '%s'`, not
  `echo`, which adds a newline.)
- The server MUST verify each path only with the key of that path's purpose: a config or report request signed with
  the HEALTH key MUST be refused, and so MUST a health request signed with the CONFIG key.
- A server MAY accept a previous key of the same purpose next to the current one during a rotation. With no usable
  current key, the path MUST be treated as off.

On the monitor, the keys are the Worker secrets `MONITOR_HEALTH_KEY` and `MONITOR_CONFIG_KEY`.

## 2. Signing a request

### 2.1 Headers

Every request carries exactly these three headers:

| Header | Value |
| --- | --- |
| `X-Status-Monitor-Timestamp` | Unix time in whole seconds, ASCII digits only |
| `X-Status-Monitor-Nonce` | 32 lowercase hexadecimal characters (16 random bytes), new for every request |
| `X-Status-Monitor-Signature` | `v2=` followed by the lowercase hexadecimal HMAC-SHA256 of the canonical string |

### 2.2 Canonical string

The canonical string is UTF-8: seven lines joined with a single LF (`\n`), with no trailing LF:

```text
v2
<METHOD, uppercase>
<authority>
<path>
<timestamp>
<nonce>
<body hash>
```

- **METHOD** is the HTTP method in uppercase (`GET`, `HEAD`, `POST`). `HEAD` signs `HEAD`.
- **authority** is the lowercase host the client called, followed by `:port` only when the port is not 443.
- **path** is the request path without the query. A request MUST NOT have a query (see 2.4).
- **timestamp** and **nonce** are the header values, byte for byte.
- **body hash** is the lowercase hexadecimal SHA-256 of the exact body bytes as sent. For a request with no body (`GET`,
  `HEAD`), it is the SHA-256 of the empty string,
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

The signature is `HMAC-SHA256(key, canonical string)`, written as 64 lowercase hexadecimal characters.

Binding the authority means that a signature captured by one host cannot be replayed to another. Binding the body means
that a report cannot be changed in flight.

### 2.3 Client requirements

The client:

- MUST use `https`, with no credentials in the URL, no query and no fragment. The reference client refuses to sign any
  other URL.
- MUST generate a fresh nonce for every request, from a cryptographically secure random source.
- MUST NOT follow redirects (the reference client uses `redirect: "manual"`), so that a signed request is never resent
  somewhere else.
- SHOULD send `Cache-Control: no-store` semantics (`cache: "no-store"`).

### 2.4 Server verification

The server MUST refuse a request when any of the following holds:

1. No usable key is configured for the path, or no allowed authority is configured. The path is then off.
2. The request target contains a `?`, even if the query was signed.
3. A signature header is missing, repeated or malformed: a timestamp that is not all digits, a nonce that is not 32
   lowercase hexadecimal characters, or a signature that is not `v2=` followed by 64 lowercase hexadecimal characters.
   A `v1=` prefix, or uppercase hexadecimal, is malformed.
4. The timestamp is more than 60 seconds away from the server's clock, in either direction.
5. For a report, the body is larger than 64 KiB (65,536 bytes).
6. The signature matches no allowed authority under any accepted key of the path's purpose. The server MUST compare
   signatures in constant time.
7. The nonce was already accepted within the last 122 seconds. That window is longer than the 121 seconds in which a
   timestamp can be accepted.

**Allowed authorities.** The server MUST NOT take the authority from the `Host` header, because a proxy or rewrite may
change it. It MUST keep a configured list of the public authorities the monitor calls and accept a signature that
matches one of them. Entries are compared after trimming, in lowercase, with `:443` dropped. An empty entry (a stray
comma) SHOULD make the whole list unusable, so that one value always means the same set of hosts on both sides. The
monitor's own allowlist for deep checks (`DEEP_CHECK_HOSTS`) is read the same way, except that it also refuses a
single-label host such as `localhost`, which a Worker cannot call.

**Refusal behaviour.** The server MUST answer a refused request exactly as it answers an unknown path. Nothing in the
response may tell a caller which rule failed. Depending on the stack, that answer is usually `401` for an anonymous
caller such as the monitor, `404`, or an edge `403`. The monitor therefore reads `401`, `403` and `404` as "rejected or
not deployed" (`deep_rejected_or_missing`, `config_rejected_or_missing`, `report_rejected_or_missing`). A server SHOULD
log refusals that carried signature headers, with a reason code and the path but never a header value.

**Replay across instances.** A nonce cache kept per server instance lets a captured request be replayed once to each
other instance within its window. A server running on more than one instance SHOULD share its nonce store. A replayed
health or config read returns what it returned before. A replayed report MUST change nothing (see 5.3).

### 2.5 Test vectors

[`vectors/signature-v2.json`](vectors/signature-v2.json) contains the shared vectors:

- `signatures`: inputs, the exact canonical string and the expected `X-Status-Monitor-Signature` value. The cases cover
  both keys, a JSON body, a body with a non-ASCII character (hashed as UTF-8 bytes) and a non-default port.
- `verifications`: complete requests that a server holding `server` (its keys, allowed hosts, clock and skew) MUST
  accept or refuse, each refusal with its reason. The cases cover a disallowed host, a missing port, a changed body,
  the wrong key for the path, a changed method, a query, a stale timestamp, a `v1=` prefix, uppercase hexadecimal and
  missing headers.

An implementation MUST pass every vector. The monitor's `test/signature.test.ts` checks the reference client against
all of them. A server SHOULD import a pinned copy of this file into its own tests. A change to this file is a change
to the protocol version.

## 3. Deep health: `GET /api/v2/monitor/health`

Signed with the HEALTH key. `HEAD` MAY be supported and signs `HEAD`.

The answer is `200`, `Cache-Control: no-store`, `Content-Type: application/json`:

```json
{"version":1,"generatedAt":"2026-11-11T12:00:00.015Z","release":{"version":"1.4.2","commit":"abc1234"},"overall":"ok",
 "checks":[{"id":"database","status":"ok","latencyMs":3,"detail":"OK","value":null}]}
```

| Field | Rule |
| --- | --- |
| `version` | MUST be `1` |
| `generatedAt` | ISO-8601 time string |
| `release` | `{version, commit}`, both strings. A value outside the code alphabet below is shown as `unknown` |
| `overall` | `ok`, `degraded` or `down`: the worst of `checks` |
| `checks[].id` | `^[a-z][a-z0-9_]{0,63}$` |
| `checks[].status` | `ok`, `degraded` or `down` |
| `checks[].latencyMs` | A finite number |
| `checks[].detail` | A short code. The monitor lowercases it and keeps it only when it matches `^[a-z0-9_.:-]{1,64}$` (otherwise `invalid_detail`), so `BACKLOG_STALE` reads as `backlog_stale` |
| `checks[].value` | A finite number or `null` |

An answer that breaks any rule above counts as a failed check. A sub-check failure MUST be reported in the body, not
by failing the request: the server answers `200` with that check `down`.

**What it may expose.** The health answer MUST hold only counts, ages, latencies, the release and fixed codes. It MUST
NOT hold names, email addresses, phone numbers, identifiers of people or records, payloads, query text or error
messages. A monitor or status page MUST NOT show `checks` publicly. The reference monitor keeps them to its
authenticated operator view.

**Timing.** The monitor waits up to the check's `timeoutMs` (default 10 s, at most 30 s). A server SHOULD bound its own
work well inside that.

**Mapping.** In the monitor's targets, a deep check's optional `componentMap` assigns sub-check ids to components. An
unmapped sub-check counts toward the deep check's own component.

## 4. The configuration document: `GET /api/v2/monitor/config`

Signed with the CONFIG key. `HEAD` MAY be supported. The answer is `200`, `Cache-Control: no-store`, JSON, at most
64 KiB. [`config/platform-config.example.json`](../config/platform-config.example.json) is a complete example.

```json
{"schema":1,"revision":7,"updatedAt":"2026-11-11T20:00:00.000Z","updatedBy":"Display Name",
 "policy":{...},"targets":null,"senders":{...},"maintenance":[]}
```

| Field | Rule |
| --- | --- |
| `schema` | MUST be `1` |
| `revision` | A non-negative safe integer. Revisions only grow. They MAY skip numbers |
| `updatedAt`, `updatedBy` | String or `null`. Shown to operators: control characters are replaced and the values are cut to 40 and 120 characters |
| `policy` | Object: the escalation policy, the shape of [`config/escalation.example.json`](../config/escalation.example.json) |
| `targets` | Object with the shape of [`config/targets.example.json`](../config/targets.example.json), or `null` to keep the monitor's own `MONITOR_TARGETS` |
| `senders` | `{smsFrom, smsMessagingServiceSid, emailFrom, emailFromName}`, or `null` |
| `maintenance` | Array of maintenance windows (MAY be empty) |

Before anything is saved, the answer is revision 0 with every section `null`:
`{"schema":1,"revision":0,"updatedAt":null,"updatedBy":null,"policy":null,"targets":null,"senders":null,"maintenance":null}`.
From revision 1 on, `policy` MUST be an object and `maintenance` MUST be an array. Sections MUST be JSON objects, never
JSON strings.

### 4.1 Validation rules

A server SHOULD validate every document it stores with the same rules and messages as the monitor
(`worker/config-parse.ts`, `worker/maintenance.ts`, `worker/platform-config.ts`), so that every document it accepts,
the monitor accepts too.

| Rule | Limit |
| --- | --- |
| Ids | `^[a-z][a-z0-9_]{0,47}$`, unique within their list (contact ids unique across all tiers) |
| Tiers | 1 to 10. `ackTimeoutMinutes` 1 to 1,440 (default 5) |
| Contacts per tier | 1 to 20, each with at least one of `sms` (E.164, `^\+[1-9]\d{6,14}$`) and `email` |
| Names | Tier, component and contact names, and an HTTP check's `bodyIncludes`: at most 60 printable characters on one line |
| `maxCycles` | 1 to 10 (default 3) |
| `ackLinkTtlMinutes` | 15 to 10,080 (default 1,440) |
| `timeZone` | An IANA zone name (default `UTC`) |
| `reminderMinutes` | 0 (off) or 15 to 1,440 (default 60) |
| `drill` | `{enabled, weekday, time}`: boolean, ISO weekday 1 (Monday) to 7, `HH:MM` (default off, Wednesday 10:00) |
| Components | 1 to 50. `pageOn` `down` (default) or `degraded`. `alert` `page` (default), `email` or `none`. `public` `true` (default) or `false` |
| Checks | 1 to 100, each on an existing component, at most one `deep`. `timeoutMs` 1,000 to 30,000 (default 10,000) |
| HTTP checks | `method` `GET` or `HEAD`. `expectStatus` a code or `[min, max]` (default 200 to 299). `maxRedirects` 0 to 10 (default 5). `latencyDegradedMs` 100 to 30,000 (default 3,000) |
| DNS checks | `hostname`, a lowercase host name. `dnsOnly` boolean |
| Deep checks | Path exactly `/api/v2/monitor/health`, no query or fragment. Host on the monitor's `DEEP_CHECK_HOSTS` (by default the host of `PLATFORM_CONFIG_URL`). `latencyDegradedMs` default 5,000 |
| `openAfterFailures` / `resolveAfterPasses` | 2 to 10 (default 2) / 1 to 30 (default 3) |
| URLs | `https`, no credentials, at most 2,048 characters as the URL parser normalises them |
| Senders | At most one of `smsFrom` (E.164) and `smsMessagingServiceSid` (`^MG[0-9a-f]{32}$`). `emailFrom`, when set, MUST equal the monitor's `ALERT_EMAIL_FROM`. `emailFromName` 1 to 60 printable characters on one line, without quotes or angle brackets |
| Maintenance | At most 20 windows, each `{id, components: [ids] or "all", startsAt, endsAt, note}`. Times in ISO-8601 UTC. Each window lasts 5 minutes to 12 hours. Components MUST exist (the document's targets, or the monitor's built-in ones while `targets` is `null`). `note` at most 120 printable characters |
| Text | No U+0000 and no unpaired UTF-16 surrogate in any string or key |

Free text reaches SMS, email and the public status page. A document MUST NOT hold patient or other sensitive personal
information in names, titles, notes or URLs.

### 4.2 Acceptance by the monitor

The monitor pulls the document on every run (once a minute), with a 5-second timeout, beside its checks and never in
their way. It accepts a document only when all of the following hold:

1. It is at most 64 KiB and passes the rules above.
2. It would leave the monitor with a usable configuration. For example, a policy with SMS contacts is refused while the
   monitor has no Twilio credentials. The server cannot see the monitor's secrets, so it MAY have stored such a
   revision. The monitor then refuses it as `config_unusable`, naming the revision, and keeps the revision it holds.
3. Its revision is above the stored one. The same revision with the same body is a no-op. A lower revision is refused
   as `config_revision_lower`, and the same revision with a different body as `config_revision_conflict`.

An accepted revision is the monitor's last known good copy. A platform outage or a bad document never stops
monitoring: the monitor keeps its last known good copy. A server that restores an older database MUST move its
revision sequence past the revision the monitor holds before the next save.

When an accepted revision changes the contact set, the monitor emails every email contact of the old and new policy
(names only, never numbers or addresses). This is a tamper signal: an administrator of the platform can change who is
paged.

## 5. The report: `POST /api/v2/monitor/report`

Signed with the CONFIG key over the exact body. `Content-Type: application/json`, at most 64 KiB. The monitor sends it
every 5 minutes, and at its next run after it applies or refuses a revision, after a contact's health changes, or after
an incident resolves.

```json
{"schema":1,"sentAt":"2026-11-11T20:05:00.000Z",
 "monitor":{"appliedRevision":7,"configSource":"platform","lastConfigError":null,"deliveryMode":"live",
  "lastRunAt":"2026-11-11T20:04:30.000Z","heartbeatConfigured":true,"warnings":["contact_single_channel:primary_oncall"]},
 "contactHealth":[{"contactId":"primary_oncall","channel":"sms","state":"opted_out","code":"twilio_21610","since":"2026-11-11T19:00:00.000Z"}],
 "incidents":[{"incidentId":"inc_20261111_0812","drill":false,"components":["website"],"peakStatus":"down",
  "openedAt":"2026-11-11T08:12:00.000Z","resolvedAt":"2026-11-11T09:17:00.000Z","acknowledgedAt":"2026-11-11T08:15:00.000Z",
  "acknowledgedBy":"primary_oncall","acknowledgedVia":"sms","exhausted":false,"deliveries":{"sent":3,"delivered":2,"failed":1},
  "timeline":[{"at":"2026-11-11T08:12:00.000Z","type":"opened","tierId":null,"contactId":null,"channel":null,"code":null}]}]}
```

### 5.1 Fields

| Field | Rule |
| --- | --- |
| `schema` | `1` |
| `sentAt` | ISO-8601 time |
| `monitor.appliedRevision` | The stored revision in force, 0 when the monitor runs on its own settings |
| `monitor.configSource` | `platform` or `bootstrap` |
| `monitor.lastConfigError` | `{code, revision, at}` or `null`. `revision` is `null` when no revision is concerned |
| `monitor.deliveryMode` | `live` or `log` (log: nothing is sent; a server SHOULD warn loudly) |
| `monitor.lastRunAt` | ISO-8601 or `null` |
| `monitor.heartbeatConfigured` | Boolean: whether an outside dead-man's switch is configured |
| `monitor.warnings` | At most 200, each `kind` or `kind:id`, each part `^[a-z0-9_]{1,48}$` |
| `contactHealth[]` | At most 400. Only channels with a problem: `state` is `opted_out`, `undeliverable`, `suppressed` or `drill_missed`. No row means healthy, and each report replaces the whole set |
| `incidents[]` | At most 20 resolved incidents, drills included, not yet archived, oldest first |
| `incidents[].timeline` | At most 200 entries: the first and the most recent are kept. `type` is one of `opened`, `paged`, `delivered`, `failed`, `acked`, `escalated`, `reminded`, `resolved`, `maintenance`. Optional fields are `null` when they do not apply |
| Codes | Every code matches `^[a-z0-9_.:-]{1,64}$`. The monitor sends anything else as `invalid_detail` |
| Ids | Contact, tier and component ids match `^[a-z][a-z0-9_]{0,47}$`. Incident ids are at most 64 characters |

A drill reports `peakStatus: "degraded"` by convention, with `drill: true`.

**No personal contact data, by construction.** A report holds contact ids only. It MUST NOT contain phone numbers,
email addresses, names, message bodies or acknowledgement codes. A server SHOULD refuse any field it does not know.

### 5.2 Answer

A valid report is answered `200`, `Cache-Control: no-store`, with `{"archived": [incidentId, ...]}`: every incident of
the report that the server's archive now holds, whether it was stored now or before. The monitor marks those exported.
It keeps an unexported resolved incident for up to 180 days, then prunes it with the `incidents_pruned_unexported`
warning.

A correctly signed report that breaks a rule MUST be refused as a whole (for example `400`) and MUST store nothing.
After a refused report that carried incidents, the monitor sends the next one without incidents (with the
`report_incidents_refused` warning), so that the state still arrives, and then tries the incidents again.

### 5.3 Server storage rules

- The monitor state SHOULD be replaced only by a report with a newer `sentAt`. A server SHOULD refuse a `sentAt` more
  than 60 seconds ahead of its clock, because a report from the future would freeze the state.
- An incident SHOULD be stored once. A resend keeps the first copy, so a replayed report changes nothing.
- An archive of incidents SHOULD be append-only.

## 6. Versioning

This is version 2 of the protocol. The version appears in the canonical string, the signature prefix and the paths. A
change to the canonical string, the headers, the key rules or the test vectors is a new protocol version. Adding an
optional field to a JSON document is not, as long as both sides accept documents without it. A server MAY support more
than one version during a migration, and the version 1 prefix `v1=` MUST be refused under version 2.
