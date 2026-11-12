// Builds the status page's static files into status-page/dist (the Worker's assets directory) with Vite: index.html
// (the public status), operator/index.html (the operator view) and the React app in status-page/src, plus
// status-page/public copied as is. The Worker code (status-page/worker) is bundled by wrangler, not here. dist/ is
// git-ignored.
//
// Branding: status-page/public/brand holds a neutral logo and favicons. Set STATUS_PAGE_BRAND_DIR to a directory with
// your own and they replace those in the build: logo.svg (on light), logo-dark.svg (on dark), favicon.svg,
// favicon.ico and apple-touch-icon.png (180 px), every one of them required.
// Run: npm run build:status-page
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dirname, "..");
const site = join(root, "status-page");
const dist = join(site, "dist");
export const BRAND_FILES = ["logo.svg", "logo-dark.svg", "favicon.svg", "favicon.ico", "apple-touch-icon.png"] as const;

const brandDir = process.env["STATUS_PAGE_BRAND_DIR"];
if (brandDir !== undefined && brandDir !== "") {
  const missing = BRAND_FILES.filter((file) => !existsSync(join(resolve(brandDir), file)));
  if (missing.length > 0) throw new Error(`STATUS_PAGE_BRAND_INCOMPLETE:${missing.join(",")}`);
}
execFileSync(join(root, "node_modules", ".bin", "vite"), ["build", "--config", join(site, "vite.config.ts"), "--logLevel", "warn"], { stdio: "inherit", cwd: root });
if (brandDir !== undefined && brandDir !== "") {
  for (const file of BRAND_FILES) copyFileSync(join(resolve(brandDir), file), join(dist, "brand", file));
  console.log(`Brand files from ${resolve(brandDir)}`);
}
for (const file of ["index.html", "operator/index.html", "styles.css", "_headers", "fonts/Geist-Variable.woff2", "fonts/GeistMono-Variable.woff2",
  ...BRAND_FILES.map((name) => `brand/${name}`)]) {
  if (!existsSync(join(dist, file))) throw new Error(`STATUS_PAGE_BUILD_INCOMPLETE:${file}`);
}
const assets = readdirSync(join(dist, "assets"));
if (!assets.some((file) => file.endsWith(".js")) || !assets.some((file) => file.endsWith(".css"))) throw new Error("STATUS_PAGE_BUILD_INCOMPLETE:assets");
// The CSP (public/_headers) allows no inline script or style: the built pages must load everything from files.
for (const page of ["index.html", "operator/index.html"]) {
  const html = readFileSync(join(dist, page), "utf8");
  if (/<script(?![^>]*\bsrc=)/.test(html) || /<style[\s>]/.test(html) || /\sstyle="/.test(html)) throw new Error(`STATUS_PAGE_INLINE_CODE:${page}`);
}
console.log(`Status page built: ${dist}`);
