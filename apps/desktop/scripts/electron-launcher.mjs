// This file mostly exists because we want dev mode to say "T3 Code (Dev)" instead of "electron"

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const __dirname = dirname(fileURLToPath(import.meta.url));
export const desktopDir = resolve(__dirname, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const devBundleIdSuffix = basename(repoRoot)
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "");
export const APP_DISPLAY_NAME = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
export const APP_BUNDLE_ID = isDevelopment
  ? `com.t3tools.t3code.dev.${devBundleIdSuffix || "local"}`
  : "com.t3tools.t3code";
const APP_PROTOCOL_SCHEMES = isDevelopment ? ["t3code-dev"] : ["t3code"];
const LAUNCHER_VERSION = 10;
const defaultIconPath = join(desktopDir, "resources", "icon.icns");
const developmentMacIconPngPath = join(repoRoot, "assets", "dev", "blueprint-macos-1024.png");

function resolveDevelopmentProtocolCallbackPort() {
  const configuredPort = Number.parseInt(process.env.T3CODE_PORT ?? "", 10);
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65535) {
    return configuredPort + 1;
  }
  return 13774;
}

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

function setPlistJson(plistPath, key, value) {
  const serialized = JSON.stringify(value);
  const replaceResult = spawnSync("plutil", ["-replace", key, "-json", serialized, plistPath], {
    encoding: "utf8",
  });
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = spawnSync("plutil", ["-insert", key, "-json", serialized, plistPath], {
    encoding: "utf8",
  });
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to run ${command} ${args.join(" ")}: ${details}`.trim());
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeDevelopmentLauncherScript(targetBinaryPath, electronBinaryPath) {
  const mainEntryPath = join(desktopDir, "dist-electron", "main.cjs");
  const protocolCallbackUrl = `http://127.0.0.1:${resolveDevelopmentProtocolCallbackPort()}/auth/callback`;
  const envEntries = [
    ["VITE_DEV_SERVER_URL", process.env.VITE_DEV_SERVER_URL],
    ["T3CODE_PORT", process.env.T3CODE_PORT],
    ["T3CODE_HOME", process.env.T3CODE_HOME],
    ["T3CODE_COMMIT_HASH", process.env.T3CODE_COMMIT_HASH],
    ["T3CODE_OTLP_TRACES_URL", process.env.T3CODE_OTLP_TRACES_URL],
    ["T3CODE_OTLP_EXPORT_INTERVAL_MS", process.env.T3CODE_OTLP_EXPORT_INTERVAL_MS],
    ["T3CODE_DESKTOP_APP_USER_MODEL_ID", APP_BUNDLE_ID],
    ["T3CODE_DESKTOP_PROTOCOL_REGISTRATION_MANAGED", "1"],
    ["T3CODE_DESKTOP_PROTOCOL_CALLBACK_URL", protocolCallbackUrl],
  ].filter((entry) => typeof entry[1] === "string" && entry[1].trim().length > 0);
  writeFileSync(
    targetBinaryPath,
    [
      "#!/bin/sh",
      ...envEntries.map(([name, value]) => `export ${name}=${shellSingleQuote(value)}`),
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    t3code-dev://auth/callback*)",
      '      if [ -n "$T3CODE_DESKTOP_PROTOCOL_CALLBACK_URL" ]; then',
      '        /usr/bin/curl -fsS --max-time 2 -X POST --data-binary "$arg" "$T3CODE_DESKTOP_PROTOCOL_CALLBACK_URL" >/dev/null 2>&1 && exit 0',
      "      fi",
      "      ;;",
      "  esac",
      "done",
      `exec ${shellSingleQuote(electronBinaryPath)} --t3code-dev-root=${shellSingleQuote(desktopDir)} ${shellSingleQuote(mainEntryPath)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(targetBinaryPath, 0o755);
}

function registerMacLauncherBundle(appBundlePath) {
  runChecked(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", appBundlePath],
  );

  if (!isDevelopment) {
    return;
  }

  for (const scheme of APP_PROTOCOL_SCHEMES) {
    runChecked("osascript", [
      "-l",
      "JavaScript",
      "-e",
      [
        'ObjC.import("CoreServices");',
        `const scheme = $.NSString.alloc.initWithUTF8String(${JSON.stringify(scheme)});`,
        `const bundle = $.NSString.alloc.initWithUTF8String(${JSON.stringify(APP_BUNDLE_ID)});`,
        "const status = $.LSSetDefaultHandlerForURLScheme(scheme, bundle);",
        "if (status !== 0) throw new Error(`LSSetDefaultHandlerForURLScheme failed: ${status}`);",
      ].join(" "),
    ]);
  }
}

function ensureDevelopmentIconIcns(runtimeDir) {
  const generatedIconPath = join(runtimeDir, "icon-dev.icns");
  mkdirSync(runtimeDir, { recursive: true });

  if (!existsSync(developmentMacIconPngPath)) {
    return defaultIconPath;
  }

  const sourceMtimeMs = statSync(developmentMacIconPngPath).mtimeMs;
  if (existsSync(generatedIconPath) && statSync(generatedIconPath).mtimeMs >= sourceMtimeMs) {
    return generatedIconPath;
  }

  const iconsetRoot = mkdtempSync(join(runtimeDir, "dev-iconset-"));
  const iconsetDir = join(iconsetRoot, "icon.iconset");
  mkdirSync(iconsetDir, { recursive: true });

  try {
    for (const size of [16, 32, 128, 256, 512]) {
      runChecked("sips", [
        "-z",
        String(size),
        String(size),
        developmentMacIconPngPath,
        "--out",
        join(iconsetDir, `icon_${size}x${size}.png`),
      ]);

      const retinaSize = size * 2;
      runChecked("sips", [
        "-z",
        String(retinaSize),
        String(retinaSize),
        developmentMacIconPngPath,
        "--out",
        join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ]);
    }

    runChecked("iconutil", ["-c", "icns", iconsetDir, "-o", generatedIconPath]);
    return generatedIconPath;
  } catch (error) {
    console.warn(
      "[desktop-launcher] Failed to generate dev macOS icon, falling back to default icon.",
      error,
    );
    return defaultIconPath;
  } finally {
    rmSync(iconsetRoot, { recursive: true, force: true });
  }
}

function patchMainBundleInfoPlist(appBundlePath, iconPath) {
  const infoPlistPath = join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");
  setPlistJson(infoPlistPath, "CFBundleURLTypes", [
    {
      CFBundleURLName: APP_BUNDLE_ID,
      CFBundleURLSchemes: APP_PROTOCOL_SCHEMES,
    },
  ]);

  const resourcesDir = join(appBundlePath, "Contents", "Resources");
  copyFileSync(iconPath, join(resourcesDir, "icon.icns"));
  copyFileSync(iconPath, join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const helperBundleNames = [
    ["Electron Helper.app", "helper", `${APP_DISPLAY_NAME} Helper`],
    ["Electron Helper (GPU).app", "helper.gpu", `${APP_DISPLAY_NAME} Helper (GPU)`],
    ["Electron Helper (Plugin).app", "helper.plugin", `${APP_DISPLAY_NAME} Helper (Plugin)`],
    ["Electron Helper (Renderer).app", "helper.renderer", `${APP_DISPLAY_NAME} Helper (Renderer)`],
  ];

  for (const [bundleName, bundleIdentifierSuffix, bundleDisplayName] of helperBundleNames) {
    const infoPlistPath = join(
      appBundlePath,
      "Contents",
      "Frameworks",
      bundleName,
      "Contents",
      "Info.plist",
    );
    if (!existsSync(infoPlistPath)) {
      continue;
    }

    setPlistString(infoPlistPath, "CFBundleDisplayName", bundleDisplayName);
    setPlistString(infoPlistPath, "CFBundleName", bundleDisplayName);
    setPlistString(
      infoPlistPath,
      "CFBundleIdentifier",
      `${APP_BUNDLE_ID}.${bundleIdentifierSuffix}`,
    );
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = resolve(dirname(electronBinaryPath), "../..");
  const runtimeDir = join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const targetBinaryPath = join(targetAppBundlePath, "Contents", "MacOS", "Electron");
  const iconPath = isDevelopment ? ensureDevelopmentIconIcns(runtimeDir) : defaultIconPath;
  const metadataPath = join(runtimeDir, "metadata.json");

  mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: statSync(iconPath).mtimeMs,
    appBundleId: APP_BUNDLE_ID,
    appProtocolSchemes: APP_PROTOCOL_SCHEMES,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    existsSync(targetBinaryPath) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    registerMacLauncherBundle(targetAppBundlePath);
    return targetBinaryPath;
  }

  rmSync(targetAppBundlePath, { recursive: true, force: true });
  cpSync(sourceAppBundlePath, targetAppBundlePath, { recursive: true });
  patchMainBundleInfoPlist(targetAppBundlePath, iconPath);
  patchHelperBundleInfoPlists(targetAppBundlePath);
  if (isDevelopment) {
    writeDevelopmentLauncherScript(targetBinaryPath, electronBinaryPath);
  }
  writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
  registerMacLauncherBundle(targetAppBundlePath);

  return targetBinaryPath;
}

function isLinuxSetuidSandboxConfigured(electronBinaryPath) {
  if (process.platform !== "linux") {
    return true;
  }

  const sandboxPath = join(dirname(electronBinaryPath), "chrome-sandbox");
  try {
    const sandboxStat = statSync(sandboxPath);
    return sandboxStat.uid === 0 && (sandboxStat.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
}

function resolveLinuxSandboxArgs(electronBinaryPath) {
  if (isLinuxSetuidSandboxConfigured(electronBinaryPath)) {
    return [];
  }

  console.warn(
    "[desktop-launcher] Electron chrome-sandbox is not root-owned with mode 4755; launching local Electron with --no-sandbox.",
  );
  return ["--no-sandbox"];
}

export function resolveElectronPath() {
  ensureElectronRuntime();

  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");

  if (process.platform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath);
}

export function resolveElectronLaunchCommand(args = []) {
  const electronPath = resolveElectronPath();
  return {
    electronPath,
    args: [...resolveLinuxSandboxArgs(electronPath), ...args],
  };
}

export function resolveDevProtocolClient() {
  if (process.platform !== "darwin" || !isDevelopment) {
    return null;
  }

  const require = createRequire(import.meta.url);
  const electronBinaryPath = require("electron");
  const launcherBinaryPath = buildMacLauncher(electronBinaryPath);
  return {
    appBundlePath: resolve(launcherBinaryPath, "..", "..", ".."),
    appBundleId: APP_BUNDLE_ID,
  };
}
