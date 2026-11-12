// The monitor store's row shapes (store.ts): its constants, the types it hands out, and the readers that turn SQLite
// rows into them. Split from store.ts to keep each file readable; store.ts re-exports everything public here.
import type { AlertMode, Contact, EscalationPolicy } from "./config.ts";
import { FAILED_STATUSES, PENDING_STATUSES } from "./delivery-health.ts";
import type { EmailAlertKind } from "./email-alert.ts";
import { alertModeOf, EMAIL_ALERT_KINDS } from "./email-alert.ts";
import type { AckVia, EscalationState, Send } from "./escalation.ts";
import { parseEscalationState } from "./escalation.ts";
import type { SqlRow } from "./schema.ts";
import { nullableNum, nullableText, num, text } from "./schema.ts";
import type { Status } from "./types.ts";
import { isStatus } from "./types.ts";

/** History and incidents the platform has archived are kept this long. */
export const RETENTION_MS = 35 * 24 * 3600_000;
/** A resolved incident the platform never archived is kept this long, then pruned with a recorded warning. */
export const UNEXPORTED_RETENTION_MS = 180 * 24 * 3600_000;
export const HOUR = 3600_000;
export const MAX_ATTEMPTS = 8;
/** Deliveries run at most DELIVERY_CONCURRENCY at a time, each bounded by its provider timeout (Twilio 15 s, email 20 s). */
export const DELIVERY_CONCURRENCY = 5;
export const CLAIM_BATCH = 25;
export const WORST_SEND_MS = 20_000;
/**
 * A claimed row's lease. It must outlast the slowest batch: CLAIM_BATCH rows queued DELIVERY_CONCURRENCY at a time,
 * each taking up to WORST_SEND_MS (100 s), or an overlapping alarm would claim and send a row still in flight.
 */
export const CLAIM_MS = 180_000;
export const GROUP_WINDOW_MS = 10 * 60_000;
export const OPEN_INCIDENT_CAP = 200;
/** Report entries: incidents per report. */
export const REPORT_INCIDENTS = 20;
/** Sends that ask someone to act. They are cancelled once the group is acknowledged or the incident closes. */
export const ACTION_KINDS: readonly Send["kind"][] = ["page", "escalation_notice", "cycle_notice", "exhausted", "reminder"];
export const ACTION_KINDS_SQL = ACTION_KINDS.map((kind) => `'${kind}'`).join(", ");
export const FAILED_STATUSES_SQL = FAILED_STATUSES.map((status) => `'${status}'`).join(", ");
export const PENDING_STATUSES_SQL = PENDING_STATUSES.map((status) => `'${status}'`).join(", ");
/** SMS replies to one contact: at most REPLY_LIMIT in REPLY_WINDOW_MS (a loop with an auto-responder stops here). */
export const REPLY_LIMIT = 5;
export const REPLY_WINDOW_MS = 10 * 60_000;
/** The channel-health SMS for one email failure code goes at most this often. */
export const CHANNEL_NOTICE_EVERY_MS = 3600_000;

export interface IncidentRow {
  readonly id: string;
  readonly componentId: string;
  readonly title: string;
  readonly openedAt: number;
  readonly ackCode: string;
  readonly phase: string;
  readonly acknowledgedAt: number | null;
  readonly acknowledgedBy: string | null;
  readonly resolvedAt: number | null;
  readonly nextAlarmAt: number | null;
  readonly escalation: EscalationState | null;
  /** The group this incident belongs to: its own id unless it joined another incident's escalation. */
  readonly groupId: string;
  /** Why it closed: "recovered", "component_removed", "drill_acknowledged" or "drill_missed"; null while open. */
  readonly closeReason: string | null;
  /** A weekly drill: one contact paged with a [TEST] message, never escalated, never on the status page. */
  readonly drill: boolean;
  /** The worst status seen while open ("down" or "degraded"); null for a drill. */
  readonly peakStatus: Status | null;
  /** Contact id and channel of the acknowledgement (null for an operator or before one). */
  readonly acknowledgedContact: string | null;
  readonly acknowledgedVia: "sms" | "email" | null;
  /** When the platform confirmed it archived this incident. */
  readonly exportedAt: number | null;
  /** How it notifies, from its component's alert setting when it opened ("page" for every incident before that setting). */
  readonly alertMode: AlertMode;
  /** Who carries this incident's earlier pages after its component stopped paging (null: its own group does). */
  readonly handedOverTo: string | null;
}

