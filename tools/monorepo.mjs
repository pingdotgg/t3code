// The one way the tools find their inputs.
// - `repoRoot`: this repository (conn-server).
// - `monorepo()`: the Conn monorepo root from `CONN_MONOREPO`. There is no default: without
//   the variable the tool stops with one line that says what to set. It warns once when the
//   checkout is not at the commit in `conn.pin` (make one with `tools/conn-checkout`).
// - `pinnedCommit()`: the Conn commit in `conn.pin`, the one place the pin is written.
// Packages such as `effect`, `@t3tools/*` and `playwright-core` resolve from the monorepo's
// `node_modules`; this repository has none of its own.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

let cached;

/** The Conn commit this repository pins (`conn.pin`), or undefined when the file is missing. */
export function pinnedCommit() {
  const file = NodePath.join(repoRoot, "conn.pin");
  if (!NodeFS.existsSync(file)) return undefined;
  return NodeFS.readFileSync(file, "utf8").split("\n")[0].trim();
}

function warnWhenNotPinned(root) {
  const pin = pinnedCommit();
  if (pin === undefined) return;
  let head;
  try {
    head = NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
  if (head !== pin) {
    console.error(
      `warning: CONN_MONOREPO is at ${head.slice(0, 10)}, conn.pin says ${pin.slice(0, 10)} (tools/conn-checkout makes a checkout at the pin).`,
    );
  }
}

/** The Conn monorepo root. Exits 2 with one line when `CONN_MONOREPO` is unset or wrong. */
export function monorepo() {
  if (cached !== undefined) return cached;
  const value = process.env.CONN_MONOREPO;
  if (value === undefined || value === "") {
    console.error(
      "CONN_MONOREPO is not set: set it to a Conn monorepo checkout after `vp i` (CONN_MONOREPO=/path/to/conn).",
    );
    process.exit(2);
  }
  const root = NodePath.resolve(value);
  if (!NodeFS.existsSync(NodePath.join(root, "packages/contracts/package.json"))) {
    console.error(`CONN_MONOREPO=${root} is not a Conn monorepo (no packages/contracts).`);
    process.exit(2);
  }
  if (!NodeFS.existsSync(NodePath.join(root, "node_modules"))) {
    console.error(`CONN_MONOREPO=${root} has no node_modules: run \`vp i\` there first.`);
    process.exit(2);
  }
  warnWhenNotPinned(root);
  cached = root;
  return root;
}

/** A path inside the monorepo. */
export const inMonorepo = (...parts) => NodePath.join(monorepo(), ...parts);

/** Imports a TypeScript or JavaScript file inside the monorepo. */
export const importSource = (relative) =>
  import(NodeURL.pathToFileURL(inMonorepo(relative)).href);

/**
 * Imports a package as the monorepo package at `fromPackage` (e.g. `packages/contracts`)
 * resolves it, so the tool shares that package's `effect` instance.
 */
export function packageImporter(fromPackage) {
  const require = NodeModule.createRequire(inMonorepo(fromPackage, "package.json"));
  return (specifier) => import(NodeURL.pathToFileURL(require.resolve(specifier)).href);
}

/** `require` as the monorepo package at `fromPackage` sees it. */
export const packageRequire = (fromPackage) =>
  NodeModule.createRequire(inMonorepo(fromPackage, "package.json"));
