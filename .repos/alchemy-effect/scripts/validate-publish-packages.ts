import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const packagesDirectory = path.resolve(import.meta.dir, "../packages");
const packageDirectories = await readdir(packagesDirectory, {
  withFileTypes: true,
});
const publishable: Array<{ name: string; version: string }> = [];

for (const entry of packageDirectories) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(packagesDirectory, entry.name, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (manifest.private === true) continue;

  const missing = [
    "name",
    "version",
    "description",
    "homepage",
    "license",
    "author",
    "keywords",
    "repository",
    "bugs",
    "files",
    "exports",
  ].filter((field) => manifest[field] == null);
  const publishConfig = manifest.publishConfig as
    | { access?: unknown }
    | undefined;
  if (publishConfig?.access !== "public") {
    missing.push("publishConfig.access=public");
  }
  if (missing.length > 0) {
    throw new Error(
      `${entry.name}: missing publish metadata: ${missing.join(", ")}`,
    );
  }

  publishable.push({
    name: manifest.name as string,
    version: manifest.version as string,
  });
}

const versions = new Set(publishable.map(({ version }) => version));
if (versions.size !== 1) {
  throw new Error(
    `Publishable packages must share one version: ${publishable
      .map(({ name, version }) => `${name}@${version}`)
      .join(", ")}`,
  );
}

console.log(
  `Validated ${publishable.length} publishable packages at ${publishable[0]?.version}`,
);