/** What a config-change notice reports: names only, never numbers or addresses. */
export interface ConfigChange {
  readonly revision: number;
  readonly updatedBy: string | null;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** "<name>: mobile changed" / "<name>: email changed" for a contact whose channels changed. */
  readonly changed: readonly string[];
}

/**
 * config_change, monitor_notice, contact_notice and channel_notice belong to no incident (incident_id "cfg_r<revision>",
 * "mon_<code>_<ms>", "ctc_<contactId>_<ms>", "chn_<code>_<ms>"); drill_missed belongs to the drill incident.
 *   contact_notice  email to the first tier (and, for an opt-out, the contact): a contact's channel stopped working
 *   channel_notice  to the first tier on the other channel: by SMS when alert email is failing account-wide, by
 *                   email when alert SMS is (detail: the code)
 */
export type OutboxKind = Send["kind"] | EmailAlertKind | "config_change" | "drill_missed" | "monitor_notice" | "contact_notice" | "channel_notice";
export const OUTBOX_KINDS: readonly OutboxKind[] = [
  "page", "escalation_notice", "cycle_notice", "exhausted", "reminder", "acknowledged", "resolved", "config_change", "drill_missed", "monitor_notice",
  "contact_notice", "channel_notice", ...EMAIL_ALERT_KINDS,
];
export const NON_INCIDENT_KINDS: readonly OutboxKind[] = ["config_change", "monitor_notice", "contact_notice", "channel_notice"];
export const NON_INCIDENT_SQL = NON_INCIDENT_KINDS.map((kind) => `'${kind}'`).join(", ");

export interface OutboxRow {
  readonly key: string;
  readonly incidentId: string;
  readonly kind: OutboxKind;
  readonly contactId: string;
  readonly contactName: string;
  readonly channel: "sms" | "email";
  readonly recipient: string;
  readonly tierId: string | null;
  readonly cycle: number;
  readonly target: Send["target"];
  readonly acknowledgedBy: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly sentAt: number | null;
  readonly providerId: string | null;
  /** Set on a config_change row only. */
  readonly configChange: ConfigChange | null;
  /**
   * drill_missed: the missed contact's name; monitor_notice: the notice code; contact_notice: the problem
   * ("opted_out", "undeliverable", "suppressed", with ":self" for the contact's own copy); channel_notice: the code.
   */
  readonly detail: string | null;
  /** contact_notice: the name of the contact it is about. */
  readonly about: string | null;
  /** The provider's latest word (Twilio status callback): queued, sent, delivered, undelivered, failed, ... or unknown. */
  readonly deliveryStatus: string | null;
  readonly deliveryCode: string | null;
}

export type ContactHealthState = "ok" | "opted_out" | "undeliverable" | "suppressed" | "drill_missed";
export const CONTACT_HEALTH_STATES: readonly ContactHealthState[] = ["ok", "opted_out", "undeliverable", "suppressed", "drill_missed"];

export interface ContactHealthRow {
  readonly contactId: string;
  readonly channel: "sms" | "email";
  readonly state: ContactHealthState;
  readonly code: string | null;
  readonly since: number;
}

/** Report timeline entry types (the platform's archive enum). Other event types stay internal to the private view. */
export const TIMELINE_TYPES = ["opened", "paged", "delivered", "failed", "acked", "escalated", "reminded", "resolved", "maintenance"] as const;
export type TimelineType = (typeof TIMELINE_TYPES)[number];

export interface IncidentEvent {
  readonly incidentId: string;
  readonly at: number;
  readonly type: string;
  readonly detail: string;
  readonly tierId: string | null;
  readonly contactId: string | null;
  readonly channel: "sms" | "email" | null;
  readonly code: string | null;
}

/** Optional structured fields of an event (the archived timeline's tierId, contactId, channel and code). */
export interface EventFields {
  readonly tierId?: string | null;
  readonly contactId?: string | null;
  readonly channel?: "sms" | "email" | null;
  readonly code?: string | null;
}

