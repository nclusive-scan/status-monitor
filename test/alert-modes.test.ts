// Per-component alert modes and public visibility (round 3): an email-only component sends exactly one opening and one
// resolved email to the first tier's email contacts and nothing else, a silent one notifies nobody, incidents of
// different modes never share a group, a private component never reaches /api/status, and a page with no public
// component shows a neutral empty state.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ConfigResult, EscalationPolicy, MonitorConfig, TargetsConfig } from "../worker/config.ts";
import { parsePolicy, parseTargets } from "../worker/config.ts";
import { deliver } from "../worker/deliver.ts";
import type { MaintenanceWindow } from "../worker/maintenance.ts";
import type { EmailMessage } from "../worker/notify/email.ts";
import { privateProjection, publicProjection } from "../worker/redact.ts";
import { fullSnapshot, publicSnapshot } from "../worker/status-view.ts";
import { MonitorStore } from "../worker/store.ts";
import type { CheckResult, Status } from "../worker/types.ts";
import { configWarnings } from "../worker/warnings.ts";
import { HEADLINE, summarize } from "../status-page/src/model.ts";
import { warningText } from "../status-page/src/operator.ts";
import { bootstrapTargets, countingRandom, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

const http = (component: string): Record<string, unknown> => ({ id: `${component}_http`, component, type: "http", url: `https://${component}.example.test/` });
const parsedTargets = (components: readonly Record<string, unknown>[]): TargetsConfig => {
  const targets = parseTargets({ version: 1, components, checks: components.map((component) => http(String(component["id"]))) });
  if (targets === null) throw new Error("targets invalid");
  return targets;
};

/** Production pages and is public; staging alerts by email and is private; "quiet" is recorded only. */
const targets = parsedTargets([
  { id: "prod_web", name: "Web app", alert: "page", public: true },
  { id: "prod_api", name: "API", alert: "page", public: true },
  { id: "staging_web", name: "Staging web app", alert: "email", public: false },
  { id: "staging_forums", name: "Staging Forums", alert: "email", public: false },
  { id: "quiet", name: "Quiet", alert: "none", public: false },
]);

/** A first tier with an SMS-and-email contact, an SMS-only one and an email-only one; short timeouts and reminders. */
function policyWith(firstTier: readonly Record<string, unknown>[]): EscalationPolicy {
  const policy = parsePolicy({
    version: 1, maxCycles: 2, reminderMinutes: 15, tiers: [
      { id: "primary", name: "Primary", ackTimeoutMinutes: 1, contacts: firstTier },
      {
        id: "secondary", name: "Secondary", ackTimeoutMinutes: 1,
        contacts: [{ id: "second", name: "Second", sms: "+15555550110", email: "second@example.com" }],
      },
    ],
  });
  if (policy === null) throw new Error("policy invalid");
  return policy;
}
const policy = policyWith([
  { id: "both", name: "Both", sms: "+15555550100", email: "both@example.com" },
  { id: "sms_only", name: "Sms Only", sms: "+15555550101" },
  { id: "mail_only", name: "Mail Only", email: "mail@example.com" },
]);

const result = (componentId: string, status: Status, at: number): CheckResult => ({
  checkId: `${componentId}_http`, componentId, type: "http", status, inconclusive: false, latencyMs: 10, detail: status === "ok" ? "ok" : "status_503",
  observedAt: at, data: null,
});
const run = (store: MonitorStore, at: number, down: readonly string[], config: TargetsConfig = targets): { opened: string[]; resolved: string[] } =>
  store.recordRun(config.components.map((item) => result(item.id, down.includes(item.id) ? "down" : "ok", at)), config, policy, at);
const newStore = (): MonitorStore => new MonitorStore(sqliteStorage(), countingRandom());

/** Every minute from `from` to `to`: escalation alarms fire and every due outbox row is "sent". */
function pump(store: MonitorStore, from: number, to: number): void {
  for (let at = from; at <= to; at += MINUTE) {
    store.advanceDue(policy, at);
    for (const claimed of store.claimDue(at, 100)) store.markSent(claimed.row.key, `log:${claimed.row.channel}`, at, policy);
  }
}

/** Opens incidents for `down` with two failing runs at `at` and `at + 1 min`; returns the ids opened. */
function open(store: MonitorStore, at: number, down: readonly string[]): string[] {
  run(store, at, down);
  return run(store, at + MINUTE, down).opened;
}

const sent = (store: MonitorStore): string[][] => store.notifications(1000).map((row) => [row.kind, row.contactId, row.channel, row.status]).sort();

const config = (overrides: Partial<MonitorConfig> = {}): MonitorConfig => ({
  brandName: "Acme", mode: "standalone", targets, policy, statusPageUrl: "https://status.example.test", twilioWebhookUrl: "https://status.example.test/hooks/twilio", healthKey: null,
  configKey: null, ackSigningKey: "a".repeat(40), twilio: null, email: { from: "alerts@example.test", fromName: "Acme Status" }, heartbeatUrl: null,
  heartbeatFailUrl: null, dnsSecondaryResolver: null, maintenance: [], deliveryMode: "log", source: { kind: "bootstrap" }, ...overrides,
});
const loaded = (overrides: Partial<MonitorConfig> = {}): ConfigResult => ({ ok: true, config: config(overrides) });

void test("email-only: one opening and one resolved email to each first-tier email contact; no SMS, escalation, reminder or ACK", () => {
  const store = newStore();
  const [id] = open(store, T0, ["staging_web"]);
  assert.ok(id !== undefined);
  const incident = store.incident(id);
  assert.deepEqual([incident?.alertMode, incident?.phase, incident?.escalation, incident?.nextAlarmAt, incident?.groupId, incident?.ackCode],
    ["email", "email_only", null, null, id, ""], "no escalation state, no alarm, its own group, no ACK code");
  // Six hours down: with paging this would have run both cycles and sent reminders every 15 minutes.
  pump(store, T0 + MINUTE, T0 + 6 * 60 * MINUTE);
  assert.deepEqual(sent(store), [["email_alert", "both", "email", "sent"], ["email_alert", "mail_only", "email", "sent"]]);
  assert.deepEqual(store.pagingHealth(T0 + 6 * 60 * MINUTE), { failedPages: 0, oldestPendingMs: null }, "not paging");
  const recover = T0 + 6 * 60 * MINUTE;
  for (let index = 1; index <= 3; index += 1) run(store, recover + index * MINUTE, []);
  assert.ok(store.incident(id)?.resolvedAt !== null, "resolved after three passing runs");
  pump(store, recover + 3 * MINUTE, recover + 3 * 60 * MINUTE);
  assert.deepEqual(sent(store), [
    ["email_alert", "both", "email", "sent"], ["email_alert", "mail_only", "email", "sent"],
    ["email_alert_resolved", "both", "email", "sent"], ["email_alert_resolved", "mail_only", "email", "sent"],
  ], "exactly one opening and one resolved email each, never SMS, never the second tier");
  const types = store.incidentEvents(id).map((event) => event.type);
  for (const type of ["paged", "escalated", "reminded", "acked"]) assert.ok(!types.includes(type), `no ${type} event`);
});

void test("email-only: the messages ask nothing and name the component; a failed email never fails over to SMS or escalates", async () => {
  const store = newStore();
  const [id] = open(store, T0, ["staging_web"]);
  assert.ok(id !== undefined);
  const mails: EmailMessage[] = [];
  const email = { send: (message: EmailMessage) => { mails.push(message); return Promise.resolve({ ok: true as const, providerId: "m" }); } };
  for (const claimed of store.claimDue(T0 + MINUTE)) {
    const outcome = await deliver(claimed.row, claimed.incident, { config: config({ deliveryMode: "live" }), fetch, email, now: T0 + MINUTE });
    assert.ok(outcome.ok);
  }
  assert.deepEqual(mails.map((mail) => [mail.to, mail.subject]), [["both@example.com", "[Acme] Staging web app is down"],
    ["mail@example.com", "[Acme] Staging web app is down"]]);
  for (const mail of mails) {
    assert.doesNotMatch(mail.text, /ACK|\/ack\/|[Ee]scalat/, "no ACK code, link or escalation");
    assert.match(mail.text, /Nothing to acknowledge/);
  }

  const failing = newStore();
  const [other] = open(failing, T0, ["staging_forums"]);
  assert.ok(other !== undefined);
  for (const claimed of failing.claimDue(T0 + MINUTE)) failing.markFailed(claimed.row.key, "email_recipient_suppressed", false, T0 + MINUTE, policy);
  pump(failing, T0 + 2 * MINUTE, T0 + 60 * MINUTE);
  const rows = failing.notifications(1000);
  assert.ok(rows.every((row) => row.channel === "email"), "no SMS failover");
  assert.ok(rows.filter((row) => row.kind === "email_alert").every((row) => row.status === "failed"), "the failure is recorded");
  assert.ok(failing.incidentEvents(other).some((event) => event.type === "failed"), "and archived in the timeline");
  assert.equal(failing.incident(other)?.escalation, null, "and nothing escalates");
});

void test("email-only: an opening email still unsent at resolution is cancelled, and that contact gets no resolved email", () => {
  const store = newStore();
  const [id] = open(store, T0, ["staging_web"]);
  assert.ok(id !== undefined);
  for (let index = 2; index <= 4; index += 1) run(store, T0 + index * MINUTE, []);
  assert.deepEqual(sent(store), [["email_alert", "both", "email", "cancelled"], ["email_alert", "mail_only", "email", "cancelled"]]);
});

void test("alert none: the incident is recorded, resolved and reported, and nobody is notified", () => {
  const store = newStore();
  const [id] = open(store, T0, ["quiet"]);
  assert.ok(id !== undefined);
  assert.deepEqual([store.incident(id)?.alertMode, store.incident(id)?.phase], ["none", "no_alert"]);
  pump(store, T0 + MINUTE, T0 + 3 * 60 * MINUTE);
  for (let index = 1; index <= 3; index += 1) run(store, T0 + 3 * 60 * MINUTE + index * MINUTE, []);
  pump(store, T0 + 3 * 60 * MINUTE, T0 + 4 * 60 * MINUTE);
  assert.deepEqual(store.notifications(1000), [], "no notification of any kind");
  assert.ok(store.incident(id)?.resolvedAt !== null);
  assert.deepEqual(store.unexportedIncidents().map((incident) => incident.id), [id], "handed to the platform's archive");
});

void test("groups never mix alert modes: an email-only incident neither joins, starts nor carries a page", () => {
  const store = newStore();
  const [page] = open(store, T0, ["prod_web"]);
  run(store, T0 + 2 * MINUTE, ["prod_web", "staging_web"]);
  const [mail] = run(store, T0 + 3 * MINUTE, ["prod_web", "staging_web"]).opened;
  run(store, T0 + 4 * MINUTE, ["prod_web", "staging_web", "prod_api"]);
  const [member] = run(store, T0 + 5 * MINUTE, ["prod_web", "staging_web", "prod_api"]).opened;
  assert.ok(page !== undefined && mail !== undefined && member !== undefined);
  assert.equal(store.incident(mail)?.groupId, mail, "the email-only incident opened inside the window but stays on its own");
  assert.equal(store.incident(mail)?.phase, "email_only");
  assert.deepEqual([store.incident(member)?.groupId, store.incident(member)?.phase], [page, "grouped"], "a page incident still joins the page group");
  const carrier = store.incident(page);
  assert.ok(carrier !== null);
  assert.deepEqual(store.alsoAffected(carrier), ["prod_api"], "the page names only paging components");
  // The carrier recovers: the page member takes over, never the email-only incident.
  for (let index = 6; index <= 8; index += 1) run(store, T0 + index * MINUTE, ["staging_web", "prod_api"]);
  const successor = store.incident(member);
  assert.ok(successor?.phase !== "grouped" && successor?.escalation?.incidentId === member, "the paging member carries the escalation on");
  assert.deepEqual([store.incident(mail)?.phase, store.incident(mail)?.escalation], ["email_only", null], "the email-only incident is untouched");
  assert.ok(store.notifications(1000).filter((row) => row.incidentId === mail).every((row) => row.kind === "email_alert"));

  // The reverse: an email-only incident open first does not absorb a production incident that follows.
  const reverse = newStore();
  const [first] = open(reverse, T0, ["staging_web"]);
  run(reverse, T0 + 2 * MINUTE, ["staging_web", "prod_web"]);
  const [prod] = run(reverse, T0 + 3 * MINUTE, ["staging_web", "prod_web"]).opened;
  assert.ok(first !== undefined && prod !== undefined);
  assert.deepEqual([reverse.incident(prod)?.groupId, reverse.incident(prod)?.phase], [prod, "paging"], "production pages on its own");
  assert.ok(reverse.notifications(1000).some((row) => row.incidentId === prod && row.kind === "page" && row.channel === "sms"));
});

void test("public: false stays out of /api/status (status, overall, uptime, incidents, maintenance) and stays in /api/private", () => {
  const store = newStore();
  open(store, T0, ["staging_web", "quiet"]);
  const window = (id: string, components: readonly string[] | "all"): MaintenanceWindow => ({
    id, components: components === "all" ? "all" : [...components], startsAt: T0, endsAt: T0 + 60 * MINUTE, note: "",
  });
  const maintenance = [window("staging_only", ["staging_forums"]), window("mixed", ["staging_web", "prod_api"]), window("everything", "all")];
  const now = T0 + 2 * MINUTE;
  const view = publicProjection(publicSnapshot(store, loaded({ maintenance }), now));
  assert.deepEqual(view.components.map((component) => component.id), ["prod_web", "prod_api"]);
  assert.equal(view.overall, "ok", "a private component that is down does not turn the public overall status red");
  assert.deepEqual(view.incidents, [], "its incidents are not public");
  assert.deepEqual(view.maintenance.map((item) => item.components), [["prod_api"], "all"], "only public components are named");
  assert.doesNotMatch(JSON.stringify(view), /staging|Staging|quiet|Quiet/, "nothing of a private component");

  const full = privateProjection(fullSnapshot(store, loaded({ maintenance }), now));
  const components = full["components"];
  assert.ok(Array.isArray(components));
  assert.equal(components.length, 5, "the operator view lists every component");
  assert.equal(full["overall"], "down");
  const incidents = full["incidents"];
  assert.ok(Array.isArray(incidents) && incidents.length === 2);
  const escalation = full["escalation"];
  assert.ok(Array.isArray(escalation));
  assert.ok(escalation.some((entry: unknown) => typeof entry === "object" && entry !== null && Reflect.get(entry, "alert") === "email"
    && Reflect.get(entry, "ackCode") === null), "the email-only incident shows its mode and no ACK code");
});

void test("empty public state: no public component gives overall none and a neutral page, stale or not; a refused config stays unknown", () => {
  const store = newStore();
  const example = bootstrapTargets();
  const staging = { ...example, components: example.components.map((component) => ({ ...component, alert: "email" as const, public: false })) };
  run(store, T0, ["website"], staging);
  const fresh = publicProjection(publicSnapshot(store, loaded({ targets: staging }), T0 + MINUTE));
  assert.deepEqual([fresh.overall, fresh.components, fresh.incidents, fresh.monitor.stale], ["none", [], [], false]);
  const stale = publicProjection(publicSnapshot(store, loaded({ targets: staging }), T0 + 60 * MINUTE));
  assert.deepEqual([stale.overall, stale.monitor.stale], ["none", true], "nothing public for a stale monitor to vouch for");
  const refused = publicProjection(publicSnapshot(store, { ok: false, errors: ["policy: must be an object"] }, T0 + MINUTE));
  assert.equal(refused.overall, "unknown", "a refused configuration is not an empty one");

  for (const data of [fresh, stale]) {
    const summary = summarize({ ...data, components: [], incidents: [], maintenance: [] }, (iso) => iso ?? "never");
    assert.deepEqual([summary.overall, summary.headline, summary.components, summary.incidents], ["none", "No services are listed here yet.", [],
      { open: [], past: [] }]);
    assert.notEqual(summary.headline, HEADLINE.ok);
    assert.notEqual(summary.headline, HEADLINE.unknown);
  }
  const view = readFileSync(new URL("../status-page/src/PublicView.tsx", import.meta.url), "utf8");
  assert.match(view, /const empty = summary\.overall === "none";/);
  assert.match(view, /\{empty \? null : \(/, "the empty state shows no service, chart, check or incident sections");
});

void test("email_alert_no_recipient: an email-only component with no email contact in the first tier", () => {
  const noEmail = policyWith([{ id: "sms_only", name: "Sms Only", sms: "+15555550101" }]);
  assert.ok(configWarnings(config({ policy: noEmail })).includes("email_alert_no_recipient"));
  assert.ok(!configWarnings(config()).includes("email_alert_no_recipient"), "a first-tier email contact receives it");
  const pagingOnly = parsedTargets([{ id: "prod_web", name: "Web app" }]);
  assert.ok(!configWarnings(config({ policy: noEmail, targets: pagingOnly })).includes("email_alert_no_recipient"), "nothing alerts by email");
  assert.match(warningText("email_alert_no_recipient"), /first tier has no email address/);

  // At runtime the incident still opens and records why nobody was told.
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  store.recordRun([result("staging_web", "down", T0)], targets, noEmail, T0);
  const [id] = store.recordRun([result("staging_web", "down", T0 + MINUTE)], targets, noEmail, T0 + MINUTE).opened;
  assert.ok(id !== undefined);
  assert.deepEqual(store.notifications(), []);
  assert.ok(store.incidentEvents(id).some((event) => event.code === "email_alert_no_recipient"));
});
