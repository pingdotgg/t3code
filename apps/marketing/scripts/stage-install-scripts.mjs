// The CLI install scripts live in scripts/ at the repo root with the rest of
// the release tooling; the site serves them at /install.sh and /install.ps1.
// Copy them into public/ before every Astro build and dev server so the two
// never drift. The copies are gitignored.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const marketingDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(marketingDir));
const publicDir = join(marketingDir, "public");
mkdirSync(publicDir, { recursive: true });
for (const name of ["install.sh", "install.ps1"]) {
  copyFileSync(join(repoRoot, "scripts", name), join(publicDir, name));
}
