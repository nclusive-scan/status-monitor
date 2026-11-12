// Builds the status page's static files into status-page/dist (the Worker's assets directory) with Vite: index.html and
// the React app in status-page/src (TUFFUI components on Tailwind CSS), plus status-page/public copied as is. The Worker
// code (status-page/worker) is bundled by wrangler, not here. dist/ is git-ignored.
// Run: npm run build:status-page
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const site = join(root, "status-page");
const dist = join(site, "dist");
execFileSync(join(root, "node_modules", ".bin", "vite"), ["build", "--config", join(site, "vite.config.ts"), "--logLevel", "warn"], { stdio: "inherit", cwd: root });
for (const file of ["index.html", "styles.css", "_headers", "fonts/Geist-Variable.woff2", "fonts/GeistMono-Variable.woff2"]) {
  if (!existsSync(join(dist, file))) throw new Error(`STATUS_PAGE_BUILD_INCOMPLETE:${file}`);
}
const assets = readdirSync(join(dist, "assets"));
if (!assets.some((file) => file.endsWith(".js")) || !assets.some((file) => file.endsWith(".css"))) throw new Error("STATUS_PAGE_BUILD_INCOMPLETE:assets");
const html = readFileSync(join(dist, "index.html"), "utf8");
// The CSP (public/_headers) allows no inline script or style: the built page must load everything from files.
if (/<script(?![^>]*\bsrc=)/.test(html) || /<style[\s>]/.test(html) || /\sstyle="/.test(html)) throw new Error("STATUS_PAGE_INLINE_CODE");
console.log(`Status page built: ${dist}`);
