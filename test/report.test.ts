// The report channel: what the Worker tells the platform (revision, refusals, warnings, contact health, archived
// incidents with their timelines), that it carries contact ids only, its size limits, the signed POST and the answer,
// export marking, and retention that never drops an incident the platform has not archived (until 180 days).
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConfig } from "../worker/config.ts";
import { applyPlatformDocument } from "../worker/platform-config.ts";
import { buildReport, MAX_REPORT_BYTES, MAX_TIMELINE, REPORT_EVERY_MS, reportCode, reportUrl, sendReport, timelineOf } from "../worker/report.ts";
import type { IncidentEvent } from "../worker/store.ts";
import { MonitorStore, RETENTION_MS, UNEXPORTED_RETENTION_MS } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { isRecord } from "../worker/types.ts";
import { allWarnings, MAX_WARNINGS, runtimeWarnings, WARNING } from "../worker/warnings.ts";
import { countingRandom, examplePolicy, fixtureTargets, FakeClock, header, MINUTE, scriptedFetch, sqliteStorage, T0 } from "./support/fakes.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const KEY = "c".repeat(40);
const env = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  MONITOR_TARGETS: read("test/support/targets.fixture.json"), ESCALATION_POLICY: read("config/escalation.example.json"),
  STATUS_PAGE_URL: "https://status.example.com", TWILIO_WEBHOOK_URL: "https://status.example.com/hooks/twilio",
  MONITOR_HEALTH_KEY: "h".repeat(40), MONITOR_CONFIG_KEY: KEY, ACK_SIGNING_KEY: "a".repeat(40), TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "token", TWILIO_FROM: "+15555550123", ALERT_EMAIL: { send: () => Promise.resolve({ messageId: "m" }) },
  ALERT_EMAIL_FROM: "alerts@example.com", PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config", ...overrides,
});
const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
};
const run = (at: number, down: readonly string[]): CheckResult[] => fixtureTargets().components.map((component) => ({
  checkId: `${component.id}_http`, componentId: component.id, type: "http", status: down.includes(component.id) ? "down" : "ok", inconclusive: false,
  latencyMs: 5, detail: down.includes(component.id) ? "status_503" : "ok", observedAt: at, data: null,
}));

/** A signup incident: opened, paged (the SMS sent, the email failed for good), acknowledged by SMS, then resolved. */
function resolvedIncident() {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  const policy = examplePolicy();
  store.recordRun(run(T0, ["signup"]), fixtureTargets(), policy, T0);
  const id = store.recordRun(run(T0 + MINUTE, ["signup"]), fixtureTargets(), policy, T0 + MINUTE).opened[0] ?? "";
  for (const { row } of store.claimDue(T0 + MINUTE)) {
    if (row.channel === "sms") store.markSent(row.key, `SM${"1".repeat(32)}`, T0 + MINUTE);
    else store.markFailed(row.key, "email_sender_not_verified", false, T0 + MINUTE);
  }
  store.acknowledge(id, { name: "Primary On-call", via: "sms", contactId: "primary_oncall" }, policy, T0 + 2 * MINUTE);
  for (let minute = 3; minute <= 5; minute += 1) store.recordRun(run(T0 + minute * MINUTE, []), fixtureTargets(), policy, T0 + minute * MINUTE);
  return { store, id };
}

