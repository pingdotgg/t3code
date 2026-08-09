#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - macOS artifact verification invokes platform security tools directly in CI.

import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import { PNG } from "pngjs";

import { TWO_CODE_PRODUCTION_PROFILE } from "../2code-desktop-distribution.ts";
import { verifyElectronBlockmap } from "./electron-blockmap.ts";
import {
  expectedArtifactNames,
  readReleaseConfig,
  verifyPreparedArtifacts,
  type TwoCodeReleaseConfig,
} from "./release-core.ts";

interface MacBundlePlist {
  readonly CFBundleIdentifier?: unknown;
  readonly CFBundleName?: unknown;
  readonly CFBundleDisplayName?: unknown;
  readonly CFBundleExecutable?: unknown;
  readonly CFBundleIconFile?: unknown;
  readonly CFBundleShortVersionString?: unknown;
  readonly CFBundleURLTypes?: unknown;
}

export const MAC_ICON_REPRESENTATIONS = [
  { name: "icon_16x16.png", size: 16, pixelExact: false },
  { name: "icon_16x16@2x.png", size: 32, pixelExact: true },
  { name: "icon_32x32.png", size: 32, pixelExact: false },
  { name: "icon_32x32@2x.png", size: 64, pixelExact: true },
  { name: "icon_128x128.png", size: 128, pixelExact: true },
  { name: "icon_128x128@2x.png", size: 256, pixelExact: true },
  { name: "icon_256x256.png", size: 256, pixelExact: true },
  { name: "icon_256x256@2x.png", size: 512, pixelExact: true },
  { name: "icon_512x512.png", size: 512, pixelExact: true },
  { name: "icon_512x512@2x.png", size: 1024, pixelExact: true },
] as const;

