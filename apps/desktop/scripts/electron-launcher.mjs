// This file mostly exists because we want dev mode to say "T3 Code (Dev)" instead of "electron"

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateAssetCatalogForIcon } from "../../../scripts/lib/macos-icon-composer.ts";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
const APP_BUNDLE_ID = "com.t3tools.t3code";
const LAUNCHER_VERSION = 2;

const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");

function setPlistString(plistPath, key, value) {
  const replaceResult = spawnSync("plutil", ["-replace", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-string", value, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function patchMainBundleInfoPlist(appBundlePath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const frameworksDir = join(appBundlePath, "Contents", "Frameworks");
  if (!existsSync(frameworksDir)) {
    return;
  }

  for (const entry of readdirSync(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) {
      continue;
    }
    if (!entry.name.startsWith("Electron Helper")) {
      continue;
    }

    const helperPlistPath = join(frameworksDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(helperPlistPath)) {
      continue;
    }

    const suffix = entry.name.replace("Electron Helper", "").replace(".app", "").trim();
    const helperName = suffix
      ? `${APP_DISPLAY_NAME} Helper ${suffix}`
      : `${APP_DISPLAY_NAME} Helper`;
    const helperIdSuffix = suffix.replace(/[()]/g, "").trim().toLowerCase().replace(/\s+/g, "-");
    const helperBundleId = helperIdSuffix
      ? `${APP_BUNDLE_ID}.helper.${helperIdSuffix}`
      : `${APP_BUNDLE_ID}.helper`;

    setPlistString(helperPlistPath, "CFBundleDisplayName", helperName);
    setPlistString(helperPlistPath, "CFBundleName", helperName);
    setPlistString(helperPlistPath, "CFBundleIdentifier", helperBundleId);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function resolveIconSourceMetadata(desktopResourcesDir) {
  const iconComposerPath = join(desktopResourcesDir, "icon.icon");
  if (existsSync(iconComposerPath)) {
    return {
      iconAssetKind: "icon",
      iconMtimeMs: statSync(iconComposerPath).mtimeMs,
    };
  }

  const legacyIconPath = join(desktopResourcesDir, "icon.icns");
  return {
    iconAssetKind: "icns",
    iconMtimeMs: statSync(legacyIconPath).mtimeMs,
  };
}

async function stageMainBundleIcons(appBundlePath, desktopResourcesDir) {
  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  const iconComposerPath = join(desktopResourcesDir, "icon.icon");
  const legacyIconPath = join(desktopResourcesDir, "icon.icns");

  if (existsSync(iconComposerPath)) {
    const compiled = await generateAssetCatalogForIcon(iconComposerPath);
    const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");

    setPlistString(infoPlistPath, "CFBundleIconName", "Icon");
    writeFileSync(join(resourcesDir, "Assets.car"), compiled.assetCatalog);
    writeFileSync(join(resourcesDir, "icon.icns"), compiled.icnsFile);
    writeFileSync(join(resourcesDir, "electron.icns"), compiled.icnsFile);
    return {
      iconAssetKind: "icon",
      iconMtimeMs: statSync(iconComposerPath).mtimeMs,
    };
  }

  copyFileSync(legacyIconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(legacyIconPath, join(resourcesDir, "electron.icns"));
  return {
    iconAssetKind: "icns",
    iconMtimeMs: statSync(legacyIconPath).mtimeMs,
  };
}

async function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(electronBinaryPath, "../../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const desktopResourcesDir = join(desktopDir, "resources");
  const metadataPath = join(runtimeDir, "metadata.json");

  mkdirSync(runtimeDir, { recursive: true });

  const iconMetadata = resolveIconSourceMetadata(desktopResourcesDir);

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    ...iconMetadata,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  cpSync(sourceAppBundlePath, targetAppBundlePath, { recursive: true });
  patchMainBundleInfoPlist(targetAppBundlePath);
  const refreshedIconMetadata = await stageMainBundleIcons(targetAppBundlePath, desktopResourcesDir);
  patchHelperBundleInfoPlists(targetAppBundlePath);
  writeFileSync(
    metadataPath,
    `${JSON.stringify({ ...expectedMetadata, ...refreshedIconMetadata }, null, 2)}\n`,
  );

  return targetBinaryPath;
}

export async function resolveElectronPath() {
  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return await buildMacLauncher(electronBinaryPath);
}
