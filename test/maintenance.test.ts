// Maintenance windows and the round-2 config rules: validation of windows, suppression in the store (failures counted,
// nothing opens, a component still failing when its window ends opens at once), what the status page gets, and the
// document parity rules (labels, U+0000 and lone surrogates, canonical URL length, timeZone, reminderMinutes, drill).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Problems, parsePolicy, parseTargets } from "../worker/config.ts";
import { activeWindow, currentAndUpcoming, parseIsoUtc, parseMaintenance } from "../worker/maintenance.ts";
import { documentContext, parsePlatformDocument } from "../worker/platform-config.ts";
import { privateProjection, publicProjection } from "../worker/redact.ts";
import { fullSnapshot } from "../worker/status-view.ts";
import { MonitorStore } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { isRecord } from "../worker/types.ts";
import { isTimeZone } from "../worker/time.ts";
import { countingRandom, examplePolicy, fixtureTargets, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const asRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error("expected an object");
  return { ...value };
};
const readRecord = (path: string): Record<string, unknown> => asRecord(JSON.parse(read(path)));
const asRecords = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(asRecord) : []);
const iso = (ms: number): string => new Date(ms).toISOString();
const KNOWN = new Set(fixtureTargets().components.map((component) => component.id));
const window = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "db_upgrade", components: ["signup"], startsAt: iso(T0), endsAt: iso(T0 + 30 * MINUTE), note: "Database upgrade", ...overrides,
});
const problemsOf = (value: unknown, known: ReadonlySet<string> | null = KNOWN): string => {
  const problems = new Problems();
  parseMaintenance(value, known, problems);
  return problems.list.join("\n");
};

void test("maintenance: valid windows parse; every rule is enforced", () => {
  const problems = new Problems();
  const parsed = parseMaintenance([window(), window({ id: "all_hosts", components: "all", startsAt: "2026-11-12T03:00:00Z", endsAt: "2026-11-12T15:00:00Z" })],
    KNOWN, problems);
  assert.deepEqual(problems.list, []);
  assert.deepEqual(parsed.map((item) => [item.id, item.components, item.endsAt - item.startsAt]), [
    ["db_upgrade", ["signup"], 30 * MINUTE], ["all_hosts", "all", 12 * 60 * MINUTE],
  ]);
  assert.match(problemsOf("nope"), /maintenance: must be an array of at most 20 windows/);
  assert.match(problemsOf(Array.from({ length: 21 }, (_, index) => window({ id: `w${String(index)}` }))), /at most 20/);
  assert.match(problemsOf([window(), window()]), /duplicate id db_upgrade/);
  assert.match(problemsOf([window({ id: "Bad Id" })]), /\.id: must match/);
  assert.match(problemsOf([window({ components: ["nowhere"] })]), /unknown component nowhere/);
  assert.equal(problemsOf([window({ components: ["nowhere"] })], null), "", "unknown targets: existence not checked here");
  assert.match(problemsOf([window({ components: [] })]), /must be "all" or a non-empty array/);
  assert.match(problemsOf([window({ startsAt: "2026-11-11 14:00" })]), /startsAt: must be an ISO-8601 UTC timestamp/);
  assert.match(problemsOf([window({ endsAt: "2026-11-11T14:30:00+01:00" })]), /endsAt: must be an ISO-8601 UTC timestamp/);
  assert.match(problemsOf([window({ endsAt: iso(T0 + 4 * MINUTE) })]), /from 5 minutes to 12 hours/);
  assert.match(problemsOf([window({ endsAt: iso(T0 + 12 * 60 * MINUTE + 1000) })]), /from 5 minutes to 12 hours/);
  assert.match(problemsOf([window({ endsAt: iso(T0 - 60 * MINUTE) })]), /must end after it starts/);
  assert.match(problemsOf([window({ note: "x".repeat(121) })]), /note: must be at most 120 printable characters/);
  assert.match(problemsOf([window({ note: "Patient\nname" })]), /note: must be at most 120 printable characters on one line/);
  assert.equal(parseIsoUtc("2026-02-30T00:00:00Z"), null, "a date that does not exist");
  assert.equal(parseIsoUtc("2026-11-11T14:00:00.123Z"), T0 + 123);
});

