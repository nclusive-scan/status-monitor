// How the one monitor Durable Object is addressed. Kept out of worker/index.ts on purpose: the Workers runtime treats
// every named export of the entry module as an entrypoint and refuses to start when one is not a handler or class.
export const MONITOR_JURISDICTION = "us";
export const MONITOR_OBJECT_NAME = "monitor";

/**
 * True only for `wrangler dev`: LOCAL_DEV "true" together with DELIVERY_MODE "log". The local runtime (workerd) does not
 * implement jurisdictions, so local development addresses the object without one. A live deployment ignores LOCAL_DEV
 * and always uses the "us" jurisdiction.
 */
export function localDev(env: { readonly LOCAL_DEV?: string; readonly DELIVERY_MODE?: string }): boolean {
  return env.LOCAL_DEV === "true" && env.DELIVERY_MODE === "log";
}

/** The part of a DurableObjectNamespace this needs (structural, so tests need no Workers types). */
export interface ObjectAddressing<Id> {
  jurisdiction(name: "us"): ObjectAddressing<Id>;
  idFromName(name: string): Id;
}

/** The one monitor object, addressed through the "us" jurisdiction (without one only in local development). */
export function monitorId<Id>(namespace: ObjectAddressing<Id>, local = false): Id {
  return (local ? namespace : namespace.jurisdiction(MONITOR_JURISDICTION)).idFromName(MONITOR_OBJECT_NAME);
}
