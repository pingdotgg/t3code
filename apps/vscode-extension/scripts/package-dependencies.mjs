import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = join(extensionDir, "../..");
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const catalog = rootPackageJson.workspaces?.catalog ?? {};

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
