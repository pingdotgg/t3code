import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const extensionDir = NodePath.dirname(
  NodeURL.fileURLToPath(new URL("../package.json", import.meta.url)),
);
const repoRoot = NodePath.join(extensionDir, "../..");
const rootPackageJson = JSON.parse(
  NodeFS.readFileSync(NodePath.join(repoRoot, "package.json"), "utf8"),
);
const catalog = {
  ...rootPackageJson.workspaces?.catalog,
  ...readPnpmWorkspaceCatalog(),
};

export function filterPackagedDependencies(dependencies) {
  return Object.fromEntries(
    Object.entries(dependencies ?? {})
      .filter(([, version]) => typeof version !== "string" || !version.startsWith("workspace:"))
      .map(([name, version]) => [name, resolvePackagedDependencyVersion(name, version)]),
  );
}

function resolvePackagedDependencyVersion(name, version) {
  if (version !== "catalog:") {
    return version;
  }

  const catalogVersion = catalog[name];
  if (typeof catalogVersion === "string" && catalogVersion.length > 0) {
    return catalogVersion;
  }

  throw new Error(`Cannot package ${name}: missing root workspace catalog version.`);
}

function readPnpmWorkspaceCatalog() {
  let source;
  try {
    source = NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return {};
  }

  const catalog = {};
  let inCatalog = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^catalog:\s*$/u.test(line)) {
      inCatalog = true;
      continue;
    }
    if (inCatalog && /^\S/u.test(line)) {
      break;
    }
    if (!inCatalog) {
      continue;
    }

    const match = line.match(/^\s{2}(["']?)([^"':]+|@[^\s"']+)["']?:\s*(.+?)\s*$/u);
    if (!match) {
      continue;
    }
    const [, , rawName, rawVersion] = match;
    if (!rawName || !rawVersion) {
      continue;
    }
    catalog[rawName] = rawVersion.replace(/^["']|["']$/gu, "");
  }
  return catalog;
}