void test("report: the monitor section, warnings, contact health and an archived incident with its timeline", () => {
  const { store, id } = resolvedIncident();
  store.setContactHealth("primary_oncall", "sms", "opted_out", "twilio_21610", T0 + 3 * MINUTE);
  store.setContactHealth("someone_removed", "sms", "undeliverable", "twilio_30003", T0 + 3 * MINUTE);
  const loaded = loadConfig(env());
  const { body, incidentIds } = buildReport(store, loaded, env(), T0 + 6 * MINUTE);
  assert.deepEqual(incidentIds, [id]);
  const report = record(JSON.parse(body));
  assert.equal(report["schema"], 1);
  assert.equal(report["sentAt"], new Date(T0 + 6 * MINUTE).toISOString());
  assert.deepEqual(report["monitor"], {
    appliedRevision: 0, configSource: "bootstrap", lastConfigError: null, deliveryMode: "live", lastRunAt: new Date(T0 + 5 * MINUTE).toISOString(),
    heartbeatConfigured: false,
    // The per-contact and per-tier advice last, so a large roster can never push the others out.
    warnings: ["drill_disabled", "heartbeat_missing",
      // The page's email failed with an account-level code and no email has gone out since.
      "email_channel_failing:sender_not_verified",
      "tier_single_contact:primary", "contact_single_channel:engineering_lead", "tier_single_contact:third_party"],
  });
  assert.deepEqual(report["contactHealth"], [
    { contactId: "primary_oncall", channel: "sms", state: "opted_out", code: "twilio_21610", since: new Date(T0 + 3 * MINUTE).toISOString() },
  ], "only contacts in the current policy");
  const incidents = Array.isArray(report["incidents"]) ? report["incidents"].map(record) : [];
  const [incident] = incidents;
  assert.ok(incident !== undefined);
  assert.deepEqual({ ...incident, timeline: undefined }, {
    incidentId: id, drill: false, components: ["signup"], peakStatus: "down", openedAt: new Date(T0 + MINUTE).toISOString(),
    resolvedAt: new Date(T0 + 5 * MINUTE).toISOString(), acknowledgedAt: new Date(T0 + 2 * MINUTE).toISOString(), acknowledgedBy: "primary_oncall",
    acknowledgedVia: "sms", exhausted: false, deliveries: { sent: 1, delivered: 0, failed: 1 }, timeline: undefined,
  });
  const timeline = Array.isArray(incident["timeline"]) ? incident["timeline"].map(record) : [];
  assert.deepEqual(timeline.map((entry) => [entry["type"], entry["contactId"], entry["channel"], entry["code"]]), [
    ["opened", null, null, "status_503"],
    ["failed", "primary_oncall", "email", "email_sender_not_verified"],
    ["paged", "primary_oncall", "sms", null],
    ["acked", "primary_oncall", "sms", null],
    ["resolved", null, null, "recovered"],
  ]);
  assert.equal(timeline[2]?.["tierId"], "primary");
  // Contact ids only: no numbers, addresses, names, message text or ACK code.
  const code = store.incident(id)?.ackCode ?? "";
  for (const secret of ["+1555", "5555550100", "@example.com", "Primary On-call", code, "Reply ACK", "SM111"]) {
    assert.ok(!body.includes(secret), `the report must not carry ${secret}`);
  }
});

void test("report: lastConfigError names the refused revision; a refused run names the stored one", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  applyPlatformDocument(store, env(), JSON.stringify({ ...record(JSON.parse(read("config/platform-config.example.json"))) }), T0);
  const noTwilio = env({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined });
  const document = { ...record(JSON.parse(read("config/platform-config.example.json"))), revision: 8 };
  assert.equal(applyPlatformDocument(store, noTwilio, JSON.stringify(document), T0 + MINUTE).outcome, "unusable");
  const monitor = (loadedEnv: Record<string, unknown>, ok = true): unknown => {
    const loaded = ok ? loadConfig(loadedEnv) : { ok: false as const, errors: ["x"] };
    return record(JSON.parse(buildReport(store, loaded, loadedEnv, T0 + 2 * MINUTE).body))["monitor"];
  };
  const refused = record(monitor(env()));
  assert.deepEqual([refused["appliedRevision"], refused["configSource"]], [7, "platform"]);
  assert.deepEqual(refused["lastConfigError"], { code: "config_unusable", revision: 8, at: new Date(T0 + MINUTE).toISOString() });
  assert.ok(!(Array.isArray(refused["warnings"]) ? refused["warnings"] : []).some((warning) => String(warning).startsWith("newer_revision_refused")),
    "with the stored revision running, lastConfigError already names the refusal");
  store.recordConfigError("platform revision 7: the stored copy no longer validates", T0 + 90_000);
  const stopped = record(monitor(env(), false));
  assert.deepEqual(stopped["lastConfigError"], { code: "config_stored_invalid", revision: 7, at: new Date(T0 + 90_000).toISOString() });
  // The admin's fix (revision 8) was refused too: the page still learns that, and why, while revision 7 keeps it stopped.
  assert.ok(Array.isArray(stopped["warnings"]) && stopped["warnings"].includes("newer_revision_refused:config_unusable"), JSON.stringify(stopped["warnings"]));
  store.recordConfigFetchError("config_timeout", "", T0 + 2 * MINUTE);
  assert.deepEqual(record(monitor(env()))["lastConfigError"], { code: "config_timeout", revision: null, at: new Date(T0 + 2 * MINUTE).toISOString() });
  const notNewer = record(monitor(env(), false))["warnings"];
  assert.ok(
    Array.isArray(notNewer) && !notNewer.some((warning) => String(warning).startsWith("newer_revision_refused")),
    "a pull error with no newer revision is not one",
  );
});

