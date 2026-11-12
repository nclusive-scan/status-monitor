// The two wrangler configs as an adopter edits them in the README's quick start: their own status host and sender
// (steps 2 and 3) and the status page's custom domain turned on (step 7). Tests that check the configs also run against
// these, so following the quick start never turns the repository's own checks red. Both transforms start from whatever
// the files hold, the shipped examples or a fork's own values, so they keep working after an adopter's edits.

export const ADOPTED_STATUS_HOST = "status.adopter.test";
export const ADOPTED_EMAIL_FROM = "alerts@adopter.test";

const vars = (source: string): Record<string, unknown> => {
  const config: unknown = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  const found: unknown = typeof config === "object" && config !== null ? Reflect.get(config, "vars") : null;
  if (typeof found !== "object" || found === null) throw new Error("wrangler.jsonc has no vars");
  return { ...found };
};

/** wrangler.jsonc with another status host and alert sender in place of the current ones. */
export function adoptedMonitorWrangler(source: string): string {
  const { STATUS_PAGE_URL: url, ALERT_EMAIL_FROM: from } = vars(source);
  if (typeof url !== "string" || typeof from !== "string") throw new Error("STATUS_PAGE_URL and ALERT_EMAIL_FROM must be set");
  return source.replaceAll(new URL(url).hostname, ADOPTED_STATUS_HOST).replaceAll(from, ADOPTED_EMAIL_FROM);
}

/** status-page/wrangler.jsonc with its custom domain (the commented example, or the route already set) on `host`. */
export function adoptedStatusPageWrangler(source: string, host = ADOPTED_STATUS_HOST): string {
  const route = /^(\s*)(?:\/\/ )?("routes": \[\{ "pattern": )"[^"]+"(.*)$/m;
  if (!route.test(source)) throw new Error("status-page/wrangler.jsonc has no custom domain route or example");
  return source.replace(route, `$1$2"${host}"$3`).replace(/^\s*"routes": \[\],\n/m, "");
}