void test("parity: the maintenance and time-zone rules the platform's validator refuses are refused here too", () => {
  // Exactly three fractional digits or none (the platform's UTC_TIME).
  assert.equal(parseIsoUtc("2026-11-11T14:00:00.5Z"), null);
  assert.equal(parseIsoUtc("2026-11-11T14:00:00.50Z"), null);
  assert.equal(parseIsoUtc("2026-11-11T14:00:00.5000Z"), null);
  assert.match(problemsOf([window({ startsAt: "2026-11-11T14:00:00.5Z" })]), /startsAt: must be an ISO-8601 UTC timestamp/);
  // A repeated component id is refused, not quietly deduplicated.
  assert.match(problemsOf([window({ components: ["signup", "signup"] })]), /\.components: duplicate id signup/);
  // Offsets are not IANA names, though Intl accepts them; nor is anything over 64 characters.
  for (const zone of ["+05:00", "-0800", "UTC ", `America/${"X".repeat(60)}`]) {
    assert.equal(isTimeZone(zone), false, zone);
    assert.match(policyWith({ timeZone: zone }), /timeZone: must be an IANA time zone name/, zone);
  }
  for (const zone of ["UTC", "America/New_York", "Etc/GMT+5", "America/Argentina/Buenos_Aires"]) assert.equal(isTimeZone(zone), true, zone);
});

void test("maintenance: the active window for a component, and what the status page lists", () => {
  const problems = new Problems();
  const windows = parseMaintenance([window(), window({ id: "later", components: "all", startsAt: iso(T0 + 2 * 86_400_000),
    endsAt: iso(T0 + 2 * 86_400_000 + 60 * MINUTE) }), window({ id: "far", startsAt: iso(T0 + 9 * 86_400_000), endsAt: iso(T0 + 9 * 86_400_000 + 3_600_000) })],
  KNOWN, problems);
  assert.equal(activeWindow(windows, "signup", T0)?.id, "db_upgrade");
  assert.equal(activeWindow(windows, "forums", T0), null);
  assert.equal(activeWindow(windows, "signup", T0 + 30 * MINUTE), null, "the end is exclusive");
  assert.deepEqual(currentAndUpcoming(windows, T0).map((item) => item.id), ["db_upgrade", "later"], "a week ahead at most");
});

const run = (at: number, down: readonly string[]): CheckResult[] => fixtureTargets().components.map((component) => ({
  checkId: `${component.id}_http`, componentId: component.id, type: "http", status: down.includes(component.id) ? "down" : "ok", inconclusive: false,
  latencyMs: 5, detail: down.includes(component.id) ? "status_503" : "ok", observedAt: at, data: null,
}));

void test("maintenance: failures are recorded but open nothing; still failing at the end opens (and pages) on the next run", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  const problems = new Problems();
  const maintenance = parseMaintenance([window()], KNOWN, problems);
  for (let minute = 0; minute < 30; minute += 1) {
    const outcome = store.recordRun(run(T0 + minute * MINUTE, ["signup"]), fixtureTargets(), examplePolicy(), T0 + minute * MINUTE, { maintenance });
    assert.deepEqual(outcome.opened, [], `minute ${String(minute)}`);
  }
  const during = store.component("signup");
  assert.deepEqual([during.status, during.consecutiveFailures, during.openIncidentId], ["down", 30, null], "counted, shown as down, nothing open");
  assert.equal(store.notifications().length, 0, "nothing paged");
  const after = store.recordRun(run(T0 + 30 * MINUTE, ["signup"]), fixtureTargets(), examplePolicy(), T0 + 30 * MINUTE, { maintenance });
  assert.equal(after.opened.length, 1, "the first failing run after the window opens");
  const id = after.opened[0] ?? "";
  assert.ok(store.notifications().some((row) => row.kind === "page" && row.incidentId === id));
  assert.ok(store.incidentEvents(id).some((event) => event.type === "maintenance" && event.code === "db_upgrade"), "the timeline names the window");

  // A component that recovers inside its window opens nothing afterwards.
  const quiet = new MonitorStore(sqliteStorage(), countingRandom());
  for (let minute = 0; minute < 31; minute += 1) {
    quiet.recordRun(run(T0 + minute * MINUTE, minute < 5 ? ["signup"] : []), fixtureTargets(), examplePolicy(), T0 + minute * MINUTE, { maintenance });
  }
  assert.equal(quiet.notifications().length, 0);
  assert.equal(quiet.getMeta("maintenance_suppressed:signup"), "", "a passing run forgets the suppressed window");
});

