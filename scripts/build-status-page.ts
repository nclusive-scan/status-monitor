// Builds the status page's static files into status-page/dist (the Worker's assets directory): copies
// status-page/public and compiles status-page/src with the package's own TypeScript (the repository holds no JavaScript
// sources; dist/ is git-ignored). The Worker code (status-page/worker) is bundled by wrangler, not here.
// Run: npm run build:status-page
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const site = join(root, "status-page");
const dist = join(site, "dist");
rmSync(dist, { recursive: true, force: true });
cpSync(join(site, "public"), dist, { recursive: true });
execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", join(site, "tsconfig.json")], { stdio: "inherit" });
for (const file of ["index.html", "styles.css", "_headers", "app.js", "model.js", "operator.js"]) {
  if (!existsSync(join(dist, file))) throw new Error(`STATUS_PAGE_BUILD_INCOMPLETE:${file}`);
}
console.log(`Status page built: ${dist}`);
