// A carrier whose component stops paging hands its group's escalation to a member (changeAlertMode). Its earlier pages
// keep its incident id, so they must still reach whoever carries the group now, exactly as after a recovery hand-over:
// ack links already delivered, contact-level failures (early escalation) and failed pages (paging health). And an
// email-only incident switched away from email and back still tells its first tier.
import assert from "node:assert/strict";
import test from "node:test";
import type { AlertMode, EscalationPolicy, TargetsConfig } from "../worker/config.ts";
import { parsePolicy, parseTargets } from "../worker/config.ts";
import { MonitorStore } from "../worker/store.ts";
import type { CheckResult } from "../worker/types.ts";
import { countingRandom, MINUTE, sqliteStorage, T0 } from "./support/fakes.ts";

function targetsWith(modes: Readonly<Record<string, AlertMode>>): TargetsConfig {
  const ids = Object.keys(modes);
  const targets = parseTargets({
    version: 1,
    components: ids.map((id) => ({ id, name: id.toUpperCase(), alert: modes[id], public: true })),
    checks: ids.map((id) => ({ id: `${id}_http`, component: id, type: "http", url: `https://${id}.example.test/` })),
  });
  if (targets === null) throw new Error("targets");
  return targets;
}

const parsed = parsePolicy({
  version: 1, maxCycles: 2, reminderMinutes: 15, tiers: [
    { id: "primary", name: "Primary", ackTimeoutMinutes: 15, contacts: [{ id: "first", name: "First", sms: "+15555550100", email: "first@example.com" }] },
    { id: "secondary", name: "Secondary", ackTimeoutMinutes: 15, contacts: [{ id: "second", name: "Second", sms: "+15555550110" }] },
  ],
});
if (parsed === null) throw new Error("policy");
const policy: EscalationPolicy = parsed;

const result = (component: string, down: boolean, at: number): CheckResult => ({
  checkId: `${component}_http`, componentId: component, type: "http", status: down ? "down" : "ok", inconclusive: false, latencyMs: 10,
  detail: down ? "status_503" : "ok", observedAt: at, data: null,
});

let providerIds = 0;
function tick(store: MonitorStore, at: number, targets: TargetsConfig, down: readonly string[]): string[] {
  const opened = store.recordRun(targets.components.map((component) => result(component.id, down.includes(component.id), at)), targets, policy, at).opened;
  for (const claimed of store.claimDue(at, 100)) store.markSent(claimed.row.key, `SM${String(++providerIds)}`, at, policy);
  return opened;
}

const bothPage = targetsWith({ web: "page", api: "page" });
const webEmail = targetsWith({ web: "email", api: "page" });

/** web carries the group's escalation and api joins it; web's tier-1 pages are sent. Then web stops paging. */
function flipped(): { store: MonitorStore; carrier: string; member: string; sentByCarrier: ReturnType<MonitorStore["notifications"]> } {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  tick(store, T0, bothPage, ["web", "api"]);
  const [carrier = "", member = ""] = tick(store, T0 + MINUTE, bothPage, ["web", "api"]);
  assert.equal(store.incident(member)?.groupId, carrier);
  const sentByCarrier = store.notifications(1000).filter((row) => row.incidentId === carrier && row.kind === "page" && row.status === "sent");
  assert.ok(sentByCarrier.length > 0);
  tick(store, T0 + 2 * MINUTE, webEmail, ["web", "api"]);
  assert.equal(store.incident(member)?.phase, "paging", "the member carries the escalation now");
  assert.equal(store.incident(carrier)?.handedOverTo, member);
  return { store, carrier, member, sentByCarrier };
}

void test("an ack link from the old carrier's page acknowledges the group that carries it now", () => {
  const { store, carrier, member } = flipped();
  assert.equal(store.acknowledge(carrier, { name: "First", via: "email", contactId: "first" }, policy, T0 + 3 * MINUTE), "acknowledged");
  assert.notEqual(store.incident(member)?.acknowledgedAt, null);
});

void test("the old carrier's tier-1 pages failing at contact level escalate the new carrier at once", () => {
  const { store, member, sentByCarrier } = flipped();
  for (const row of sentByCarrier) {
    const sms = row.channel === "sms";
    store.recordProviderStatus(row.providerId ?? "", sms ? "undelivered" : "failed", sms ? "twilio_30005" : "email_recipient_suppressed", T0 + 3 * MINUTE,
      policy);
  }
  assert.equal(store.incident(member)?.escalation?.tierIndex, 1);
});

void test("a page the old carrier failed still counts in paging health while the group is unacknowledged", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  tick(store, T0, bothPage, ["web", "api"]);
  const [carrier = ""] = tick(store, T0 + MINUTE, bothPage, ["web", "api"]);
  const sms = store.notifications(1000).find((row) => row.incidentId === carrier && row.kind === "page" && row.channel === "sms");
  store.recordProviderStatus(sms?.providerId ?? "", "failed", "30008", T0 + MINUTE + 1, policy);
  assert.equal(store.pagingHealth(T0 + MINUTE + 2).failedPages, 1);
  tick(store, T0 + 2 * MINUTE, webEmail, ["web", "api"]);
  assert.equal(store.pagingHealth(T0 + 3 * MINUTE).failedPages, 1);
});

void test("email, then none, then email while the opening email waits for a retry: the first tier is still told", () => {
  const store = new MonitorStore(sqliteStorage(), countingRandom());
  const email = targetsWith({ web: "email" }), none = targetsWith({ web: "none" });
  store.recordRun([result("web", true, T0)], email, policy, T0);
  const [id = ""] = store.recordRun([result("web", true, T0 + MINUTE)], email, policy, T0 + MINUTE).opened;
  for (const claimed of store.claimDue(T0 + MINUTE, 100)) store.markFailed(claimed.row.key, "email_timeout", true, T0 + MINUTE, policy);
  store.recordRun([result("web", true, T0 + 2 * MINUTE)], none, policy, T0 + 2 * MINUTE);
  store.recordRun([result("web", true, T0 + 3 * MINUTE)], email, policy, T0 + 3 * MINUTE);
  for (let at = T0 + 4 * MINUTE; at < T0 + 65 * MINUTE; at += MINUTE) {
    store.recordRun([result("web", at < T0 + 60 * MINUTE, at)], email, policy, at);
    for (const claimed of store.claimDue(at, 100)) store.markSent(claimed.row.key, "log:email", at, policy);
  }
  assert.notEqual(store.incident(id)?.resolvedAt, null);
  const rows = store.notifications(100).filter((row) => row.incidentId === id);
  assert.deepEqual(rows.filter((row) => row.status === "sent").map((row) => row.kind).sort(), ["email_alert", "email_alert_resolved"]);
  assert.equal(rows.filter((row) => row.channel === "sms").length, 0);
});