void test("maintenance: a window full of failures does not prime the flapping rule; one blip after a recovery opens nothing", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  const maintenance = parseMaintenance([window()], KNOWN, new Problems());
  const at = (minute: number, down: readonly string[]) =>
    store.recordRun(run(T0 + minute * MINUTE, down), fixtureTargets(), examplePolicy(), T0 + minute * MINUTE, { maintenance });
  for (let minute = 0; minute < 30; minute += 1) at(minute, ["signup"]);
  assert.deepEqual([at(30, []).opened, at(31, []).opened], [[], []], "recovered by the end of the window");
  assert.deepEqual(at(32, ["signup"]).opened, [], "a single failing run after the window is a blip, not an incident");
  assert.equal(store.notifications().length, 0, "nobody paged");
  assert.equal(at(33, ["signup"]).opened.length, 1, "two in a row still open as usual");
});

void test("maintenance: an incident that resolves inside a window clears the flapping history; one blip after the window opens nothing", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  const maintenance = parseMaintenance([window()], KNOWN, new Problems());
  const at = (minute: number, down: readonly string[]) =>
    store.recordRun(run(T0 + minute * MINUTE, down), fixtureTargets(), examplePolicy(), T0 + minute * MINUTE, { maintenance });
  // Signup goes down before the window, opens an incident, and keeps failing: eight failures since it opened.
  const [id = ""] = [at(-10, ["signup"]), at(-9, ["signup"])].flatMap((outcome) => outcome.opened);
  for (let minute = -8; minute < 0; minute += 1) at(minute, ["signup"]);
  // An operator starts the window to fix it; signup recovers inside it and the incident resolves there.
  assert.deepEqual([0, 1, 2].flatMap((minute) => at(minute, []).resolved), [id], "resolved inside the window");
  for (let minute = 3; minute < 32; minute += 1) at(minute, []);
  assert.deepEqual(at(32, ["signup"]).opened, [], "a single failing run after the window is a blip, not an incident");
  assert.equal(at(33, ["signup"]).opened.length, 1, "two in a row still open as usual");
});