function run(command: string, args: readonly string[]): { stdout: string; stderr: string } {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout || String(result.error ?? "")).trim()}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readYamlScalar(raw: string, key: string): string | undefined {
  const match = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)$`, "m").exec(
    raw,
  );
  if (!match?.[1]) return undefined;
  const trimmed = match[1].trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function verifyAppUpdateConfiguration(
  config: TwoCodeReleaseConfig,
  appUpdateRaw: string,
): void {
  if (readYamlScalar(appUpdateRaw, "provider") !== "generic") {
    throw new Error("Packaged app-update.yml must use the generic provider.");
  }
  if (readYamlScalar(appUpdateRaw, "url") !== config.feedUrl) {
    throw new Error("Packaged app-update.yml does not point to the production 2code feed.");
  }
  if (readYamlScalar(appUpdateRaw, "updaterCacheDirName") !== config.updaterCacheDirName) {
    throw new Error("Packaged app-update.yml does not retain the 2code updater cache name.");
  }
}

export function verifyBundlePlist(config: TwoCodeReleaseConfig, plist: MacBundlePlist): void {
  if (plist.CFBundleIdentifier !== config.appId) {
    throw new Error(`Bundle ID must be ${config.appId}.`);
  }
  if (plist.CFBundleShortVersionString !== config.version) {
    throw new Error(`Bundle version must be ${config.version}.`);
  }
  if (
    plist.CFBundleName !== config.productName &&
    plist.CFBundleDisplayName !== config.productName
  ) {
    throw new Error(`Bundle name/display name must retain '${config.productName}'.`);
  }
  if (plist.CFBundleExecutable !== config.executableName) {
    throw new Error(`Bundle executable must retain '${config.executableName}'.`);
  }
  if (plist.CFBundleIconFile !== "icon.icns") {
    throw new Error("Bundle icon must be icon.icns.");
  }
  if (!Array.isArray(plist.CFBundleURLTypes)) {
    throw new Error("Bundle has no URL protocol declarations.");
  }
  const schemes = plist.CFBundleURLTypes.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const rawSchemes = (entry as { CFBundleURLSchemes?: unknown }).CFBundleURLSchemes;
    return Array.isArray(rawSchemes)
      ? rawSchemes.filter((scheme): scheme is string => typeof scheme === "string")
      : [];
  });
  const actualSchemes = [...new Set(schemes)].toSorted();
  const expectedSchemes = [...config.protocolSchemes].toSorted();
  if (JSON.stringify(actualSchemes) !== JSON.stringify(expectedSchemes)) {
    throw new Error(
      `Bundle URL protocols must be exactly '${expectedSchemes.join(", ")}', got '${actualSchemes.join(", ")}'.`,
    );
  }
}

export function verifyIconRepresentationNames(actualNames: readonly string[]): void {
  const actual = [...actualNames].toSorted();
  const expected = MAC_ICON_REPRESENTATIONS.map(({ name }) => name).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Finder icon does not contain the complete legacy 2code iconset.");
  }
}

export function verifyPngPixelsMatch(
  expected: Uint8Array,
  actual: Uint8Array,
  artifactLabel: string,
): void {
  const expectedPng = PNG.sync.read(NodeBuffer.Buffer.from(expected));
  const actualPng = PNG.sync.read(NodeBuffer.Buffer.from(actual));
  const matches =
    expectedPng.width === actualPng.width &&
    expectedPng.height === actualPng.height &&
    expectedPng.data.byteLength === actualPng.data.byteLength &&
    expectedPng.data.every((byte, index) => byte === actualPng.data[index]);
  if (!matches) {
    throw new Error(`${artifactLabel} does not match the legacy 2code icon.`);
  }
}

export function verifyLegacyIconSource(raw: Uint8Array, expectedSha256: string): void {
  const actualSha256 = NodeCrypto.createHash("sha256").update(raw).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Canonical 2code icon does not match the frozen legacy artwork.");
  }
  const png = PNG.sync.read(NodeBuffer.Buffer.from(raw));
  if (png.width !== 1024 || png.height !== 1024) {
    throw new Error("Canonical 2code icon must be exactly 1024x1024 pixels.");
  }
}

async function verifyResizedIcon(input: {
  readonly sourcePath: string;
  readonly packagedPath: string;
  readonly expectedPath: string;
  readonly size: number;
  readonly artifactLabel: string;
}): Promise<void> {
  const size = String(input.size);
  run("sips", [
    "-s",
    "format",
    "png",
    "-z",
    size,
    size,
    input.sourcePath,
    "--out",
    input.expectedPath,
  ]);
  verifyPngPixelsMatch(
    await NodeFSP.readFile(input.expectedPath),
    await NodeFSP.readFile(input.packagedPath),
    input.artifactLabel,
  );
}

export function verifyEntitlements(raw: string): void {
  const required = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.network.client",
    "com.apple.security.network.server",
    "com.apple.security.device.audio-input",
  ];
  for (const entitlement of required) {
    const index = raw.indexOf(`<key>${entitlement}</key>`);
    const following = index < 0 ? "" : raw.slice(index, index + entitlement.length + 80);
    if (index < 0 || !following.includes("<true")) {
      throw new Error(`Signed app is missing required entitlement '${entitlement}'.`);
    }
  }
}

export function verifyDesignatedRequirement(config: TwoCodeReleaseConfig, raw: string): void {
  if (!raw.includes(`identifier "${config.appId}"`) || !raw.includes(config.teamId)) {
    throw new Error("Signed app designated requirement does not retain the legacy identity.");
  }
}

export function verifyDeveloperIdSignature(
  config: TwoCodeReleaseConfig,
  raw: string,
  artifactLabel: string,
): void {
  if (!raw.split(/\r?\n/).includes(`TeamIdentifier=${config.teamId}`)) {
    throw new Error(`${artifactLabel} TeamIdentifier is not ${config.teamId}.`);
  }
  const expectedAuthority = `Authority=Developer ID Application: hafencity.dev GmbH (${config.teamId})`;
  if (!raw.split(/\r?\n/).includes(expectedAuthority)) {
    throw new Error(
      `${artifactLabel} does not use the expected hafencity.dev Developer ID identity.`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const artifactIndex = args.indexOf("--artifact-dir");
  const configIndex = args.indexOf("--config");
  const artifactDirectory = artifactIndex >= 0 ? args[artifactIndex + 1] : undefined;
  const configPath = configIndex >= 0 ? args[configIndex + 1] : "distributions/2code/release.json";
  if (!artifactDirectory) throw new Error("--artifact-dir is required.");

  const config = await readReleaseConfig(configPath);
  await verifyPreparedArtifacts({ config, artifactDirectory: NodePath.resolve(artifactDirectory) });
  const [zipName, dmgName] = expectedArtifactNames(config);
  const zipPath = NodePath.resolve(artifactDirectory, zipName);
  const dmgPath = NodePath.resolve(artifactDirectory, dmgName);
  await verifyElectronBlockmap(zipPath);
  await verifyElectronBlockmap(dmgPath);
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "2code-macos-verify-"),
  );
  try {
    run("ditto", ["-x", "-k", zipPath, temporaryDirectory]);
    const appPath = NodePath.join(temporaryDirectory, `${config.productName}.app`);
    const infoPath = NodePath.join(appPath, "Contents", "Info.plist");
    const plistJson = run("plutil", ["-convert", "json", "-o", "-", infoPath]).stdout;
    const plist = JSON.parse(plistJson) as MacBundlePlist;
    verifyBundlePlist(config, plist);

    const legacyIconSourcePath = NodePath.resolve(
      TWO_CODE_PRODUCTION_PROFILE.iconAssets.macIconPng,
    );
    verifyLegacyIconSource(
      await NodeFSP.readFile(legacyIconSourcePath),
      TWO_CODE_PRODUCTION_PROFILE.iconSourceSha256,
    );
    const bundleIconPath = NodePath.join(appPath, "Contents", "Resources", "icon.icns");
    const iconsetDirectory = NodePath.join(temporaryDirectory, "bundle-icon.iconset");
    run("iconutil", ["-c", "iconset", "-o", iconsetDirectory, bundleIconPath]);
    verifyIconRepresentationNames(await NodeFSP.readdir(iconsetDirectory));
    for (const representation of MAC_ICON_REPRESENTATIONS) {
      // iconutil's legacy non-retina 16px/32px encodings are lossy. Their
      // retina equivalents and every larger representation remain pixel-exact.
      if (!representation.pixelExact) continue;
      await verifyResizedIcon({
        sourcePath: legacyIconSourcePath,
        packagedPath: NodePath.join(iconsetDirectory, representation.name),
        expectedPath: NodePath.join(temporaryDirectory, `expected-${representation.name}`),
        size: representation.size,
        artifactLabel: `Finder icon ${representation.name}`,
      });
    }

    run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
    const signature = run("codesign", ["-d", "--verbose=4", appPath]).stderr;
    verifyDeveloperIdSignature(config, signature, "Signed app");
    const requirementResult = run("codesign", ["-d", "-r-", appPath]);
    verifyDesignatedRequirement(config, `${requirementResult.stdout}\n${requirementResult.stderr}`);
    const entitlements = run("codesign", ["-d", "--entitlements", ":-", appPath]);
    verifyEntitlements(`${entitlements.stdout}\n${entitlements.stderr}`);

    const executablePath = NodePath.join(appPath, "Contents", "MacOS", config.executableName);
    const architectures = run("lipo", ["-archs", executablePath]).stdout.trim().split(/\s+/);
    if (architectures.length !== 1 || architectures[0] !== config.architecture) {
      throw new Error(`Expected arm64-only executable, got '${architectures.join(" ")}'.`);
    }

    const appUpdatePath = NodePath.join(appPath, "Contents", "Resources", "app-update.yml");
    verifyAppUpdateConfiguration(config, await NodeFSP.readFile(appUpdatePath, "utf8"));

    const pnpmDirectory = NodePath.resolve("node_modules/.pnpm");
    const asarPackage = (await NodeFSP.readdir(pnpmDirectory)).find((entry) =>
      entry.startsWith("@electron+asar@"),
    );
    if (!asarPackage) throw new Error("@electron/asar is unavailable for release verification.");
    const asarCli = NodePath.join(
      pnpmDirectory,
      asarPackage,
      "node_modules",
      "@electron",
      "asar",
      "bin",
      "asar.js",
    );
    const metadataDirectory = NodePath.join(temporaryDirectory, "asar-metadata");
    await NodeFSP.mkdir(metadataDirectory);
    const asarArchive = NodePath.join(appPath, "Contents", "Resources", "app.asar");
    const asarResult = NodeChildProcess.spawnSync(
      process.execPath,
      [asarCli, "extract-file", asarArchive, "package.json"],
      { cwd: metadataDirectory, encoding: "utf8" },
    );
    if ((asarResult.status ?? 1) !== 0) {
      throw new Error(`Could not extract packaged metadata: ${asarResult.stderr?.trim() ?? ""}`);
    }
    const packagedMetadata = JSON.parse(
      await NodeFSP.readFile(NodePath.join(metadataDirectory, "package.json"), "utf8"),
    ) as { t3codeDistribution?: unknown; t3codeRuntimeVersion?: unknown; version?: unknown };
    if (packagedMetadata.t3codeDistribution !== config.distribution) {
      throw new Error("Packaged metadata does not select the 2code-production distribution.");
    }
    if (
      typeof packagedMetadata.t3codeRuntimeVersion !== "string" ||
      packagedMetadata.t3codeRuntimeVersion.trim().length === 0 ||
      packagedMetadata.t3codeRuntimeVersion === config.version
    ) {
      throw new Error("Packaged metadata has an invalid or distribution-version runtime version.");
    }
    if (packagedMetadata.version !== config.version) {
      throw new Error("Packaged Electron version does not match the 2code updater version.");
    }
    // electron-builder filters buildResources from app.asar. The staged copy is
    // the guaranteed packaged fallback used by DesktopAssets for the Dock icon.
    const runtimeIconDirectory = NodePath.join(temporaryDirectory, "runtime-icon");
    await NodeFSP.mkdir(runtimeIconDirectory);
    const runtimeIconResult = NodeChildProcess.spawnSync(
      process.execPath,
      [asarCli, "extract-file", asarArchive, "apps/desktop/prod-resources/icon.png"],
      { cwd: runtimeIconDirectory, encoding: "utf8" },
    );
    if ((runtimeIconResult.status ?? 1) !== 0) {
      throw new Error(
        `Could not extract packaged runtime icon: ${runtimeIconResult.stderr?.trim() ?? ""}`,
      );
    }
    await verifyResizedIcon({
      sourcePath: legacyIconSourcePath,
      packagedPath: NodePath.join(runtimeIconDirectory, "icon.png"),
      expectedPath: NodePath.join(temporaryDirectory, "expected-runtime-icon.png"),
      size: 512,
      artifactLabel: "Dock icon",
    });
    run("xcrun", ["stapler", "validate", appPath]);
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    run("codesign", ["--verify", "--strict", "--verbose=2", dmgPath]);
    const dmgSignature = run("codesign", ["-d", "--verbose=4", dmgPath]).stderr;
    verifyDeveloperIdSignature(config, dmgSignature, "Signed disk image");
    run("xcrun", ["stapler", "validate", dmgPath]);
    run("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmgPath,
    ]);
    console.log(
      `Verified signed and notarized ${config.productName} ${config.version} (${config.appId}, ${config.teamId}, arm64).`,
    );
  } finally {
    await NodeFSP.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
