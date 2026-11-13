// Writes the default keybindings from packages/shared into keybindings.defaults.json, which
// conn-server compiles in, and the TypeScript compile of them into keybindings.resolved.json,
// which its tests compare with. `--check` fails when either is stale (run after an upstream sync).
// From the repo root after `vp i`: `node native/conn-server/crates/conn-server/tools/gen-keybindings.mjs`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const crateDir = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const repoDir = NodePath.resolve(crateDir, "../../../..");
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
const texts = {
  // Compact: it is compiled into the binary.
  defaults: `${JSON.stringify(defaults)}\n`,
  resolved: `${JSON.stringify(shared.DEFAULT_RESOLVED_KEYBINDINGS, null, 2)}\n`,
};

let stale = false;
for (const [name, path] of Object.entries(outputs)) {
  if (process.argv.includes("--check")) {
    const current = NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "";
    if (current !== texts[name]) {
      console.error(`${path} is stale; run this tool without --check`);
      stale = true;
    }
  } else {
    NodeFS.writeFileSync(path, texts[name]);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