void test("maintenance: the public page gets the window times (not the note); the private view gets everything", () => {
  const env = {
    MONITOR_TARGETS: read("test/support/targets.fixture.json"), ESCALATION_POLICY: read("config/escalation.example.json"),
    STATUS_PAGE_URL: "https://status.example.com",
    TWILIO_WEBHOOK_URL: "https://status.example.com/hooks/twilio", MONITOR_HEALTH_KEY: "h".repeat(40), ACK_SIGNING_KEY: "a".repeat(40), DELIVERY_MODE: "log",
    PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config", ALERT_EMAIL_FROM: "alerts@example.com",
  };
  const document = { ...readRecord("config/platform-config.example.json"), maintenance: [window()] };
  const parsed = parsePlatformDocument(JSON.stringify(document), documentContext(env));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("\n"));
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun(run(T0, ["signup"]), fixtureTargets(), examplePolicy(), T0, { maintenance: parsed.document.sections.maintenance });
  const loaded = { ok: true as const, config: {
    brandName: "Acme", mode: "platform" as const, targets: fixtureTargets(), policy: examplePolicy(), maintenance: parsed.document.sections.maintenance,
    statusPageUrl: "https://status.example.com",
    twilioWebhookUrl: "https://status.example.com/hooks/twilio", healthKey: null, configKey: null, ackSigningKey: "a".repeat(40), twilio: null, email: null,
    heartbeatUrl: null, heartbeatFailUrl: null, dnsSecondaryResolver: null, deliveryMode: "log" as const, source: { kind: "platform" as const, revision: 7 },
  } };
  const snapshot = fullSnapshot(store, loaded, T0 + MINUTE);
  const view = publicProjection(snapshot);
  assert.equal(view.components.find((component) => component.id === "signup")?.maintenanceUntil, iso(T0 + 30 * MINUTE));
  assert.equal(view.components.find((component) => component.id === "forums")?.maintenanceUntil, null);
  assert.deepEqual(view.maintenance, [{ components: ["signup"], startsAt: iso(T0), endsAt: iso(T0 + 30 * MINUTE), active: true }]);
  assert.ok(!JSON.stringify(view).includes("Database upgrade"), "the note is free text: private only");
  const privateView = privateProjection(snapshot);
  assert.ok(JSON.stringify(privateView["maintenanceWindows"]).includes("Database upgrade"));
});

void test("document: maintenance is required from revision 1, null at revision 0, and checked against the effective components", () => {
  const context = documentContext({
    MONITOR_TARGETS: read("test/support/targets.fixture.json"), PLATFORM_CONFIG_URL: "https://platform.example.com/api/v2/monitor/config",
    ALERT_EMAIL_FROM: "alerts@example.com",
  });
  const base: unknown = JSON.parse(read("config/platform-config.example.json"));
  if (!isRecord(base)) throw new Error("example document unreadable");
  const errors = (document: Record<string, unknown>): string => {
    const parsed = parsePlatformDocument(JSON.stringify(document), context);
    return parsed.ok ? "" : parsed.errors.join("\n");
  };
  assert.equal(errors({ ...base, maintenance: [window()] }), "", "targets null: the built-in components count");
  assert.match(errors({ ...base, maintenance: undefined }), /maintenance: must be an array/);
  assert.match(errors({ ...base, maintenance: [window({ components: ["upload_two"] })] }), /unknown component upload_two/);
  const targets = {
    version: 1, components: [{ id: "web", name: "Web" }], checks: [{ id: "web_http", component: "web", type: "http", url: "https://example.com/" }],
  };
  assert.match(errors({ ...base, targets, maintenance: [window()] }), /unknown component signup/, "with targets, only their components");
  assert.match(errors({ schema: 1, revision: 0, updatedAt: null, updatedBy: null, policy: null, targets: null, senders: null, maintenance: [] }),
    /must carry no sections/);
});

const policyWith = (edit: Record<string, unknown>): string => {
  const problems = new Problems();
  parsePolicy({ ...readRecord("config/escalation.example.json"), ...edit }, problems);
  return problems.list.join("\n");
};

void test("policy: timeZone, reminderMinutes and drill, with their defaults", () => {
  const defaults = parsePolicy({ version: 1, tiers: [{ id: "solo", name: "Solo", contacts: [{ id: "me", name: "Me", email: "me@example.com" }] }] });
  assert.deepEqual([defaults?.timeZone, defaults?.reminderMinutes, defaults?.drill], ["UTC", 60, { enabled: false, weekday: 3, time: "10:00" }]);
  assert.equal(policyWith({ timeZone: "America/Chicago" }), "");
  assert.match(policyWith({ timeZone: "Eastern" }), /timeZone: must be an IANA time zone name/);
  assert.match(policyWith({ timeZone: "" }), /timeZone/);
  assert.equal(policyWith({ reminderMinutes: 0 }), "", "0 turns reminders off");
  assert.equal(policyWith({ reminderMinutes: 15 }), "");
  for (const bad of [14, 1441, 30.5, "60"]) {
    assert.match(policyWith({ reminderMinutes: bad }), /reminderMinutes: must be 0 \(off\) or an integer from 15 to 1440/);
  }
  assert.equal(policyWith({ drill: { enabled: true, weekday: 7, time: "23:59" } }), "");
  assert.match(policyWith({ drill: { enabled: "yes", weekday: 3, time: "10:00" } }), /drill\.enabled: must be a boolean/);
  assert.match(policyWith({ drill: { enabled: true, weekday: 0, time: "10:00" } }), /drill\.weekday: must be an ISO weekday/);
  assert.match(policyWith({ drill: { enabled: true, weekday: 8, time: "10:00" } }), /drill\.weekday/);
  assert.match(policyWith({ drill: { enabled: true, weekday: 3, time: "24:00" } }), /drill\.time: must be HH:MM/);
  assert.match(policyWith({ drill: { enabled: true, weekday: 3, time: "9:00" } }), /drill\.time/);
});

