#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface DesktopPackageJson {
  readonly productName?: unknown;
}

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?$/;

function fail(message: string): never {
  process.stderr.write(`[homebrew-release-contract] ${message}\n`);
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    tag: { type: "string" },
    repository: { type: "string" },
    "expected-repository": { type: "string", default: "pingdotgg/t3code" },
    expectedRepository: { type: "string" },
    "assets-dir": { type: "string" },
    assetsDir: { type: "string" },
    "expected-product-name": { type: "string", default: "T3 Code (Alpha)" },
    expectedProductName: { type: "string" },
    "desktop-package-path": { type: "string", default: "apps/desktop/package.json" },
    desktopPackagePath: { type: "string" },
  },
});

const version = values.version;
const tag = values.tag;
const repository = values.repository;
const expectedRepository = values["expected-repository"] ?? values.expectedRepository;
const assetsDirInput = values["assets-dir"] ?? values.assetsDir;
const expectedProductName = values["expected-product-name"] ?? values.expectedProductName;
const desktopPackagePathInput = values["desktop-package-path"] ?? values.desktopPackagePath;

if (!version) {
  fail("Missing required --version argument.");
}

if (!VERSION_PATTERN.test(version)) {
  fail(`Version '${version}' does not match expected semver-like format.`);
}

if (!tag) {
  fail("Missing required --tag argument.");
}

if (tag !== `v${version}`) {
  fail(`Tag '${tag}' must exactly match 'v${version}'.`);
}

if (repository && repository !== expectedRepository) {
  fail(
    `Release repository must be '${expectedRepository}' for Homebrew compatibility (current: '${repository}').`,
  );
}

const desktopPackagePath = isAbsolute(desktopPackagePathInput)
  ? desktopPackagePathInput
  : join(repoRoot, desktopPackagePathInput);

if (!existsSync(desktopPackagePath)) {
  fail(`Desktop package.json not found at '${desktopPackagePath}'.`);
}

let desktopPackageJson: DesktopPackageJson;
try {
  desktopPackageJson = JSON.parse(readFileSync(desktopPackagePath, "utf8")) as DesktopPackageJson;
} catch (error) {
  fail(
    `Failed to parse desktop package.json at '${desktopPackagePath}': ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

if (desktopPackageJson.productName !== expectedProductName) {
  fail(
    `Desktop productName must remain '${expectedProductName}' for Homebrew cask compatibility (current: '${String(
      desktopPackageJson.productName,
    )}').`,
  );
}

if (assetsDirInput) {
  const assetsDir = isAbsolute(assetsDirInput) ? assetsDirInput : join(repoRoot, assetsDirInput);
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
    fail(`Assets directory '${assetsDir}' does not exist or is not a directory.`);
  }

  const requiredDmgAssets = [`T3-Code-${version}-arm64.dmg`, `T3-Code-${version}-x64.dmg`];
  for (const assetName of requiredDmgAssets) {
    const assetPath = join(assetsDir, assetName);
    if (!existsSync(assetPath)) {
      fail(`Missing required macOS DMG asset '${assetName}' in '${assetsDir}'.`);
    }
    const stat = statSync(assetPath);
    if (!stat.isFile()) {
      fail(`Expected '${assetPath}' to be a file.`);
    }
    if (stat.size <= 0) {
      fail(`Asset '${assetPath}' is empty.`);
    }
  }
}

process.stdout.write(
  `[homebrew-release-contract] OK version=${version} tag=${tag} repository='${repository ?? "n/a"}' productName='${expectedProductName}'\n`,
);