void test("report: a long timeline keeps its first entry and the most recent ones; an oversized report sends fewer incidents", () => {
  const events: IncidentEvent[] = Array.from({ length: 250 }, (_, index) => ({
    incidentId: "inc_1", at: T0 + index * 1000, type: index === 0 ? "opened" : index % 2 === 0 ? "reminded" : "notify", detail: "", tierId: null,
    contactId: null,
    channel: null, code: null,
  }));
  const reminder: IncidentEvent = { incidentId: "inc_1", at: 0, type: "reminded", detail: "", tierId: null, contactId: null, channel: null, code: null };
  const many = [...events, ...Array.from({ length: 200 }, (_, index) => ({ ...reminder, at: T0 + 300_000 + index }))];
  const timeline = timelineOf(many);
  assert.equal(timeline.length, MAX_TIMELINE);
  assert.equal(timeline[0]?.type, "opened");
  assert.equal(timeline.at(-1)?.at, new Date(T0 + 300_000 + 199).toISOString(), "the newest is kept");
  assert.equal(timelineOf(events).length, 125, "internal events (notify) stay out of the archive: opened plus 124 reminders");

  const storage = sqliteStorage();
  const store = new MonitorStore(storage, countingRandom());
  const policy = examplePolicy();
  let at = T0;
  for (let index = 0; index < 20; index += 1) {
    store.recordRun(run(at, ["signup"]), fixtureTargets(), policy, at);
    store.recordRun(run(at + MINUTE, ["signup"]), fixtureTargets(), policy, at + MINUTE);
    for (let minute = 2; minute <= 4; minute += 1) store.recordRun(run(at + minute * MINUTE, []), fixtureTargets(), policy, at + minute * MINUTE);
    at += 10 * MINUTE;
  }
  const insert = storage.db.prepare("INSERT INTO incident_events (incident_id, at, type, detail, code) VALUES (?, ?, 'reminded', '', ?)");
  for (const incident of store.unexportedIncidents()) {
    for (let index = 0; index < MAX_TIMELINE; index += 1) insert.run(incident.id, incident.openedAt + index, `reminder_${"x".repeat(50)}`);
  }
  const cut = buildReport(store, loadConfig(env()), env(), at);
  assert.ok(new TextEncoder().encode(cut.body).byteLength <= MAX_REPORT_BYTES);
  assert.ok(cut.incidentIds.length > 0 && cut.incidentIds.length < 20, `sent ${String(cut.incidentIds.length)}; the rest wait for the next report`);
  assert.deepEqual(cut.incidentIds, store.unexportedIncidents().slice(0, cut.incidentIds.length).map((incident) => incident.id), "oldest first");
});

