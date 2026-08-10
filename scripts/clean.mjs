import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 125,
};

function childDirectories(rootDir, parentName) {
  const parentPath = NodePath.join(rootDir, parentName);
  let entries;
  try {
    entries = NodeFS.readdirSync(parentPath, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => NodePath.join(parentPath, entry.name));
}

export function collectCleanTargets(rootDir) {
  const workspaceDirs = [
    ...childDirectories(rootDir, "apps"),
    ...childDirectories(rootDir, "packages"),
  ];
  return [
    NodePath.join(rootDir, "node_modules"),
    NodePath.join(rootDir, ".vite-plus"),
    ...workspaceDirs.map((workspaceDir) => NodePath.join(workspaceDir, "node_modules")),
    ...workspaceDirs.map((workspaceDir) => NodePath.join(workspaceDir, ".vite-plus")),
    ...childDirectories(rootDir, "apps").flatMap((appDir) => [
      NodePath.join(appDir, "dist"),
      NodePath.join(appDir, "dist-electron"),
    ]),
    ...childDirectories(rootDir, "packages").map((packageDir) => NodePath.join(packageDir, "dist")),
  ];
}

export function cleanRepository(rootDir) {
  const removed = [];
  for (const target of collectCleanTargets(rootDir)) {
    if (!NodeFS.existsSync(target)) continue;
    NodeFS.rmSync(target, DEFAULT_REMOVE_OPTIONS);
    removed.push(target);
  }
  return removed;
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = NodePath.resolve(NodePath.dirname(scriptPath), "..");

if (process.argv[1] && NodePath.resolve(process.argv[1]) === scriptPath) {
  const removed = cleanRepository(repoRoot);
  process.stdout.write(
    `Cleaned ${removed.length} generated/dependency director${removed.length === 1 ? "y" : "ies"}.\n`,
  );
}