/** What the heartbeat needs to know about paging (heartbeat.ts). */
export interface PagingHealth {
  /** Action sends (pages, notices, reminders) that failed for good while their incident still needs someone. */
  readonly failedPages: number;
  /** Age of the oldest action send still pending, in ms; null when none is pending. */
  readonly oldestPendingMs: number | null;
}

/** The last-known-good platform configuration. */
export interface StoredPlatformConfig {
  readonly revision: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** The validated sections exactly as the platform sent them, as JSON: {"policy", "targets", "senders"}. */
  readonly body: string;
  /** When this revision was last fetched (first accepted, or confirmed unchanged since). */
  readonly fetchedAt: number;
}

export interface ConfigFetchStatus {
  readonly lastSuccessAt: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: number | null;
  readonly lastErrorDetail: string | null;
  /** The revision the error is about (a refused document), when known. */
  readonly lastErrorRevision: number | null;
}

/** The config-change emails to queue with an accepted revision: what changed, and who to tell. */
export interface ConfigNotices {
  readonly change: ConfigChange;
  readonly recipients: readonly { readonly contactId: string; readonly contactName: string; readonly email: string }[];
}

/** A claimed outbox row; a config_change row has no incident. */
export interface Claimed {
  readonly row: OutboxRow;
  readonly incident: IncidentRow | null;
  readonly alsoAffected: string[];
}

export type AcceptOutcome = "accepted" | "unchanged" | "empty" | "refused_lower" | "refused_conflict";

/** What an accepted revision does besides replacing the stored copy, in the same transaction. */
export interface AcceptEffects {
  /** The config-change emails to queue, given the revision it replaces. */
  readonly notices?: (previous: StoredPlatformConfig | null) => ConfigNotices | null;
  /** The effective policy under the accepted revision; incident sends still pending are reconciled with it. */
  readonly policy?: EscalationPolicy | null;
}

export interface CheckLatest {
  readonly checkId: string;
  readonly componentId: string;
  readonly type: string;
  readonly status: Status;
  readonly inconclusive: boolean;
  readonly latencyMs: number;
  readonly detail: string;
  readonly observedAt: number;
  readonly data: unknown;
}

export interface Uptime {
  readonly h24: number | null;
  readonly d7: number | null;
  readonly d30: number | null;
}

export type AckOutcome = "acknowledged" | "already_acknowledged" | "resolved" | "not_found";

/** Who acknowledged: the contact's name (shown in messages), id (archived) and channel. */
export interface AckBy {
  readonly name: string;
  readonly via: AckVia;
  readonly contactId?: string | null;
}

export const channelOf = (value: string | null): "sms" | "email" | null => (value === "sms" || value === "email" ? value : null);

export const channelsOf = (contact: Contact): ("sms" | "email")[] => [
  ...(contact.sms === null ? [] : ["sms" as const]), ...(contact.email === null ? [] : ["email" as const]),
];

export const contactIn = (policy: EscalationPolicy, id: string): Contact | null => {
  for (const tier of policy.tiers) for (const contact of tier.contacts) if (contact.id === id) return contact;
  return null;
};

/** What an escalation request did; tierName is the tier now being paged (null once paging is exhausted). */
export interface EscalateOutcome {
  readonly outcome: "escalated" | "exhausted" | "already_acknowledged" | "resolved" | "not_found" | "drill";
  readonly tierName: string | null;
}

export const statusOf = (value: string): Status => (isStatus(value) ? value : "down");