void test("report: delivery bookkeeping — due every 5 minutes or after a change; only sent, resolved, archived incidents are marked exported", () => {
  const { store, id } = resolvedIncident();
  assert.equal(store.reportDue(T0 + 6 * MINUTE, REPORT_EVERY_MS), true, "the incident resolved");
  assert.equal(store.recordReportSent([id], [id, "inc_not_sent"], T0 + 6 * MINUTE, store.reportSeq()), 1);
  assert.equal(store.incident(id)?.exportedAt, T0 + 6 * MINUTE);
  assert.deepEqual(store.unexportedIncidents(), []);
  assert.equal(store.reportDue(T0 + 7 * MINUTE, REPORT_EVERY_MS), false);
  assert.equal(store.reportDue(T0 + 11 * MINUTE, REPORT_EVERY_MS), true, "every 5 minutes");
  store.recordReportFailed("report_timeout", T0 + 11 * MINUTE);
  assert.deepEqual(store.reportStatus(), { lastOkAt: T0 + 6 * MINUTE, lastErrorCode: "report_timeout", lastErrorAt: T0 + 11 * MINUTE });
  store.markReportDue();
  assert.equal(store.reportDue(T0 + 6 * MINUTE, REPORT_EVERY_MS), true);
});

void test("report: a change marked while a report is in flight keeps the next run's report due", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordReportSent([], [], T0, store.reportSeq());
  store.markReportDue();
  assert.equal(store.reportDue(T0 + MINUTE, REPORT_EVERY_MS), true);
  const builtAt = store.reportSeq();
  // The platform POST is in flight: a Twilio status callback records an opt-out (and marks the report due).
  store.setContactHealth("primary_oncall", "sms", "opted_out", "twilio_21610", T0 + MINUTE + 1);
  store.recordReportSent([], [], T0 + MINUTE + 2, builtAt);
  assert.equal(store.reportDue(T0 + 2 * MINUTE, REPORT_EVERY_MS), true, "the opt-out goes at the next run, not 5 minutes later");
  store.recordReportSent([], [], T0 + 2 * MINUTE, store.reportSeq());
  assert.equal(store.reportDue(T0 + 3 * MINUTE, REPORT_EVERY_MS), false);
  // An older report's success never moves the counter back.
  store.recordReportSent([], [], T0 + 3 * MINUTE, builtAt);
  assert.equal(store.reportDue(T0 + 3 * MINUTE, REPORT_EVERY_MS), false);
});

const warningsOf = (report: Readonly<Record<string, unknown>>): unknown[] => {
  const warnings = record(report["monitor"])["warnings"];
  return Array.isArray(warnings) ? warnings : [];
};

// The report contract a platform enforces (spec/PROTOCOL.md, "The report": its code, warning and id patterns, written out
// here as the spec states them, never taken from this Worker's own patterns): what it refuses, it refuses whole.
const PLATFORM_CODE = /^[a-z0-9_.:-]{1,64}$/;
const PLATFORM_WARNING = /^[a-z0-9_]{1,48}(?::[a-z0-9_]{1,48})?$/;
const PLATFORM_ID = /^[a-z][a-z0-9_]{0,47}$/;
function platformRefusals(body: string): string[] {
  const report = record(JSON.parse(body));
  const monitor = record(report["monitor"]);
  const problems: string[] = [];
  const codeOk = (value: unknown, path: string): void => {
    if (value !== null && value !== undefined && (typeof value !== "string" || !PLATFORM_CODE.test(value))) problems.push(`${path}: ${JSON.stringify(value)}`);
  };
  if (monitor["lastConfigError"] !== null) codeOk(record(monitor["lastConfigError"])["code"], "lastConfigError.code");
  for (const warning of Array.isArray(monitor["warnings"]) ? monitor["warnings"] : []) {
    if (typeof warning !== "string" || !PLATFORM_WARNING.test(warning)) problems.push(`warning: ${String(warning)}`);
  }
  const health = Array.isArray(report["contactHealth"]) ? report["contactHealth"].map(record) : [];
  if (health.length > 400) problems.push("contactHealth: more than 400");
  for (const row of health) {
    codeOk(row["code"], "contactHealth.code");
    if (typeof row["contactId"] !== "string" || !PLATFORM_ID.test(row["contactId"])) problems.push(`contactHealth.contactId: ${String(row["contactId"])}`);
  }
  for (const incident of Array.isArray(report["incidents"]) ? report["incidents"].map(record) : []) {
    for (const entry of Array.isArray(incident["timeline"]) ? incident["timeline"].map(record) : []) codeOk(entry["code"], "timeline.code");
  }
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES) problems.push("body over 64 KiB");
  return problems;
}

