#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VERSION = process.argv[2] ?? "12.17.0";
const VERSION_TAG = `v${VERSION}`;
const VSIX_URL = `https://open-vsx.org/api/vscode-icons-team/vscode-icons/${VERSION}/file/vscode-icons-team.vscode-icons-${VERSION}.vsix`;
const LANGUAGES_URL = `https://raw.githubusercontent.com/vscode-icons/vscode-icons/${VERSION_TAG}/src/iconsManifest/languages.ts`;

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = path.join(REPO_ROOT, "apps/web/src/vscode-icons-manifest.json");
const ASSOCIATIONS_PATH = path.join(
  REPO_ROOT,
  "apps/web/src/vscode-icons-language-associations.json",
);

function normalizeExtension(value) {
  return value.trim().toLowerCase().replace(/^\./, "");
}

function normalizeFileName(value) {
  return value.trim().toLowerCase();
}

function putIfAbsent(target, key, value) {
  if (!(key in target)) {
    target[key] = value;
  }
}

async function downloadVsix(tmpDir) {
  const vsixPath = path.join(tmpDir, `vscode-icons-${VERSION}.vsix`);
  const response = await fetch(VSIX_URL);
  if (!response.ok) {
    throw new Error(`Failed to download VSIX: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(vsixPath, bytes);
  return vsixPath;
}

async function extractManifestFromVsix(vsixPath) {
  const { stdout } = await execFileAsync("unzip", [
    "-p",
    vsixPath,
    "extension/dist/src/vsicons-icon-theme.json",
  ]);
  if (!stdout || stdout.trim().length === 0) {
    throw new Error("Could not extract vsicons-icon-theme.json from VSIX");
  }
  return JSON.parse(stdout);
}

async function loadLanguagesCollection() {
  const response = await fetch(LANGUAGES_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch languages.ts: ${response.status} ${response.statusText}`);
  }
  const rawSource = await response.text();
  const source = rawSource
    .replace(/^import[^;]+;\s*/gm, "")
    .replace(/export const languages(?:\s*:\s*[^=]+)?\s*=/, "const languages =")
    .replace(/\}\s*satisfies\s*Record<[^;]+>;/, "};");

  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}\n;globalThis.__languages = languages;`, context);
  const languages = context.__languages;
  if (!languages || typeof languages !== "object") {
    throw new Error("Failed to parse languages.ts into a collection");
  }
  return languages;
}

function buildLanguageAssociations(manifest, languages) {
  const availableLanguageIds = new Set(Object.keys(manifest.languageIds ?? {}));
  const extensionToLanguageId = {};
  const fileNameToLanguageId = {};

  for (const entry of Object.values(languages)) {
    if (!entry || typeof entry !== "object") continue;
    const idsRaw = entry.ids;
    const ids = Array.isArray(idsRaw) ? idsRaw : [idsRaw];
    const knownExtensions = Array.isArray(entry.knownExtensions) ? entry.knownExtensions : [];
    const knownFilenames = Array.isArray(entry.knownFilenames) ? entry.knownFilenames : [];

    for (const idValue of ids) {
      if (typeof idValue !== "string") continue;
      const languageId = idValue.trim();
      if (languageId.length === 0) continue;
      if (!availableLanguageIds.has(languageId)) continue;

      for (const extensionValue of knownExtensions) {
        if (typeof extensionValue !== "string") continue;
        const extension = normalizeExtension(extensionValue);
        if (extension.length === 0) continue;
        putIfAbsent(extensionToLanguageId, extension, languageId);
      }

      for (const fileNameValue of knownFilenames) {
        if (typeof fileNameValue !== "string") continue;
        const fileName = normalizeFileName(fileNameValue);
        if (fileName.length === 0) continue;
        putIfAbsent(fileNameToLanguageId, fileName, languageId);
      }
    }
  }

  return {
    version: VERSION,
    source: LANGUAGES_URL,
    generatedAt: new Date().toISOString(),
    extensionToLanguageId,
    fileNameToLanguageId,
  };
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-vscode-icons-sync-"));
  try {
    const vsixPath = await downloadVsix(tmpDir);
    const manifest = await extractManifestFromVsix(vsixPath);
    const languages = await loadLanguagesCollection();
    const associations = buildLanguageAssociations(manifest, languages);

    await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest)}\n`, "utf8");
    await fs.writeFile(ASSOCIATIONS_PATH, `${JSON.stringify(associations)}\n`, "utf8");

    process.stdout.write(
      [
        `Synced vscode-icons ${VERSION}`,
        `manifest: ${MANIFEST_PATH}`,
        `language associations: ${ASSOCIATIONS_PATH}`,
        `extension mappings: ${Object.keys(associations.extensionToLanguageId).length}`,
        `filename mappings: ${Object.keys(associations.fileNameToLanguageId).length}`,
      ].join("\n") + "\n",
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
