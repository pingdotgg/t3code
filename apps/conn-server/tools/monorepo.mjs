// The one way the tools find their inputs.
// - `repoRoot`: the Conn Server (`apps/conn-server`).
// - `monorepo()`: the Conn monorepo root, two levels up: the same tree, so the contract, the web
//   client and `apps/server` are always the ones this commit carries.
// Packages such as `effect`, `@t3tools/*` and `playwright-core` resolve from the monorepo's
// `node_modules` (`vp i` at the root); the Conn Server has none of its own.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

/** The Conn monorepo root, whether or not it is installed. */
export const monorepoRoot = NodePath.resolve(repoRoot, "../..");

let cached;

/** The Conn monorepo root. Exits 2 with one line when it has no `node_modules`. */
export function monorepo() {
  if (cached !== undefined) return cached;
  if (!NodeFS.existsSync(NodePath.join(monorepoRoot, "packages/contracts/package.json"))) {
    console.error(`${monorepoRoot} is not the Conn monorepo (no packages/contracts).`);
    process.exit(2);
  }
  if (!NodeFS.existsSync(NodePath.join(monorepoRoot, "node_modules"))) {
    console.error(`${monorepoRoot} has no node_modules: run \`vp i\` at the monorepo root first.`);
    process.exit(2);
  }
  cached = monorepoRoot;
  return cached;
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