void test("report: every code goes out as the monitor recorded it (the platform's alphabet); anything else is invalid_detail", () => {
  const kept = ["db.timeout", "5xx_burst", "queue-lag", "rcode:5", "rcode.5", "tls-handshake", "cfemail:unknown", "status_503", "x".repeat(64)];
  assert.deepEqual(kept.map(reportCode), kept, "no rewriting: the archive holds the codes exactly as the monitor recorded them");
  for (const code of kept) assert.ok(PLATFORM_CODE.test(code), code);
  assert.deepEqual(["QUEUE-LAG", "x".repeat(65), "a b", ""].map(reportCode), ["invalid_detail", "invalid_detail", "invalid_detail", "invalid_detail"]);
  // A deep sub-check reported "QUEUE-LAG" (stored lowercased as the opened event's code), and an odd config error code.
  const { store, id } = resolvedIncident();
  const opened = store.incidentEvents(id).find((event) => event.type === "opened");
  assert.ok(opened !== undefined);
  const timeline = timelineOf([
    { ...opened, code: "queue-lag" }, { ...opened, type: "failed", code: "5xx_burst" }, { ...opened, type: "failed", code: "Bad Code" },
  ]);
  assert.deepEqual(timeline.map((entry) => entry.code), ["queue-lag", "5xx_burst", "invalid_detail"]);
  store.recordConfigFetchError("config.timeout", "", T0 + 6 * MINUTE);
  store.setContactHealth("primary_oncall", "email", "suppressed", "email-recipient.suppressed", T0 + 6 * MINUTE);
  const { body } = buildReport(store, loadConfig(env()), env(), T0 + 7 * MINUTE);
  assert.deepEqual(platformRefusals(body), []);
  // Warnings outside the platform's pattern are dropped here rather than refused there.
  assert.deepEqual(allWarnings([["email_channel_failing:5xx", "x:_a", "5xx_warning", "heartbeat_missing"]]), ["heartbeat_missing"]);
});

void test("report: the warning pattern accepts nothing the platform's MONITOR_WARNING refuses, at each part's 48/49-character boundary", () => {
  const part = (length: number): string => `a${"b".repeat(length - 1)}`;
  for (const length of [1, 47, 48, 49, 64, 65]) {
    for (const warning of [part(length), `kind:${part(length)}`, `${part(length)}:id`]) {
      if (WARNING.test(warning)) assert.ok(PLATFORM_WARNING.test(warning), `${String(warning.length)} characters: kept here, refused there`);
      assert.equal(allWarnings([[warning]]).length, PLATFORM_WARNING.test(warning) ? 1 : 0, `${String(length)}: ${warning.slice(0, 12)}...`);
    }
  }
  assert.deepEqual(allWarnings([[part(48), part(49), `${part(48)}:${part(48)}`, `${part(49)}:x`]]), [part(48), `${part(48)}:${part(48)}`]);
});

