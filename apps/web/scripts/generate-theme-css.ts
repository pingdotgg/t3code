/**
 * Generates `apps/web/src/themePalettes.css` from `apps/web/src/themePalettes.ts`.
 *
 * Run via `pnpm --filter @t3tools/web generate:theme-css` from the monorepo root,
 * or `node scripts/generate-theme-css.ts` from `apps/web`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { generateThemePalettesCss } from "../src/themePalettesCss.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "../src/themePalettes.css");

async function main() {
  const css = generateThemePalettesCss();
  await fs.writeFile(OUTPUT_PATH, css, "utf-8");
  console.log(`Generated ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
