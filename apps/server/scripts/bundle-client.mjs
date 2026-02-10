/**
 * Copies the built renderer into dist/client/ so the published npm package
 * includes the web UI. This runs as a post-build step.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDist = path.resolve(__dirname, "../../renderer/dist");
const target = path.resolve(__dirname, "../dist/client");

if (!fs.existsSync(rendererDist)) {
  console.log(
    "⚠ Renderer dist not found — skipping client bundle. Run `bun run --cwd apps/renderer build` first.",
  );
  process.exit(0);
}

fs.cpSync(rendererDist, target, { recursive: true });
console.log("✓ Bundled renderer into dist/client");