void test("report: a large roster's per-contact advice never pushes out a failing channel, the heartbeat or a stuck archive", () => {
  // 3 tiers of 20 contacts; all but the first are email-only, so 59 contact_single_channel warnings.
  const tiers = ["primary", "secondary", "third"].map((tierId, tier) => ({
    id: tierId, name: `Tier ${String(tier)}`, ackTimeoutMinutes: 5,
    contacts: Array.from({ length: 20 }, (_, contact) => {
      const index = tier * 20 + contact;
      return {
        id: `contact_${String(index)}`, name: `Contact ${String(index)}`, sms: index === 0 ? "+15555550100" : null, email: `c${String(index)}@example.com`,
      };
    }),
  }));
  const settings = env({ ESCALATION_POLICY: JSON.stringify({ version: 1, maxCycles: 3, ackLinkTtlMinutes: 1440, tiers }) });
  const loaded = loadConfig(settings);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("\n"));
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun(run(T0, ["signup"]), fixtureTargets(), loaded.config.policy, T0);
  store.recordRun(run(T0 + MINUTE, ["signup"]), fixtureTargets(), loaded.config.policy, T0 + MINUTE);
  // Twilio credentials rotated wrongly and the Email Service account suspended: alert texts and email fail for everyone.
  for (const { row } of store.claimDue(T0 + MINUTE)) {
    store.markFailed(row.key, row.channel === "sms" ? "twilio_20003" : "email_account_suspended", false, T0 + MINUTE, loaded.config.policy);
  }
  const { body } = buildReport(store, loaded, settings, T0 + 2 * MINUTE, { withoutIncidents: true });
  assert.deepEqual(platformRefusals(body), []);
  const warnings = warningsOf(record(JSON.parse(body))).map(String);
  const expected = [
    "email_channel_failing:account_suspended", "sms_channel_failing:twilio_20003", "heartbeat_missing", "drill_disabled", "report_incidents_refused",
  ];
  for (const needed of expected) {
    assert.ok(warnings.includes(needed), `${needed} is reported`);
  }
  assert.equal(warnings.filter((warning) => warning.startsWith("contact_single_channel:")).length, 59, "and every contact's advice still fits");
  const firstAdvice = warnings.findIndex((warning) => warning.startsWith("contact_single_channel:"));
  assert.ok(warnings.slice(firstAdvice).every((warning) => /^(contact_single_channel|tier_single_contact):/.test(warning)), "the advice comes last");
  // Past the platform's limit of 200, the advice is what gets cut.
  const advice = Array.from({ length: 250 }, (_, index) => `contact_single_channel:c${String(index)}`);
  const capped = allWarnings([advice, ["sms_channel_failing:twilio_20003"], ["contact_health_truncated"]]);
  assert.equal(capped.length, MAX_WARNINGS);
  assert.equal(MAX_WARNINGS, 200, "the platform's monitorState.warnings max(200)");
  assert.deepEqual(capped.slice(0, 2), ["sms_channel_failing:twilio_20003", "contact_health_truncated"]);
});

