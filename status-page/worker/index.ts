// The public status page on Workers Static Assets (its custom domain, in wrangler.jsonc). Files in dist/ are
// served by the assets layer; this Worker runs first for /api/*, /ack/* and /hooks/* (wrangler.jsonc) and forwards them
// to the isolated monitor Worker over the MONITOR service binding (router.ts). It holds no secrets.
import { handle } from "./router.ts";

export interface StatusPageEnv {
  readonly MONITOR: Fetcher;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // caches.default is the data center's cache. It is active on the custom domain (the only way this Worker is reached).
    return handle(request, env.MONITOR, { cache: caches.default, waitUntil: (promise) => { ctx.waitUntil(promise); } });
  },
} satisfies ExportedHandler<StatusPageEnv>;
