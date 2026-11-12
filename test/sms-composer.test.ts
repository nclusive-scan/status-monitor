// The SMS composer: sizes in GSM-7 septets or UCS-2 units, segment boundaries, and pages that keep the headline,
// the ACK and the link while the detail is cut to two segments. Split from delivery.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { BRAND_NAME_MAX_CHARS } from "../worker/brand.ts";
import { channelNoticeSms, emailContent, smsText } from "../worker/notify/messages.ts";
import type { MessageContext } from "../worker/notify/messages.ts";
import { composeSms, isGsm7, smsSize, toGsmFriendly } from "../worker/notify/sms-text.ts";
import { MINUTE, T0 } from "./support/fakes.ts";

const context = (overrides: Partial<MessageContext> = {}): MessageContext => ({
  brand: "Acme", kind: "page", componentName: "Signup", incidentTitle: "Signup is down", openedAt: T0, ackCode: "K7M2QX", statusPageUrl: "https://status.example.com",
  cycle: 1, maxCycles: 3, targetTierName: "Secondary on-call", targetContactNames: [], acknowledgedBy: null, now: T0 + 5 * MINUTE, ackUrl: null,
  timeZone: "America/New_York", ...overrides,
});

void test("composer: sizes in GSM-7 septets or UCS-2 units, segment boundaries included", () => {
  assert.deepEqual(smsSize("a".repeat(160)), { encoding: "gsm7", units: 160, segments: 1 });
  assert.deepEqual(smsSize("a".repeat(161)), { encoding: "gsm7", units: 161, segments: 2 });
  assert.deepEqual(smsSize("a".repeat(306)), { encoding: "gsm7", units: 306, segments: 2 });
  assert.deepEqual(smsSize("[]"), { encoding: "gsm7", units: 4, segments: 1 }, "brackets are escaped: two septets each");
  assert.deepEqual(smsSize("ł".repeat(70)), { encoding: "ucs2", units: 70, segments: 1 });
  assert.deepEqual(smsSize("ł".repeat(71)), { encoding: "ucs2", units: 71, segments: 2 });
  assert.equal(toGsmFriendly("“Signup” – it’s down… "), "\"Signup\" - it's down... ");
  assert.ok(isGsm7(toGsmFriendly("“Smart” ‘quotes’ — dashes")));
});

void test("composer: an escape or a surrogate pair never straddles a segment boundary, so two segments really are two", () => {
  // 152 + "€" (2 septets) + 152 = 306 septets, but the € cannot start at septet 153: 152 | € + 151 | 1 is three segments.
  assert.deepEqual(smsSize(`${"a".repeat(152)}€${"b".repeat(152)}`), { encoding: "gsm7", units: 306, segments: 3 });
  assert.deepEqual(smsSize(`${"a".repeat(151)}€${"b".repeat(153)}`), { encoding: "gsm7", units: 306, segments: 2 }, "it fits when it ends a segment");
  // UCS-2: 66 + emoji (2 units) + 66 = 134 units, but the pair cannot start at unit 67.
  assert.deepEqual(smsSize(`${"x".repeat(66)}😀${"y".repeat(65)}ł`), { encoding: "ucs2", units: 134, segments: 3 });
  assert.deepEqual(smsSize(`${"x".repeat(65)}😀${"y".repeat(66)}ł`), { encoding: "ucs2", units: 134, segments: 2 });
  // The composer relies on the count: a detail with € at the boundary is cut to fit two real segments.
  const first = "DOWN: API Reply ACK 1234 to acknowledge. s.example/x";
  const detail = `${"d".repeat(152 - first.length - 1)}€${"e".repeat(200)}`;
  const text = composeSms("DOWN: API", "Reply ACK 1234 to acknowledge. s.example/x", detail);
  assert.ok(smsSize(text).segments <= 2, `${String(smsSize(text).segments)} segments`);
  assert.ok(text.endsWith("..."), "the detail was cut");
});