export const incidentFrom = (row: SqlRow): IncidentRow => {
  let escalation: EscalationState | null = null;
  try {
    escalation = parseEscalationState(JSON.parse(text(row, "escalation")));
  } catch {
    escalation = null;
  }
  return {
    id: text(row, "id"), componentId: text(row, "component_id"), title: text(row, "title"), openedAt: num(row, "opened_at"),
    ackCode: text(row, "ack_code"), phase: text(row, "phase"), acknowledgedAt: nullableNum(row, "acknowledged_at"),
    acknowledgedBy: nullableText(row, "acknowledged_by"), resolvedAt: nullableNum(row, "resolved_at"), nextAlarmAt: nullableNum(row, "next_alarm_at"),
    escalation, groupId: nullableText(row, "group_id") ?? text(row, "id"), closeReason: nullableText(row, "close_reason"),
    drill: num(row, "drill") === 1, peakStatus: isStatus(nullableText(row, "peak_status")) ? statusOf(text(row, "peak_status")) : null,
    acknowledgedContact: nullableText(row, "acknowledged_contact"), acknowledgedVia: channelOf(nullableText(row, "acknowledged_via")),
    exportedAt: nullableNum(row, "exported_at"), alertMode: alertModeOf(nullableText(row, "alert_mode")),
    handedOverTo: nullableText(row, "handed_over_to"),
  };
};

export const eventFrom = (row: SqlRow): IncidentEvent => ({
  incidentId: text(row, "incident_id"), at: num(row, "at"), type: text(row, "type"), detail: text(row, "detail"), tierId: nullableText(row, "tier_id"),
  contactId: nullableText(row, "contact_id"), channel: channelOf(nullableText(row, "channel")), code: nullableText(row, "code"),
});

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function configChangeFrom(value: unknown): ConfigChange | null {
  if (typeof value !== "object" || value === null) return null;
  const revision: unknown = Reflect.get(value, "revision"), by: unknown = Reflect.get(value, "updatedBy");
  if (typeof revision !== "number") return null;
  return {
    revision, updatedBy: typeof by === "string" ? by : null, added: strings(Reflect.get(value, "added")), removed: strings(Reflect.get(value, "removed")),
    changed: strings(Reflect.get(value, "changed")),
  };
}

export const outboxFrom = (row: SqlRow): OutboxRow => {
  let payload: { target: Send["target"]; acknowledgedBy: string | null } = { target: null, acknowledgedBy: null };
  let configChange: ConfigChange | null = null;
  let detail: string | null = null;
  let about: string | null = null;
  try {
    const parsed: unknown = JSON.parse(text(row, "payload"));
    if (typeof parsed === "object" && parsed !== null) {
      configChange = configChangeFrom(Reflect.get(parsed, "configChange"));
      const rawDetail: unknown = Reflect.get(parsed, "detail");
      detail = typeof rawDetail === "string" ? rawDetail : null;
      const rawAbout: unknown = Reflect.get(parsed, "about");
      about = typeof rawAbout === "string" ? rawAbout : null;
      const target: unknown = Reflect.get(parsed, "target"), by: unknown = Reflect.get(parsed, "acknowledgedBy");
      const targetOk = typeof target === "object" && target !== null && typeof Reflect.get(target, "tierName") === "string";
      const names: unknown = targetOk ? Reflect.get(target, "contactNames") : null;
      payload = {
        target: targetOk && Array.isArray(names)
          ? { tierName: String(Reflect.get(target, "tierName")), contactNames: names.map(String) }
          : null,
        acknowledgedBy: typeof by === "string" ? by : null,
      };
    }
  } catch {
    // Unreadable payload: render without the target names.
  }
  const kind = text(row, "kind");
  return {
    key: text(row, "key"), incidentId: text(row, "incident_id"), kind: OUTBOX_KINDS.find((item) => item === kind) ?? "page",
    contactId: text(row, "contact_id"), contactName: text(row, "contact_name"), channel: text(row, "channel") === "email" ? "email" : "sms",
    recipient: text(row, "recipient"), tierId: nullableText(row, "tier_id"), cycle: num(row, "cycle"), target: payload.target,
    acknowledgedBy: payload.acknowledgedBy, status: text(row, "status"), attempts: num(row, "attempts"), lastError: nullableText(row, "last_error"),
    createdAt: num(row, "created_at"), sentAt: nullableNum(row, "sent_at"), providerId: nullableText(row, "provider_id"), configChange, detail, about,
    deliveryStatus: nullableText(row, "delivery_status"), deliveryCode: nullableText(row, "delivery_code"),
  };
};

/** Seconds to wait before attempt n+1 after n failed attempts: 30s, 60s, 120s ... capped at 15 minutes. */
export const backoffMs = (attempts: number): number => Math.min(900_000, 30_000 * 2 ** Math.max(0, attempts - 1));
