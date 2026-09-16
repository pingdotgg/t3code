// The CLI install scripts live in scripts/ at the repo root with the rest of
// the release tooling; the site serves them at /install.sh and /install.ps1.
// Copy them into public/ before every Astro build and dev server so the two
// never drift. The copies are gitignored.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const marketingDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.dirname(NodePath.dirname(marketingDir));
const publicDir = NodePath.join(marketingDir, "public");
NodeFS.mkdirSync(publicDir, { recursive: true });
for (const name of ["install.sh", "install.ps1"]) {
  NodeFS.copyFileSync(NodePath.join(repoRoot, "scripts", name), NodePath.join(publicDir, name));
}