void test("composer: a long page keeps headline, ACK and link on the first line and cuts the detail to two segments", () => {
  const others = Array.from({ length: 30 }, (_, index) => `Component number ${String(index + 1)} with a long public name`);
  const text = smsText(context({ alsoAffected: others }));
  assert.ok(smsSize(text).segments <= 2, `two segments at most, got ${String(smsSize(text).segments)}`);
  assert.equal(smsSize(text).encoding, "gsm7");
  assert.match(
    text, /^\[Acme\] DOWN: Signup \+30\. Reply ACK K7M2QX to acknowledge all 31\. status\.example\.com\nSignup is down since 09:00 EST \(14:00 UTC\)\./,
  );
  assert.ok(text.endsWith("..."), "the cut is marked");
  // Smart punctuation in a name is replaced, so the page stays GSM-7 (160 per segment, not 70).
  const smart = smsText(context({ componentName: "Patient “Signup” – EU" }));
  assert.equal(smsSize(smart).encoding, "gsm7");
  assert.match(smart, /DOWN: Patient "Signup" - EU\./);
});

void test("composer: a non-GSM name switches to UCS-2, still two segments, never splitting a character; the ACK and link always survive", () => {
  const name = "Portál 🚑 Łódź ".repeat(4).trim();
  const text = smsText(context({ componentName: name.slice(0, 60), incidentTitle: `${name} is down`, alsoAffected: [name, name, name] }));
  assert.equal(smsSize(text).encoding, "ucs2");
  assert.ok(smsSize(text).segments <= 2);
  assert.ok(text.includes("Reply ACK K7M2QX to acknowledge all 4. status.example.com"));
  assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone surrogate");
  // A headline too long for two UCS-2 segments on its own is cut itself, keeping the ACK and the link.
  const cut = composeSms(`[Acme] DOWN: ${"Ż".repeat(200)}.`, "Reply ACK K7M2QX to acknowledge. status.example.com", "detail");
  assert.ok(smsSize(cut).segments <= 2);
  assert.ok(cut.endsWith("... Reply ACK K7M2QX to acknowledge. status.example.com"));
});

void test("brand: the longest BRAND_NAME still leaves every page within two GSM-7 segments, prefix, ACK and link intact", () => {
  const brand = "Northside Community Care";
  assert.equal(brand.length, BRAND_NAME_MAX_CHARS);
  const longest = "x".repeat(60);
  const others = Array.from({ length: 30 }, (_, index) => `${longest.slice(0, 50)} ${String(index)}`);
  const statusPageUrl = `https://${"s".repeat(40)}.example.com`;
  const kinds = ["page", "escalation_notice", "cycle_notice", "exhausted", "reminder", "acknowledged", "resolved"] as const;
  for (const kind of kinds) {
    for (const drill of [false, true]) {
      const text = smsText(context({
        brand, kind, drill, componentName: longest, incidentTitle: `${longest} is down`, alsoAffected: others, statusPageUrl, cycle: 2,
        acknowledgedBy: longest, targetContactNames: others,
      }));
      assert.equal(smsSize(text).encoding, "gsm7", kind);
      assert.ok(smsSize(text).segments <= 2, `${kind}: ${String(smsSize(text).segments)} segments`);
      assert.ok(text.startsWith(`[${brand}] `), `${kind}: the brand prefix is never cut`);
      assert.ok(text.includes(`${"s".repeat(40)}.example.com`), `${kind}: the status link survives`);
      if (drill ? kind === "page" : ["page", "escalation_notice", "cycle_notice", "exhausted", "reminder"].includes(kind)) {
        assert.match(text, /Reply ACK K7M2QX/, `${kind}: the ACK instruction survives`);
      }
    }
  }
  const notice = channelNoticeSms("email_daily_limit_exceeded", statusPageUrl, brand);
  assert.ok(notice.startsWith(`[${brand}] Alert email is failing`) && smsSize(notice).segments <= 2);
});

void test("brand: the default brand signs as [Status] and \"the Status monitor\"; a custom one as [Acme] and \"the Acme status monitor\"", () => {
  assert.match(smsText(context({ brand: "Status" })), /^\[Status\] DOWN: Signup\./);
  const plain = emailContent(context({ brand: "Status" }));
  assert.match(plain.subject, /^\[Status\] DOWN: Signup$/);
  assert.match(plain.text, /\nSent by the Status monitor\.$/);
  const custom = emailContent(context({ brand: "Acme" }));
  assert.match(custom.subject, /^\[Acme\] DOWN: Signup$/);
  assert.match(custom.text, /\nSent by the Acme status monitor\.$/);
});
