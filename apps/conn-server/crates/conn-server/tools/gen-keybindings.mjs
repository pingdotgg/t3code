// Writes packages/shared's default keybindings to keybindings.defaults.json (compiled in) and
// their TypeScript compile to keybindings.resolved.json (tests). `--check` fails when stale.
// Needs `vp i` at the Conn monorepo root.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { monorepo } from "../../../tools/monorepo.mjs";

const crateDir = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const repoDir = monorepo();
const outputs = {
  defaults: NodePath.join(crateDir, "keybindings.defaults.json"),
  resolved: NodePath.join(crateDir, "keybindings.resolved.json"),
};

const shared = await import(
  NodeURL.pathToFileURL(NodePath.join(repoDir, "packages/shared/src/keybindings.ts")).href
);
const contracts = await import(
  NodeURL.pathToFileURL(NodePath.join(repoDir, "packages/contracts/src/keybindings.ts")).href
);
const server = NodeFS.readFileSync(
  NodePath.join(repoDir, "apps/server/src/keybindings.ts"),
  "utf8",
);

// The late defaults live in a server module with heavy imports; read their literal instead.
const late = server.match(/const LATE_DEFAULT_KEYBINDINGS[^=]*=\s*(\[[\s\S]*?\n\]);/);
if (!late) throw new Error("LATE_DEFAULT_KEYBINDINGS not found in apps/server/src/keybindings.ts");
const lateDefaults = Function(`return ${late[1]};`)();

const defaults = {
  maxCount: contracts.MAX_KEYBINDINGS_COUNT,
  maxWhenDepth: contracts.MAX_WHEN_EXPRESSION_DEPTH,
  defaults: shared.DEFAULT_KEYBINDINGS.map(({ key, command, when }) =>
    when === undefined ? { key, command } : { key, command, when },
  ),
  late: lateDefaults,
};
const values = { defaults, resolved: shared.DEFAULT_RESOLVED_KEYBINDINGS };
const texts = Object.fromEntries(
  Object.entries(values).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]),
);

let stale = false;
for (const [name, path] of Object.entries(outputs)) {
  if (process.argv.includes("--check")) {
    // Compare values: the repository formatter may lay the file out differently.
    const current = NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "null";
    if (JSON.stringify(JSON.parse(current)) !== JSON.stringify(values[name])) {
      console.error(`${path} is stale; run this tool without --check`);
      stale = true;
    }
  } else {
    NodeFS.writeFileSync(path, texts[name]);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
if (process.argv.includes("--check")) console.log("keybinding defaults are current");
