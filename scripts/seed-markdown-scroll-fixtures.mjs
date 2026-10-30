import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const targets = process.argv.slice(2);
if (!targets.length) {
  throw new Error("Usage: node scripts/seed-markdown-scroll-fixtures.mjs <sandbox-worktree> [...]");
}
for (const target of targets) {
  const destination = NodePath.resolve(target, ".t3/markdown-scroll-fixtures");
  NodeFS.mkdirSync(destination, { recursive: true });
  for (const name of ["alpha.md", "beta.md", "delayed.md", "height.svg", "tasks.md", "links.md"]) {
    NodeFS.copyFileSync(
      NodePath.resolve(root, `scripts/fixtures/markdown-scroll/${name}`),
      NodePath.resolve(destination, name),
    );
  }
  const secondary = NodePath.resolve(target, "apps/server/.t3/markdown-scroll-fixtures");
  NodeFS.mkdirSync(secondary, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.resolve(secondary, "alpha.md"),
    NodeFS.readFileSync(NodePath.resolve(destination, "alpha.md"), "utf8").replace(
      "fixture alpha",
      "fixture workspace B alpha",
    ),
  );
}
