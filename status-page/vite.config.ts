// Builds the status page (index.html + src/) into dist/, the status-page Worker's assets directory. public/ (fonts,
// _headers and the acknowledge page's styles.css) is copied as is. Run from the repository root: npm run build:status-page.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No inline assets: the CSP allows scripts, styles, fonts and images only from this site (data: images aside).
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    // React, motion and the TUFFUI components are about 170 kB gzipped; the operator view is a separate chunk.
    chunkSizeWarningLimit: 600,
  },
});