void test("free text: tier, component and contact names and bodyIncludes are at most 60 printable characters on one line", () => {
  const tiers = asRecords(readRecord("config/escalation.example.json")["tiers"]);
  const [first, ...rest] = tiers;
  assert.match(policyWith({ tiers: [{ ...first, name: "x".repeat(61) }, ...rest] }), /tiers\[0\]\.name: must be at most 60 printable characters/);
  assert.equal(policyWith({ tiers: [{ ...first, name: "x".repeat(60) }, ...rest] }), "");
  assert.match(policyWith({ tiers: [{ ...first, name: "On call\u2028night" }, ...rest] }), /on one line/);
  assert.match(policyWith({ tiers: [{ ...first, contacts: [{ id: "a", name: "Tab\there", email: "a@example.com" }] }, ...rest] }),
    /contacts\[0\]\.name: must be at most 60 printable characters on one line/);
  const targets = readRecord("test/support/targets.fixture.json");
  const components = asRecords(targets["components"]), checks = asRecords(targets["checks"]);
  const check = (value: Record<string, unknown>): string => {
    const problems = new Problems();
    parseTargets(value, problems);
    return problems.list.join("\n");
  };
  const longName = [{ id: "signup", name: "P".repeat(61) }, ...components.slice(1)];
  assert.match(check({ ...targets, components: longName }), /components\[0\]\.name: must be at most 60/);
  assert.match(check({ ...targets, checks: [{ ...checks[0], bodyIncludes: "y".repeat(61) }, ...checks.slice(1)] }),
    /bodyIncludes: must be 1 to 60 printable characters/);
});

void test("parity: U+0000 and lone surrogates are refused in any string or key; URL length is measured on the canonical URL", () => {
  const targets = readRecord("test/support/targets.fixture.json");
  const problems = (value: unknown): string => {
    const found = new Problems();
    parseTargets(value, found);
    return found.list.join("\n");
  };
  assert.match(problems({ ...targets, extra: "a\u0000b" }), /targets\.extra: must not contain U\+0000 or an unpaired surrogate/);
  assert.match(problems({ ...targets, extra: { "k\ud800": 1 } }), /must not contain a key with U\+0000/);
  assert.match(problems({ ...targets, extra: ["\udc00x"] }), /targets\.extra\[0\]: must not contain U\+0000/);
  assert.equal(problems({ ...targets, extra: "😀" }), "", "a complete surrogate pair (an emoji) is fine");
  const withUrl = (url: string): string => problems({ ...targets, checks: [{ id: "u", component: "signup", type: "http", url }] });
  assert.match(withUrl(`https://example.com/${"a ".repeat(600)}z`), /url: must be at most 2048 characters \(as normalised\)/,
    "1222 characters as typed, 2422 once the spaces are percent-encoded");
  assert.equal(withUrl(`https://example.com/${"\t".repeat(3000)}x`), "", "the parser drops tabs: the canonical URL is short");
  const policyProblems = new Problems();
  parsePolicy({ ...readRecord("config/escalation.example.json"), note: "\u0000" }, policyProblems);
  assert.match(policyProblems.list.join("\n"), /policy\.note: must not contain U\+0000/);
});
