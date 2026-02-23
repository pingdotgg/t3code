/**
 * Copies the built web app into dist/client/ so the published npm package
 * includes the web UI. This runs as a post-build step.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const webDist = path.resolve(import.meta.dirname, "../../web/dist");
const target = path.resolve(import.meta.dirname, "../dist/client");

if (!fs.existsSync(webDist)) {
  console.log(
    "⚠ Web dist not found — skipping client bundle. Run `bun run --cwd apps/web build` first.",
  );
  process.exit(0);
}

fs.cpSync(webDist, target, { recursive: true });
console.log("✓ Bundled web app into dist/client");
