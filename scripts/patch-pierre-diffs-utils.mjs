import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const bunStorePath = join(root, "node_modules/.bun");

const packageDirs = [];

if (existsSync(join(root, "node_modules/@pierre/diffs"))) {
  packageDirs.push(join(root, "node_modules/@pierre/diffs"));
}

if (existsSync(bunStorePath)) {
  for (const entry of readdirSync(bunStorePath)) {
    if (!entry.startsWith("@pierre+diffs@")) {
      continue;
    }

    packageDirs.push(join(bunStorePath, entry, "node_modules/@pierre/diffs"));
  }
}

const utilsIndexJs = [
  'export { parsePatchFiles, processFile, processPatch } from "./parsePatchFiles.js";',
  "export {",
  "  EXTENSION_TO_FILE_FORMAT,",
  "  getCustomExtensionsMap,",
  "  getCustomExtensionsVersion,",
  "  getFiletypeFromFileName,",
  "  replaceCustomExtensions,",
  "  setCustomExtension,",
  '} from "./getFiletypeFromFileName.js";',
  "",
].join("\n");

const utilsIndexDts = [
  'export { parsePatchFiles, processFile, processPatch } from "./parsePatchFiles.js";',
  "export {",
  "  EXTENSION_TO_FILE_FORMAT,",
  "  getCustomExtensionsMap,",
  "  getCustomExtensionsVersion,",
  "  getFiletypeFromFileName,",
  "  replaceCustomExtensions,",
  "  setCustomExtension,",
  '} from "./getFiletypeFromFileName.js";',
  'export type { ChangeTypes, FileDiffMetadata, ParsedPatch, SupportedLanguages } from "../types.js";',
  "",
].join("\n");

let patchedCount = 0;
let locatedCount = 0;

for (const packageDir of packageDirs) {
  if (!existsSync(packageDir)) {
    continue;
  }

  locatedCount += 1;

  const packageJsonPath = join(packageDir, "package.json");
  const utilsIndexJsPath = join(packageDir, "dist/utils/index.js");
  const utilsIndexDtsPath = join(packageDir, "dist/utils/index.d.ts");

  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const currentUtilsExport = pkg.exports?.["./utils"];

  const expectedUtilsExport = {
    types: "./dist/utils/index.d.ts",
    import: "./dist/utils/index.js",
  };

  const needsExportPatch =
    currentUtilsExport?.types !== expectedUtilsExport.types ||
    currentUtilsExport?.import !== expectedUtilsExport.import;

  if (needsExportPatch) {
    pkg.exports = {
      ...pkg.exports,
      "./utils": expectedUtilsExport,
    };
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  const currentJs = existsSync(utilsIndexJsPath) ? readFileSync(utilsIndexJsPath, "utf8") : null;
  if (currentJs !== utilsIndexJs) {
    writeFileSync(utilsIndexJsPath, utilsIndexJs);
  }

  const currentDts = existsSync(utilsIndexDtsPath) ? readFileSync(utilsIndexDtsPath, "utf8") : null;
  if (currentDts !== utilsIndexDts) {
    writeFileSync(utilsIndexDtsPath, utilsIndexDts);
  }

  if (needsExportPatch || currentJs !== utilsIndexJs || currentDts !== utilsIndexDts) {
    patchedCount += 1;
  }
}

if (patchedCount > 0) {
  console.log(`[patch-pierre-diffs-utils] patched ${patchedCount} @pierre/diffs installation(s).`);
} else if (locatedCount > 0) {
  console.log("[patch-pierre-diffs-utils] @pierre/diffs already patched.");
} else {
  console.log("[patch-pierre-diffs-utils] @pierre/diffs not installed; skipping.");
}
