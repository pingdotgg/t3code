/**
 * Writes the faint section background patterns to `website/public/patterns/`
 * from the exact Sri Yantra construction in `src/brand/sriYantra.ts`.
 *
 * Run: `bun scripts/generate-yantra-patterns.ts`
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MARMAS, MAX_MISS, PATTERN_NAMES, sriYantraPattern } from "../src/brand/sriYantra.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../public/patterns");

await Promise.all(
  PATTERN_NAMES.map((name) => writeFile(path.join(outDir, `${name}.svg`), sriYantraPattern(name))),
);
console.log(
  `Wrote ${PATTERN_NAMES.length} patterns to ${path.relative(process.cwd(), outDir)} (${MARMAS.length} marmas, max miss ${MAX_MISS.toExponential(1)}).`,
);