void test("report: channels back to ok stay out; at the largest policy both sides accept, the body still fits in 64 KiB", () => {
  const tiers = Array.from({ length: 10 }, (_, tier) => ({
    id: `tier_${String(tier)}`, name: `Tier ${String(tier)}`, ackTimeoutMinutes: 5,
    contacts: Array.from({ length: 20 }, (_, contact) => {
      const index = tier * 20 + contact;
      return { id: `c${String(index).padStart(3, "0")}_${"x".repeat(43)}`, name: `Contact ${String(index)}`,
        sms: `+1555550${String(index).padStart(4, "0")}`, email: `contact${String(index)}@example.com` };
    }),
  }));
  const policyJson = JSON.stringify({ version: 1, maxCycles: 3, ackLinkTtlMinutes: 1440, tiers });
  const loaded = loadConfig(env({ ESCALATION_POLICY: policyJson }));
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.errors.join("\n"));
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  const ids = tiers.flatMap((tier) => tier.contacts.map((contact) => contact.id));
  assert.equal(ids[0]?.length, 48);
  for (const id of ids) {
    store.setContactHealth(id, "email", "suppressed", "email_recipient_suppressed", T0);
    store.setContactHealth(id, "sms", "opted_out", "twilio_recipient_opted_out", T0);
  }
  const { body } = buildReport(store, loaded, env({ ESCALATION_POLICY: policyJson }), T0 + MINUTE);
  assert.deepEqual(platformRefusals(body), [], "within 64 KiB and the platform's alphabet");
  const report = record(JSON.parse(body));
  const health = Array.isArray(report["contactHealth"]) ? report["contactHealth"].map(record) : [];
  assert.ok(health.length < 400 && warningsOf(report).includes("contact_health_truncated"), "cut, and it says so");
  assert.ok(health.filter((row) => row["state"] === "opted_out").length === 200, "opt-outs (they need START) are kept first");

  // Channels that recovered (code "delivered" or "inbound_start") are not reported: no row means healthy.
  for (const id of ids) {
    store.setContactHealth(id, "email", "ok", "delivered", T0 + 2 * MINUTE);
    store.setContactHealth(id, "sms", "ok", "inbound_start", T0 + 2 * MINUTE);
  }
  store.setContactHealth(ids[5] ?? "", "sms", "undeliverable", "twilio_30006", T0 + 3 * MINUTE);
  const recovered = record(JSON.parse(buildReport(store, loaded, env({ ESCALATION_POLICY: policyJson }), T0 + 4 * MINUTE).body));
  assert.deepEqual(recovered["contactHealth"], [
    { contactId: ids[5], channel: "sms", state: "undeliverable", code: "twilio_30006", since: new Date(T0 + 3 * MINUTE).toISOString() },
  ]);
  assert.ok(!warningsOf(recovered).includes("contact_health_truncated"));
});

void test("report: refused as invalid while carrying incidents, the next report carries the state without them, then tries again", () => {
  const { store, id } = resolvedIncident();
  store.recordReportFailed("report_timeout", T0 + 6 * MINUTE, 1);
  assert.equal(store.reportIncidentsRefused(), false, "a timeout says nothing about the content");
  store.recordReportFailed("report_status_400", T0 + 6 * MINUTE, 0);
  assert.equal(store.reportIncidentsRefused(), false, "refused without incidents: dropping them would not help");
  store.recordReportFailed("report_status_400", T0 + 6 * MINUTE, 1);
  assert.equal(store.reportIncidentsRefused(), true);
  const stateOnly = buildReport(store, loadConfig(env()), env(), T0 + 7 * MINUTE, { withoutIncidents: store.reportIncidentsRefused() });
  assert.deepEqual(stateOnly.incidentIds, []);
  const report = record(JSON.parse(stateOnly.body));
  assert.deepEqual(report["incidents"], []);
  assert.ok(warningsOf(report).includes("report_incidents_refused"));
  store.recordReportSent(stateOnly.incidentIds, [], T0 + 7 * MINUTE, store.reportSeq());
  assert.equal(store.reportIncidentsRefused(), false, "the next report tries the incidents again");
  assert.deepEqual(buildReport(store, loadConfig(env()), env(), T0 + 12 * MINUTE).incidentIds, [id]);
});

