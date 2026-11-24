const fs = require("node:fs");

// The manifests in scripts/lib/tagged-source-version.ts.
const RELEASE_PACKAGE_FILES = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
];
const VERSION_LINE = /^( {2}"version": ")[^"]*(",?)$/gm;

// Replaces one string literal, so the result needs no formatter and no dependencies.
function setReleaseVersion(source, version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: '${version}'.`);
  }
  if (source.match(VERSION_LINE)?.length !== 1) {
    throw new Error("Expected exactly one top-level version in the manifest");
  }
  return source.replace(VERSION_LINE, `$1${version}$2`);
}

if (require.main === module) {
  for (const file of RELEASE_PACKAGE_FILES) {
    const source = fs.readFileSync(file, "utf8");
    const next = setReleaseVersion(source, process.argv[2] ?? "");
    if (next !== source) fs.writeFileSync(file, next);
  }
}

module.exports = { RELEASE_PACKAGE_FILES, setReleaseVersion };
