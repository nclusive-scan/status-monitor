// Test doubles: a frozen, steppable clock; predictable random bytes; a scripted fetch; node:sqlite adapted to the
// Durable Object SqlStorage surface the store uses; the example policy; and the test targets (test/support/targets.fixture.json:
// eight paging, public components on neutral hosts, so the tests do not depend on what the bootstrap watches).
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parsePolicy, parseTargets } from "../../worker/config.ts";
import type { EscalationPolicy, TargetsConfig } from "../../worker/config.ts";
import type { RandomSource } from "../../worker/crypto.ts";
import type { SqlRow, SqlValue, StorageLike } from "../../worker/schema.ts";
import type { Clock, FetchLike } from "../../worker/types.ts";

export const T0 = Date.UTC(2026, 10, 11, 14, 0, 0);
export const MINUTE = 60_000;

export class FakeClock implements Clock {
  private value: number;
  constructor(start = T0) {
    this.value = start;
  }
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

/** Counts up from a seed so ids differ but are reproducible. */
export function countingRandom(seed = 1): RandomSource {
  let next = seed;
  return {
    bytes(count) {
      const out = new Uint8Array(count);
      for (let index = 0; index < count; index += 1) {
        out[index] = next % 248;
        next += 7;
      }
      return out;
    },
  };
}

export interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers from a handler and records every call. */
export function scriptedFetch(handler: (url: string, init: RequestInit | undefined, call: number) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  // Like the Workers runtime's fetch, refuses to be called as a method (deps.fetch(...) throws "Illegal invocation"
  // there), so a check that does so fails here too.
  async function fetch(this: unknown, url: string, init?: RequestInit): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
    calls.push({ url, init });
    return handler(url, init, calls.length);
  }
  return { fetch, calls };
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const header = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);

function toSqlRow(row: Record<string, unknown>): SqlRow {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" || typeof value === "number" || value === null) out[key] = value;
    else if (typeof value === "bigint") out[key] = Number(value);
    else if (value instanceof Uint8Array) out[key] = value.slice().buffer;
    else throw new Error(`UNEXPECTED_SQLITE_VALUE ${key}`);
  }
  return out;
}

export function sqliteStorage(): StorageLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    sql: {
      exec(query, ...bindings) {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: (): SqlRow[] => rows.map(toSqlRow) };
      },
    },
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../config/${name}`, import.meta.url), "utf8"));
/** The test targets as JSON text (for MONITOR_TARGETS in a test env). */
export const FIXTURE_TARGETS_JSON = readFileSync(new URL("./targets.fixture.json", import.meta.url), "utf8");

export function examplePolicy(): EscalationPolicy {
  const policy = parsePolicy(read("escalation.example.json"));
  if (policy === null) throw new Error("example policy invalid");
  return policy;
}

/** The bootstrap targets (config/targets.example.json, identical to wrangler.jsonc's MONITOR_TARGETS). */
export function bootstrapTargets(): TargetsConfig {
  const targets = parseTargets(read("targets.example.json"));
  if (targets === null) throw new Error("bootstrap targets invalid");
  return targets;
}

/** The test targets: eight components with the default alert ("page") and visibility (public). */
export function fixtureTargets(): TargetsConfig {
  const targets = parseTargets(FIXTURE_TARGETS_JSON);
  if (targets === null) throw new Error("fixture targets invalid");
  return targets;
}
