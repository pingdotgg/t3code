#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a small sync check with no Effect runtime.
// Fails when a path removed with T3 Connect comes back (usually through an upstream sync) or
// when source code depends on Clerk again.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MANIFEST_PATH = "scripts/removed-connect-paths.json";
const SELF_PATHS = new Set([
  MANIFEST_PATH,
  "scripts/check-removed-connect.ts",
  "scripts/check-removed-connect.test.ts",
]);
const SOURCE = /\.(?:[cm]?[jt]sx?|astro)$/;
const CLERK_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']@clerk\//;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export function readManifestPaths(root: string): ReadonlyArray<string> {
  const manifest: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, MANIFEST_PATH), "utf8"),
  );
  const paths =
    typeof manifest === "object" && manifest !== null && "paths" in manifest
      ? manifest.paths
      : undefined;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    throw new Error(`${MANIFEST_PATH} must hold a "paths" array of strings.`);
  }
  return paths;
}

function clerkDependencies(packageJson: string): ReadonlyArray<string> {
  const parsed: unknown = JSON.parse(packageJson);
  if (typeof parsed !== "object" || parsed === null) return [];
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const dependencies: unknown = Reflect.get(parsed, field);
    return typeof dependencies === "object" && dependencies !== null
      ? Object.keys(dependencies).filter((name) => name.startsWith("@clerk/"))
      : [];
  });
}

/** Problems in `root`, given its manifest paths and the repository files to scan. */
export function findRemovedConnectProblems(
  root: string,
  removedPaths: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const problems = removedPaths
    .filter((path) => NodeFS.existsSync(NodePath.join(root, path)))
    .map((path) => `${path} was removed with T3 Connect and is back. Delete it.`);
  for (const file of files) {
    if (SELF_PATHS.has(file) || file.startsWith(".repos/") || file.includes("node_modules/")) {
      continue;
    }
    const isManifest = NodePath.basename(file) === "package.json";
    if (!isManifest && !SOURCE.test(file)) continue;
    const absolute = NodePath.join(root, file);
    if (!NodeFS.existsSync(absolute)) continue;
    const text = NodeFS.readFileSync(absolute, "utf8");
    if (isManifest) {
      for (const name of clerkDependencies(text)) {
        problems.push(`${file} depends on ${name}; Clerk was removed with T3 Connect.`);
      }
    } else if (CLERK_IMPORT.test(text)) {
      problems.push(`${file} imports @clerk/; Clerk was removed with T3 Connect.`);
    }
  }
  return problems;
}

function main() {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const files = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  const problems = findRemovedConnectProblems(root, readManifestPaths(root), files);
  if (problems.length === 0) {
    console.log("check-removed-connect: no removed T3 Connect paths or Clerk imports found.");
    return;
  }
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
}

if (import.meta.main) main();