void test("report: one signed POST (config key, body hashed) to PLATFORM_CONFIG_URL's origin; the answer's archived ids come back", async () => {
  assert.equal(reportUrl(env()), "https://platform.example.com/api/v2/monitor/report");
  assert.equal(
    reportUrl(env({ PLATFORM_CONFIG_URL: "https://staging.example.com:8443/api/v2/monitor/config" })), "https://staging.example.com:8443/api/v2/monitor/report",
  );
  assert.equal(reportUrl(env({ PLATFORM_CONFIG_URL: "http://x.example.com/api/v2/monitor/config" })), null);
  const body = JSON.stringify({ schema: 1, sentAt: "2026-11-11T14:00:00.000Z" });
  const { fetch, calls } = scriptedFetch(() => new Response(JSON.stringify({ archived: ["inc_a"] }), { status: 200 }));
  const url = "https://platform.example.com/api/v2/monitor/report";
  assert.deepEqual(await sendReport({ url, key: KEY }, body, { fetch, clock: new FakeClock(), random: countingRandom() }), { ok: true, archived: ["inc_a"] });
  const init = calls[0]?.init;
  assert.deepEqual([calls[0]?.url, init?.method, init?.body, header(init, "content-type")], [url, "POST", body, "application/json"]);
  const timestamp = header(init, "x-status-monitor-timestamp") ?? "", nonce = header(init, "x-status-monitor-nonce") ?? "";
  const canonical = ["v2", "POST", "platform.example.com", "/api/v2/monitor/report", timestamp, nonce,
    createHash("sha256").update(body).digest("hex")].join("\n");
  assert.equal(header(init, "x-status-monitor-signature"), `v2=${createHmac("sha256", KEY).update(canonical).digest("hex")}`);

  const outcome = async (respond: () => Response): Promise<unknown> =>
    sendReport({ url, key: KEY }, body, { fetch: scriptedFetch(respond).fetch, clock: new FakeClock() });
  assert.deepEqual(await outcome(() => new Response("", { status: 401 })), { ok: false, code: "report_rejected_or_missing" });
  assert.deepEqual(await outcome(() => new Response("", { status: 500 })), { ok: false, code: "report_status_500" });
  assert.deepEqual(await outcome(() => new Response("{}", { status: 200 })), { ok: false, code: "report_invalid_response" });
  assert.deepEqual(await outcome(() => new Response("not json", { status: 200 })), { ok: false, code: "report_invalid_response" });
  assert.deepEqual(await outcome(() => {
    throw new DOMException("timed out", "TimeoutError");
  }), { ok: false, code: "report_timeout" });
});

void test("retention: archived incidents go at 35 days; unarchived ones stay until 180 days, then go with a warning", () => {
  const archived = resolvedIncident();
  const kept = resolvedIncident();
  archived.store.recordReportSent([archived.id], [archived.id], T0 + 6 * MINUTE, archived.store.reportSeq());
  const day36 = T0 + RETENTION_MS + 86_400_000;
  archived.store.prune(day36);
  kept.store.prune(day36);
  assert.equal(archived.store.incident(archived.id), null, "archived and older than 35 days: pruned");
  assert.equal(archived.store.incidentEvents(archived.id).length, 0);
  assert.notEqual(kept.store.incident(kept.id), null, "never archived: kept");
  assert.ok(kept.store.notifications().length > 0, "with its outbox rows");
  assert.deepEqual(kept.store.prunedUnexported(), { count: 0, at: null });
  const day181 = T0 + UNEXPORTED_RETENTION_MS + 86_400_000;
  kept.store.prune(day181);
  assert.equal(kept.store.incident(kept.id), null);
  assert.deepEqual(kept.store.prunedUnexported(), { count: 1, at: day181 });
  assert.deepEqual(runtimeWarnings({ dnsInconclusiveSince: null, prunedUnexported: 1 }, day181), ["incidents_pruned_unexported"]);
});

void test("retention, standalone: nothing archives incidents, so every resolved incident goes at 35 days, with no warning", () => {
  const standalone = resolvedIncident();
  const day34 = T0 + RETENTION_MS - 86_400_000;
  standalone.store.prune(day34, { archived: false });
  assert.notEqual(standalone.store.incident(standalone.id), null, "younger than 35 days: kept, as on the public page");
  const day36 = T0 + RETENTION_MS + 86_400_000;
  standalone.store.prune(day36, { archived: false });
  assert.equal(standalone.store.incident(standalone.id), null, "older than 35 days: pruned though never archived");
  assert.equal(standalone.store.incidentEvents(standalone.id).length, 0);
  assert.deepEqual(standalone.store.prunedUnexported(), { count: 0, at: null }, "no incidents_pruned_unexported standalone");
});
