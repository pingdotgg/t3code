// @effect-diagnostics nodeBuiltinImport:off

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import { createPackageWithOptions } from "@electron/asar";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  BundleNotSelfContainedError,
  BuildCommandFailedError,
  DesktopDmgBackgroundSourceMissingError,
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  DESKTOP_VOICE_EXTRA_RESOURCE,
  JARVIS_NATIVE_VOICE_WORKER_FILES,
  JARVIS_VOICE_REQUIRED_FILES,
  JARVIS_VOICE_RESOURCE_DESTINATION_DIR,
  resolveJarvisNativeVoiceDependencies,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  isMacPasskeySigningConfigurationError,
  LinuxIconResizeError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  renderMacEntitlements,
  renderMacPasskeyEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  assertDesktopArtifactStageIsolated,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resolveWindowsServerAsarIgnoreGlobs,
  resourceMonitorExecutableName,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  normalizeAsarEntryPath,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  stageDesktopDmgBackground,
  stageResourceMonitor,
  STAGE_INSTALL_ARGS,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  validateWindowsPackagedPayload,
  WindowsPrimaryNativeProbeError,
  WindowsPackagedPayloadValidationError,
  WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS,
  WINDOWS_ELECTRON_RUNTIME_FILES,
  windowsPackagedPayloadByteBreakdown,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WINDOWS_SERVER_ASAR_UNPACK_GLOB,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
  NODE_CPAL_VERSION,
  NODE_CPAL_PLATFORM_BINARIES,
  nodeCpalFileExclusions,
  nodeCpalTargetDirectory,
  uiohookFileExclusions,
  uiohookTargetDirectory,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

function mockProcess(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

it("normalizes Windows and POSIX ASAR entry paths to one worker contract", () => {
  const worker = "apps/desktop/dist-electron/desktopVoiceWorker.cjs";
  assert.equal(normalizeAsarEntryPath(`\\${worker.replaceAll("/", "\\")}`), worker);
  assert.equal(normalizeAsarEntryPath(`/${worker}`), worker);
});

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
  readonly omitAppWorker?: string;
  readonly includeVoiceResources?: boolean;
  readonly duplicateVoiceModelInAppAsar?: boolean;
  readonly includeLegacyMicrophoneInAppAsar?: boolean;
  readonly extraNodeCpalFiles?: ReadonlyArray<string>;
  readonly includeNodeCpal?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const appSourceDir = path.join(tempDir, "app-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  const appVoiceNativePath = path.join(
    appSourceDir,
    "node_modules/node-cpal/bin/win32-x64/index.node",
  );
  const appVoiceWorkerDir = path.join(appSourceDir, "apps/desktop/dist-electron");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  if (input.includeNodeCpal !== false) {
    yield* fs.makeDirectory(path.dirname(appVoiceNativePath), { recursive: true });
  }
  yield* fs.makeDirectory(appVoiceWorkerDir, { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "native-binary");
  if (input.includeNodeCpal !== false) {
    yield* fs.writeFileString(appVoiceNativePath, "native-voice-binary");
    // Electron-builder may leave the published loader and package metadata
    // beside the selected native binary. Keep the fixture representative of
    // that real packaged shape.
    yield* fs.writeFileString(
      path.join(appSourceDir, "node_modules/node-cpal/index.js"),
      "module.exports = require('./bin/win32-x64/index.node');\n",
    );
    yield* fs.writeFileString(
      path.join(appSourceDir, "node_modules/node-cpal/package.json"),
      '{"name":"node-cpal","version":"0.1.1"}\n',
    );
    for (const extraFile of input.extraNodeCpalFiles ?? []) {
      const extraPath = path.join(appSourceDir, "node_modules/node-cpal", extraFile);
      yield* fs.makeDirectory(path.dirname(extraPath), { recursive: true });
      yield* fs.writeFileString(extraPath, "unexpected-node-cpal-file");
    }
  }
  if (input.includeLegacyMicrophoneInAppAsar) {
    const legacyPath = path.join(appSourceDir, "node_modules/node-cpal/bin/win32-x64/legacy.node");
    yield* fs.makeDirectory(path.dirname(legacyPath), { recursive: true });
    yield* fs.writeFileString(legacyPath, "legacy-native-voice-binary");
  }
  for (const workerFile of JARVIS_NATIVE_VOICE_WORKER_FILES) {
    if (workerFile === input.omitAppWorker) continue;
    yield* fs.writeFileString(
      path.join(appVoiceWorkerDir, workerFile),
      `console.log('${workerFile}');\n`,
    );
  }
  if (input.duplicateVoiceModelInAppAsar) {
    const duplicatePath = path.join(
      appSourceDir,
      "apps/desktop/prod-resources/jarvis-resources/parakeet/encoder.int8.onnx",
    );
    yield* fs.makeDirectory(path.dirname(duplicatePath), { recursive: true });
    yield* fs.writeFileString(duplicatePath, "duplicate-voice-model");
  }

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });
  const generatedAppAsarPath = path.join(tempDir, "app.asar");
  yield* Effect.tryPromise(() =>
    createPackageWithOptions(appSourceDir, generatedAppAsarPath, {
      unpack: input.includeNodeCpal === false ? "**/*.node" : "**/node_modules/node-cpal/**",
    }),
  );
  if (input.includeNodeCpal === false) {
    yield* fs.makeDirectory(`${generatedAppAsarPath}.unpacked`, { recursive: true });
  }

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAppAsarPath, path.join(resourcesDir, "app.asar"));
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
  yield* fs.copy(`${generatedAppAsarPath}.unpacked`, path.join(resourcesDir, "app.asar.unpacked"));
  if (input.copyUnpackedNatives) {
    yield* fs.copy(
      `${generatedAsarPath}.unpacked`,
      path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
    );
  }
  yield* fs.writeFileString(
    path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
    "monitor",
  );
  if (input.includeVoiceResources) {
    for (const file of JARVIS_VOICE_REQUIRED_FILES) {
      yield* fs.makeDirectory(
        path.dirname(path.join(resourcesDir, JARVIS_VOICE_RESOURCE_DESTINATION_DIR, file)),
        { recursive: true },
      );
      yield* fs.writeFileString(
        path.join(resourcesDir, JARVIS_VOICE_RESOURCE_DESTINATION_DIR, file),
        `voice-resource:${file}`,
      );
    }
  }
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    generatedAppAsarPath,
    appExecutableName,
    voiceResourceFiles: input.includeVoiceResources ? JARVIS_VOICE_REQUIRED_FILES : undefined,
  } as const;
});

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Jarvis");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Jarvis (Nightly)");
  });

  it("uses the Jarvis icon family for official desktop builds on both channels", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.jarvisMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.jarvisLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.jarvisWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.jarvisMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.jarvisLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.jarvisWindowsIconIco,
    });
  });

  it("switches the bundled splash and favicon branding for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "jarvis");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "jarvis");
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig("latest").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );
      const nightlyConfig = yield* resolveGitHubPublishConfig("nightly").pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                GITHUB_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(latestConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      });
      assert.deepStrictEqual(nightlyConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "prerelease",
        channel: "nightly",
      });
    }),
  );

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@t3tools/contracts": "workspace:*",
          "@t3tools/shared": "workspace:*",
          "@t3tools/ssh": "workspace:*",
          "@t3tools/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("does not stage native microphone or hook packages for macOS Full", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "node-cpal": "0.1.1",
          "uiohook-napi": "1.5.5",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          "node-cpal": "0.1.1",
          "uiohook-napi": "1.5.5",
        },
        "mac",
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
      },
    );
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "node-cpal": "0.1.1",
          "uiohook-napi": "1.5.5",
        },
        {
          "node-cpal": "0.1.1",
          "uiohook-napi": "1.5.5",
        },
        "linux",
      ),
      {
        "node-cpal": "0.1.1",
        "uiohook-napi": "1.5.5",
      },
    );
  });

  it("carries only staged dependency patch metadata into staged desktop installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        {
          "@ff-labs/fff-node": "0.9.4",
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.73",
        },
      ),
      {
        "@ff-labs/fff-node@0.9.4": "patches/@ff-labs__fff-node@0.9.4.patch",
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
      },
    );

    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.73" },
      ),
      {},
    );
  });

  it("installs optional native dependencies for the target desktop architecture", () => {
    assert.deepStrictEqual(STAGE_INSTALL_ARGS, ["install", "--prod"]);
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "x64" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["x64"],
      },
    });
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "linux", arch: "x64" }), {
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
    // The Windows app stage only serves the desktop main process; the server
    // sidecar stage is the one that needs Linux natives (below).
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "win", arch: "x64" }), {
      supportedArchitectures: {
        os: ["win32"],
        cpu: ["x64"],
      },
    });
    // The server sidecar stage bundles the same-architecture WSL (Linux,
    // glibc) backend, so its install must fetch Linux native optional deps
    // (e.g. ffi-rs) too — and must be hoisted so the tree survives asar
    // packing and runtime extraction without symlinks.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({ platform: "win", arch: "x64", linuxServerBackend: true }),
      {
        supportedArchitectures: {
          os: ["win32", "linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        nodeLinker: "hoisted",
      },
    );
    assert.deepStrictEqual(
      createStageWorkspaceConfig({ platform: "win", arch: "arm64", linuxServerBackend: true }),
      {
        supportedArchitectures: {
          os: ["win32", "linux"],
          cpu: ["arm64"],
          libc: ["glibc"],
        },
        nodeLinker: "hoisted",
      },
    );
    assert.deepStrictEqual(createStageWorkspaceConfig({ platform: "mac", arch: "universal" }), {
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
    });
  });

  it("stages pnpm 11 allowBuilds and patchedDependencies in the workspace yaml", () => {
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "linux",
        arch: "x64",
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      }),
      {
        supportedArchitectures: {
          os: ["linux"],
          cpu: ["x64"],
          libc: ["glibc"],
        },
        allowBuilds: {
          electron: true,
          "node-pty": true,
          "browser-tabs-lock": false,
        },
        patchedDependencies: {
          "effect@4.0.0-beta.73": "patches/effect@4.0.0-beta.73.patch",
        },
        overrides: {
          effect: "4.0.0-beta.73",
        },
      },
    );

    // Empty maps must not be written — pnpm would still require reviewed
    // packages if allowBuilds is present but incomplete, and omitting empty
    // patchedDependencies keeps the stage yaml minimal.
    assert.deepStrictEqual(
      createStageWorkspaceConfig({
        platform: "mac",
        arch: "arm64",
        allowBuilds: {},
        patchedDependencies: {},
        overrides: {},
      }),
      {
        supportedArchitectures: {
          os: ["darwin"],
          cpu: ["arm64"],
        },
      },
    );
  });

  it("limits Electron locales and excludes staging/debug-only payloads", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
      "!apps/desktop/prod-resources",
      "!apps/desktop/prod-resources/**/*",
      "!**/*.map",
    ]);
    assert.equal(WINDOWS_SERVER_RESOURCE_SOURCE_DIR, "apps/desktop/prod-resources/windows-server");
    assert.deepStrictEqual(WINDOWS_SERVER_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/windows-server",
        to: ".",
        filter: ["server.asar", "server.asar.unpacked/**/*"],
      },
    ]);
  });

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        "x64",
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        "x64",
        true,
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        "x64",
      );
      const macWithVoice = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        "x64",
        true,
      );
      const linuxArm64 = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        "arm64",
      );
      const winArm64 = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        "arm64",
      );

      // All platforms keep app.asar fully packed; Windows ships the server
      // tree as the hand-packed server.asar sidecar in extraResources instead
      // of unpacking thousands of loose files at install time.
      assert.notProperty(mac, "asarUnpack");
      assert.deepStrictEqual((mac.mac as Record<string, unknown>).target, ["dmg"]);
      assert.notProperty(linux, "asarUnpack");
      assert.notProperty(win, "asarUnpack");
      assert.include(linux.files as string[], "!**/node_modules/node-cpal/bin/darwin-x64/**");
      assert.notInclude(linux.files as string[], "!**/node_modules/node-cpal/bin/linux-x64/**");
      assert.include(win.files as string[], "!**/node_modules/node-cpal/bin/linux-x64/**");
      assert.notInclude(win.files as string[], "!**/node_modules/node-cpal/bin/win32-x64/**");
      assert.include(win.files as string[], "!**/node_modules/uiohook-napi/prebuilds/linux-x64/**");
      assert.notInclude(
        win.files as string[],
        "!**/node_modules/uiohook-napi/prebuilds/win32-x64/**",
      );
      assert.include(
        linux.files as string[],
        "!**/node_modules/uiohook-napi/prebuilds/win32-x64/**",
      );
      assert.notInclude(
        linux.files as string[],
        "!**/node_modules/uiohook-napi/prebuilds/linux-x64/**",
      );
      assert.deepStrictEqual(mac.files, [
        ...DESKTOP_FILE_EXCLUSIONS,
        ...nodeCpalFileExclusions("mac", "x64"),
        ...uiohookFileExclusions("mac", "x64"),
      ]);
      assert.deepStrictEqual(linuxArm64.files, [
        ...DESKTOP_FILE_EXCLUSIONS,
        ...nodeCpalFileExclusions("linux", "arm64"),
        ...uiohookFileExclusions("linux", "arm64"),
      ]);
      assert.deepStrictEqual(winArm64.files, [
        ...DESKTOP_FILE_EXCLUSIONS,
        ...nodeCpalFileExclusions("win", "arm64"),
        ...uiohookFileExclusions("win", "arm64"),
      ]);
      assert.deepStrictEqual(win.extraResources, [
        {
          from: "apps/desktop/prod-resources/resource-monitor",
          to: "resource-monitor",
        },
        {
          from: "apps/desktop/resources/jarvis-official-release.json",
          to: "jarvis-official-release.json",
        },
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(linux.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        DESKTOP_VOICE_EXTRA_RESOURCE,
      ]);
      assert.deepStrictEqual(win.nsis, { differentialPackage: true });
      // Native binaries and helper executables cannot load from inside an
      // asar; everything else stays packed. The Claude SDK platform packages
      // and .bin shims never ship.
      assert.equal(
        WINDOWS_SERVER_ASAR_UNPACK_GLOB,
        "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}",
      );
      assert.deepStrictEqual(WINDOWS_SERVER_ASAR_IGNORE_GLOBS, [
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
        "**/node_modules/.bin",
        "**/node_modules/.bin/**",
      ]);
      assert.deepStrictEqual(mac.dmg, {
        title: "Jarvis 1.2.3 Installer",
        background: "dmg/dmg-background-latest.png",
        window: { width: 540, height: 412 },
        contents: [
          { x: 130, y: 220, type: "file" },
          { x: 410, y: 220, type: "link", path: "/Applications" },
        ],
        iconSize: 80,
        iconTextSize: 12,
      });
      // Linux must register the renderer schemes so the generated .desktop
      // entry advertises MimeType=x-scheme-handler/jarvis; for OAuth deep links.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        { name: "Jarvis", schemes: ["jarvis", "jarvis-dev"] },
      ]);
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).executableArgs, [
        "--no-sandbox",
        "--ozone-platform=x11",
        "--disable-gpu-compositing",
      ]);
      assert.deepStrictEqual(mac.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
      assert.deepStrictEqual(mac.files, [
        ...DESKTOP_FILE_EXCLUSIONS,
        ...nodeCpalFileExclusions("mac", "x64"),
        ...uiohookFileExclusions("mac", "x64"),
      ]);
      assert.deepStrictEqual(macWithVoice.extraResources, [
        ...DESKTOP_EXTRA_RESOURCES,
        DESKTOP_VOICE_EXTRA_RESOURCE,
      ]);
      assert.include(
        macWithVoice.files as string[],
        "!**/node_modules/node-cpal/bin/darwin-x64/**",
      );
      assert.include(
        macWithVoice.files as string[],
        "!**/node_modules/uiohook-napi/prebuilds/darwin-x64/**",
      );
      assert.deepStrictEqual(linux.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
      assert.deepStrictEqual(linux.files, [
        ...DESKTOP_FILE_EXCLUSIONS,
        ...nodeCpalFileExclusions("linux", "x64"),
        ...uiohookFileExclusions("linux", "x64"),
      ]);
      assert.deepStrictEqual(win.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
      assert.deepStrictEqual(win.files, [
        ...DESKTOP_FILE_EXCLUSIONS,
        ...nodeCpalFileExclusions("win", "x64"),
        ...uiohookFileExclusions("win", "x64"),
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("excludes node-pty binaries for the other Windows architecture", () => {
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("x64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-arm64",
      "**/node_modules/node-pty/prebuilds/win32-arm64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**",
    ]);
    assert.deepStrictEqual(resolveWindowsServerAsarIgnoreGlobs("arm64"), [
      ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
      "**/node_modules/node-pty/prebuilds/win32-x64",
      "**/node_modules/node-pty/prebuilds/win32-x64/**",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64",
      "**/node_modules/node-pty/third_party/conpty/*/win10-x64/**",
    ]);
  });

  it.effect(
    "keeps target and WSL native files while excluding the other Windows architecture",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-windows-architecture-test-",
          });
          const sourceDir = path.join(tempDir, "server");
          const nativeFiles = [
            "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
            "node_modules/node-pty/prebuilds/win32-arm64/conpty/OpenConsole.exe",
            "node_modules/node-pty/prebuilds/linux-x64/pty.node",
            "node_modules/node-pty/third_party/conpty/1.0.0/win10-x64/OpenConsole.exe",
            "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64/OpenConsole.exe",
          ];

          for (const nativeFile of nativeFiles) {
            const nativePath = path.join(sourceDir, nativeFile);
            yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
            yield* fs.writeFileString(nativePath, "native");
          }

          const asarPath = path.join(tempDir, "server.asar");
          yield* packWindowsServerAsar({ sourceDir, asarPath, arch: "x64" });
          const unpackedRoot = `${asarPath}.unpacked`;

          assert.isTrue(
            yield* fs.exists(
              path.join(
                unpackedRoot,
                "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
              ),
            ),
          );
          assert.isTrue(
            yield* fs.exists(
              path.join(unpackedRoot, "node_modules/node-pty/prebuilds/linux-x64/pty.node"),
            ),
          );
          assert.isFalse(
            yield* fs.exists(
              path.join(unpackedRoot, "node_modules/node-pty/prebuilds/win32-arm64"),
            ),
          );
          assert.isFalse(
            yield* fs.exists(
              path.join(unpackedRoot, "node_modules/node-pty/third_party/conpty/1.0.0/win10-arm64"),
            ),
          );
        }),
      ),
  );

  it.effect("stages a cached resource monitor without invoking Cargo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-resource-monitor-cache-test-",
        });
        const binaryPath = path.join(
          repoRoot,
          "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
        );
        const stageResourcesDir = path.join(repoRoot, "stage");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "cached monitor");

        yield* stageResourceMonitor({
          repoRoot,
          stageResourcesDir,
          platform: "linux",
          arch: "x64",
          verbose: false,
        }).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
              }),
            ),
          ),
        );

        assert.equal(
          yield* fs.readFileString(
            path.join(stageResourcesDir, "resource-monitor/t3-resource-monitor"),
          ),
          "cached monitor",
        );
      }),
    ),
  );

  it.effect("validates every ASAR-unpacked native in the packaged Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        });

        const secondAsarPath = path.join(path.dirname(fixture.generatedAsarPath), "second.asar");
        yield* packWindowsServerAsar({
          sourceDir: fixture.sourceDir,
          asarPath: secondAsarPath,
          arch: "x64",
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.equal(result.fileCount, result.manifest.length);
        assert.include(
          result.manifest.map((file) => file.path),
          "resources/app.asar.unpacked/node_modules/node-cpal/bin/win32-x64/index.node",
        );
        assert.include(
          result.manifest.map((file) => file.path),
          "resources/app.asar.unpacked/node_modules/node-cpal/index.js",
        );
        assert.include(
          result.manifest.map((file) => file.path),
          "resources/app.asar.unpacked/node_modules/node-cpal/package.json",
        );
        assert.isAbove(result.payloadBytes, 0);
        assert.equal(result.byteBreakdown.total, result.payloadBytes);
        for (const budgetName of Object.keys(WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS) as Array<
          keyof typeof WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS
        >) {
          assert.isAtMost(
            result.byteBreakdown[budgetName],
            WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS[budgetName],
          );
        }
        assert.deepStrictEqual(secondAsar, firstAsar);
      }),
    ),
  );

  it.effect("probes fff through the packaged Windows primary instead of helper executables", () => {
    const commands: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: {
        readonly cwd?: string;
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        });

        const primaryProbe = commands.find(
          (command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1",
        );
        if (primaryProbe === undefined) return assert.fail("Windows primary probe was not spawned");

        assert.equal(
          primaryProbe.command,
          path.join(fixture.packagedAppDir, fixture.appExecutableName),
        );
        assert.deepStrictEqual(primaryProbe.args.slice(0, 3), [
          "--no-global-search-paths",
          "--input-type=module",
          "--eval",
        ]);
        assert.include(primaryProbe.args[3], "FileFinder.create");
        assert.equal(
          primaryProbe.args[4],
          path.join(
            fixture.packagedAppDir,
            "resources/server.asar/node_modules/@ff-labs/fff-node/dist/src/index.js",
          ),
        );
        assert.equal(primaryProbe.options.cwd, fixture.packagedAppDir);
        assert.equal(primaryProbe.options.env?.NODE_PATH, "");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        ),
      ),
    );
  });

  it.effect("skips the primary native probe for cross-architecture Windows payloads", () => {
    const commands: Array<{
      readonly command: string;
      readonly options: {
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
    }> = [];
    const spawnerLayer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        commands.push(command as unknown as (typeof commands)[number]);
        return Effect.succeed(mockProcess(0));
      }),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeNodeCpal: false,
        });
        yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
        });

        assert.isFalse(
          commands.some((command) => command.options.env?.ELECTRON_RUN_AS_NODE === "1"),
        );
        assert.isTrue(
          commands.some(
            (command) =>
              command.command === process.execPath && command.options.env?.NODE_PATH === "",
          ),
        );
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          spawnerLayer,
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        ),
      ),
    );
  });

  it.effect("rejects node-cpal binaries in an arm64 Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unexpected-files");
        assert.deepStrictEqual(error.missingFiles, []);
        assert.deepStrictEqual(error.unexpectedFiles, [
          "resources/app.asar.unpacked/node_modules/node-cpal/bin/win32-x64/index.node",
        ]);
        assert.instanceOf(error.cause, Error);
        assert.equal(
          error.cause.message,
          "Packaged Desktop must not contain node-cpal binaries for this Windows architecture.",
        );
      }),
    ),
  );

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeNodeCpal: false,
        });
        const executablePath = path.join(fixture.packagedAppDir, fixture.appExecutableName);
        yield* fs.remove(executablePath);

        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "arm64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPrimaryNativeProbeError);
        assert.equal(error.executablePath, executablePath);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        ),
      ),
    ),
  );

  it.effect("rejects a packaged sidecar whose ASAR-unpacked native is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: false });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unpacked-native-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);
      }),
    ),
  );

  it.effect("rejects directories in place of packaged executable files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const nativePath = path.join(
          fixture.packagedAppDir,
          "resources/server.asar.unpacked/node_modules/native/addon.node",
        );
        yield* fs.remove(nativePath);
        yield* fs.makeDirectory(nativePath);

        const nativeError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);
        assert.instanceOf(nativeError, WindowsPackagedPayloadValidationError);
        assert.equal(nativeError.reason, "unpacked-native-missing");
        assert.deepStrictEqual(nativeError.missingFiles, [
          "server.asar.unpacked/node_modules/native/addon.node",
        ]);

        yield* fs.remove(nativePath, { recursive: true });
        yield* fs.writeFileString(nativePath, "native-binary");
        const resourceMonitorPath = path.join(
          fixture.packagedAppDir,
          "resources/resource-monitor/t3-resource-monitor.exe",
        );
        yield* fs.remove(resourceMonitorPath);
        yield* fs.makeDirectory(resourceMonitorPath);

        const resourceMonitorError = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);
        assert.instanceOf(resourceMonitorError, WindowsPackagedPayloadValidationError);
        assert.equal(resourceMonitorError.reason, "resource-monitor-missing");
        assert.deepStrictEqual(resourceMonitorError.missingFiles, [
          "resource-monitor/t3-resource-monitor.exe",
        ]);
      }),
    ),
  );

  it.effect("requires both native voice workers to remain inside app.asar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          omitAppWorker: JARVIS_NATIVE_VOICE_WORKER_FILES[0],
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "app-asar-invalid");
        assert.deepStrictEqual(error.missingFiles, [
          `app.asar/${JARVIS_NATIVE_VOICE_WORKER_FILES[0]}`,
        ]);
      }),
    ),
  );

  it.effect("rejects an unexpected loose Windows payload file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const unexpectedPath = path.join(fixture.packagedAppDir, "unexpected.dll");
        yield* fs.writeFileString(unexpectedPath, "unexpected");
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unexpected-files");
        assert.deepStrictEqual(error.unexpectedFiles, ["unexpected.dll"]);
      }),
    ),
  );

  it.effect("allows the official release marker in the Windows payload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        yield* fs.writeFileString(
          path.join(fixture.packagedAppDir, "resources/jarvis-official-release.json"),
          '{"official":true}',
        );

        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        });

        assert.include(
          result.manifest.map((file) => file.path),
          "resources/jarvis-official-release.json",
        );
      }),
    ),
  );

  it.effect("allows the owned native voice resource subtree when configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeVoiceResources: true,
        });
        const result = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          voiceResourceFiles: JARVIS_VOICE_REQUIRED_FILES,
        });

        assert.include(
          result.manifest.map((file) => file.path),
          "resources/jarvis-resources/parakeet/encoder.int8.onnx",
        );
        assert.include(
          result.manifest.map((file) => file.path),
          "resources/jarvis-resources/pocket/models/flow_lm_main_int8.onnx",
        );
      }),
    ),
  );

  it.effect("rejects an unexpected sibling beside the owned native voice subtree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeVoiceResources: true,
        });
        const siblingPath = path.join(
          fixture.packagedAppDir,
          "resources/jarvis-resources-extra/unexpected.dll",
        );
        yield* fs.makeDirectory(path.dirname(siblingPath), { recursive: true });
        yield* fs.writeFileString(siblingPath, "unexpected");
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          voiceResourceFiles: JARVIS_VOICE_REQUIRED_FILES,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unexpected-files");
        assert.deepStrictEqual(error.unexpectedFiles, [
          "resources/jarvis-resources-extra/unexpected.dll",
        ]);
      }),
    ),
  );

  it.effect("rejects an unexpected file inside the owned native voice subtree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeVoiceResources: true,
        });
        const extraPath = path.join(
          fixture.packagedAppDir,
          "resources/jarvis-resources/pocket/unexpected.bin",
        );
        yield* fs.writeFileString(extraPath, "unexpected");
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          voiceResourceFiles: JARVIS_VOICE_REQUIRED_FILES,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unexpected-files");
        assert.deepStrictEqual(error.unexpectedFiles, [
          "resources/jarvis-resources/pocket/unexpected.bin",
        ]);
      }),
    ),
  );

  it.effect("requires every native voice runtime file when voice resources are configured", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeVoiceResources: true,
        });
        yield* fs.remove(
          path.join(
            fixture.packagedAppDir,
            "resources/jarvis-resources/pocket/models/flow_lm_main_int8.onnx",
          ),
        );
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          voiceResourceFiles: JARVIS_VOICE_REQUIRED_FILES,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "voice-resources-missing");
        assert.deepStrictEqual(error.missingFiles, [
          "resources/jarvis-resources/pocket/models/flow_lm_main_int8.onnx",
        ]);
      }),
    ),
  );

  it.effect("rejects native voice models duplicated inside app.asar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeVoiceResources: true,
          duplicateVoiceModelInAppAsar: true,
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          voiceResourceFiles: JARVIS_VOICE_REQUIRED_FILES,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "app-asar-invalid");
        assert.deepStrictEqual(error.unexpectedFiles, [
          "apps/desktop/prod-resources/jarvis-resources/parakeet/encoder.int8.onnx",
        ]);
      }),
    ),
  );

  it.effect("rejects native voice files not declared by an ASAR header", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const unexpectedVoicePath = path.join(
          fixture.packagedAppDir,
          "resources/app.asar.unpacked/node_modules/node-cpal/extra.node",
        );
        yield* fs.makeDirectory(path.dirname(unexpectedVoicePath), { recursive: true });
        yield* fs.writeFileString(unexpectedVoicePath, "unexpected-native-voice");
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unexpected-files");
        assert.deepStrictEqual(error.unexpectedFiles, [
          "resources/app.asar.unpacked/node_modules/node-cpal/extra.node",
        ]);
      }),
    ),
  );

  it.effect("rejects extra node-cpal binaries even when app.asar declares them unpacked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          includeLegacyMicrophoneInAppAsar: true,
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unexpected-files");
        assert.deepStrictEqual(error.unexpectedFiles, [
          "resources/app.asar.unpacked/node_modules/node-cpal/bin/win32-x64/legacy.node",
        ]);
      }),
    ),
  );

  it.effect("rejects a node-cpal binary for a non-Windows platform", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          extraNodeCpalFiles: ["bin/linux-x64/index.node"],
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "unexpected-files");
        assert.deepStrictEqual(error.unexpectedFiles, [
          "resources/app.asar.unpacked/node_modules/node-cpal/bin/linux-x64/index.node",
        ]);
      }),
    ),
  );

  it("budgets packaged payload constituents instead of aggregate bytes", () => {
    const megabyte = 1024 * 1024;
    const files = [
      { path: "resources/app.asar", bytes: 200 * megabyte },
      { path: "resources/app.asar.unpacked/node_modules/native/addon.node", bytes: 100 * megabyte },
      { path: "resources/server.asar", bytes: 200 * megabyte },
      {
        path: "resources/server.asar.unpacked/node_modules/native/addon.node",
        bytes: 200 * megabyte,
      },
      {
        path: "resources/jarvis-resources/parakeet/encoder.int8.onnx",
        bytes: 400 * megabyte,
      },
      { path: WINDOWS_ELECTRON_RUNTIME_FILES[0], bytes: 100 * megabyte },
      { path: "Jarvis.exe", bytes: 100 * megabyte },
    ];
    const breakdown = windowsPackagedPayloadByteBreakdown(files, [
      "resources/jarvis-resources/parakeet/encoder.int8.onnx",
    ]);

    assert.isAbove(breakdown.total, 640 * megabyte);
    const { total, ...constituents } = breakdown;
    assert.equal(
      Object.values(constituents).reduce((sum, bytes) => sum + bytes, 0),
      total,
    );
    for (const budgetName of Object.keys(WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS) as Array<
      keyof typeof WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS
    >) {
      assert.isAtMost(breakdown[budgetName], WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS[budgetName]);
    }
  });

  it.effect("rejects a Windows payload above a constituent byte budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const oversizedRuntimePath = path.join(
          fixture.packagedAppDir,
          WINDOWS_ELECTRON_RUNTIME_FILES[0],
        );
        NodeFS.writeFileSync(oversizedRuntimePath, "");
        NodeFS.truncateSync(
          oversizedRuntimePath,
          WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS.electronRuntime + 1,
        );
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "byte-budget-exceeded");
        assert.equal(error.budget, "electronRuntime");
        assert.equal(error.byteLimit, WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS.electronRuntime);
      }),
    ),
  );

  it.effect("rejects a sidecar whose extracted server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({
          copyUnpackedNatives: true,
          serverEntrySource: 'import "t3code-deliberately-missing-package";\n',
        });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "t3code-deliberately-missing-package");
      }),
    ),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it.effect("rasterizes staged DMG backgrounds at standard and Retina sizes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-dmg-background-",
        });
        const dmgDir = path.join(stageResourcesDir, "dmg");
        yield* fs.makeDirectory(dmgDir, { recursive: true });
        const sourcePath = path.join(dmgDir, "dmg-background-nightly.svg");
        yield* fs.writeFileString(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
        const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> =
          [];

        yield* stageDesktopDmgBackground(stageResourcesDir, "nightly", false).pipe(
          Effect.provide(iconResizeSpawnerLayer(commands, [0, 0])),
        );

        assert.deepStrictEqual(
          commands.map((command) => [command.command, ...command.args]),
          [
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "380",
              "540",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly.png"),
            ],
            [
              "sips",
              "-s",
              "format",
              "png",
              "-z",
              "760",
              "1080",
              sourcePath,
              "--out",
              path.join(dmgDir, "dmg-background-nightly@2x.png"),
            ],
          ],
        );
      }),
    ),
  );

  it.effect("fails clearly when the selected DMG background source is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-dmg-background-missing-",
        });

        const error = yield* stageDesktopDmgBackground(stageResourcesDir, "latest", false).pipe(
          Effect.flip,
        );

        assert.instanceOf(error, DesktopDmgBackgroundSourceMissingError);
        assert.equal(error.channel, "latest");
        assert.include(error.sourcePath, "dmg-background-latest.svg");
      }),
    ),
  );

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "abc1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "com.abstergo.jarvis",
      teamId: "ABC1234567",
      rpDomains: ["example.clerk.accounts.dev"],
      provisioningProfilePath: "/tmp/t3code.provisionprofile",
    });
  });

  it("normalizes explicit macOS passkey RP domains and renders required entitlements", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS:
        " Clerk.Example.com,example.clerk.accounts.dev,clerk.example.com ",
    });
    const entitlements = renderMacPasskeyEntitlements(configuration);

    assert.deepStrictEqual(configuration.rpDomains, [
      "clerk.example.com",
      "example.clerk.accounts.dev",
    ]);
    assert.include(entitlements, "<string>ABC1234567.com.abstergo.jarvis</string>");
    assert.include(entitlements, "<string>webcredentials:clerk.example.com</string>");
    assert.include(entitlements, "<string>webcredentials:example.clerk.accounts.dev</string>");
    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
  });

  it("rejects incomplete macOS passkey signing configuration", () => {
    const captureError = (env: Readonly<Record<string, string | undefined>>) => {
      try {
        resolveMacPasskeySigningConfiguration(env);
      } catch (error) {
        return error;
      }
      return assert.fail("Expected passkey signing configuration to fail.");
    };

    const missingProfileError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev",
    });
    assert.instanceOf(missingProfileError, MissingMacPasskeyProvisioningProfileError);
    assert.equal(
      missingProfileError.message,
      "T3CODE_MACOS_PROVISIONING_PROFILE must point to an Associated Domains provisioning profile.",
    );

    const unsafeDomain =
      "https://domain-user:domain-secret@example.clerk.accounts.dev/path?token=query-secret";
    const invalidDomainError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PASSKEY_RP_DOMAINS: unsafeDomain,
    });
    assert.instanceOf(invalidDomainError, InvalidMacPasskeyRpDomainError);
    assert.equal(invalidDomainError.reason, "scheme-not-allowed");
    assert.equal(invalidDomainError.inputLength, unsafeDomain.length);
    assert.equal(invalidDomainError.message, "Invalid passkey RP domain (scheme-not-allowed).");
    assert.notProperty(invalidDomainError, "domain");
    assert.notProperty(invalidDomainError, "cause");
    const serializedInvalidDomainError = JSON.stringify(invalidDomainError);
    assert.notInclude(serializedInvalidDomainError, unsafeDomain);
    assert.notInclude(serializedInvalidDomainError, "domain-user");
    assert.notInclude(serializedInvalidDomainError, "domain-secret");
    assert.notInclude(serializedInvalidDomainError, "query-secret");
    assert.throws(
      () =>
        resolveMacPasskeySigningConfiguration({
          T3CODE_APPLE_TEAM_ID: "ABC1234567",
          T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
          T3CODE_CLERK_PASSKEY_RP_DOMAINS: "example.clerk.accounts.dev:8443",
        }),
      /Invalid passkey RP domain/u,
    );
    const invalidPublishableKeyError = captureError({
      T3CODE_APPLE_TEAM_ID: "ABC1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_%",
    });
    assert.instanceOf(invalidPublishableKeyError, InvalidMacPasskeyPublishableKeyError);
    assert.ok(invalidPublishableKeyError.cause);
    assert.equal(invalidPublishableKeyError.message, "T3CODE_CLERK_PUBLISHABLE_KEY is invalid.");
    assert.notProperty(invalidPublishableKeyError, "publishableKey");
    assert.notInclude(invalidPublishableKeyError.message, "pk_test_%");
  });

  it("preserves known passkey signing configuration errors at the build boundary", () => {
    const decodingCause = new Error("publishable-key-decode-failed");
    const knownError = new InvalidMacPasskeyPublishableKeyError({ cause: decodingCause });
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(knownError);

    assert.strictEqual(error, knownError);
    assert.instanceOf(error, InvalidMacPasskeyPublishableKeyError);
    assert.strictEqual(error.cause, decodingCause);
    assert.isTrue(isMacPasskeySigningConfigurationError(error));
  });

  it("wraps unknown passkey signing configuration defects without copying cause text", () => {
    const secret = "pk_test_do-not-retain";
    const cause = new Error(secret);
    const error = MacPasskeySigningConfigurationResolutionError.fromCause(cause);

    assert.instanceOf(error, MacPasskeySigningConfigurationResolutionError);
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message, "Failed to resolve macOS passkey signing configuration.");
    assert.notInclude(error.message, secret);
  });

  it.effect("adds passkey entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        true,
        false,
        undefined,
        {
          entitlementsPath: "/tmp/entitlements.mac.plist",
          provisioningProfilePath: "/tmp/t3code.provisionprofile",
        },
        "x64",
      );

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "com.abstergo.jarvis");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.provisioningProfile, "/tmp/t3code.provisionprofile");
      assert.deepStrictEqual(mac.protocols, [
        { name: "Jarvis", schemes: ["jarvis", "jarvis-dev"] },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("adds base Electron and microphone entitlements without enabling passkeys", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        true,
        false,
        undefined,
        {
          entitlementsPath: "/tmp/entitlements.mac.plist",
        },
        "x64",
      );

      const mac = config.mac as Record<string, unknown>;
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.notProperty(mac, "provisioningProfile");
      const entitlements = renderMacEntitlements();
      assert.include(entitlements, "com.apple.security.device.audio-input");
      assert.notInclude(entitlements, "com.apple.developer.associated-domains");
      assert.notInclude(entitlements, "webcredentials:");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("uses the nightly DMG background for nightly macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3-nightly.20260815.1",
        false,
        false,
        undefined,
        undefined,
        "x64",
      );

      assert.equal(
        (config.dmg as Record<string, unknown>).background,
        "dmg/dmg-background-nightly.png",
      );
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("keeps executable resource editing enabled for unsigned Windows builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        "x64",
      );

      const win = config.win as Record<string, unknown>;
      assert.equal(win.icon, "icon.ico");
      assert.equal(win.signAndEditExecutable, true);
      assert.notProperty(win, "azureSignOptions");
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it("stages the resource monitor as an external executable resource", () => {
    assert.deepStrictEqual(DESKTOP_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/resource-monitor",
        to: "resource-monitor",
      },
      {
        from: "apps/desktop/resources/jarvis-official-release.json",
        to: "jarvis-official-release.json",
      },
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("mac", "universal"), [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("linux", "x64"), [
      "x86_64-unknown-linux-gnu",
    ]);
    assert.deepStrictEqual(resolveResourceMonitorRustTargets("win", "arm64"), [
      "aarch64-pc-windows-msvc",
    ]);
    assert.equal(resourceMonitorExecutableName("mac"), "t3-resource-monitor");
    assert.equal(resourceMonitorExecutableName("win"), "t3-resource-monitor.exe");
  });

  it("keeps Linux Full builds coupled to native voice resources, not Companion", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/jarvis-desktop-linux.yml", import.meta.url),
      "utf8",
    );
    assert.include(workflow, "prepare:voice");
    assert.include(workflow, "--voice-resources-dir packages/jarvis-native-voice/resources");
    assert.notInclude(workflow, "--companion-dir");
    assert.notInclude(workflow, "companion_root=");
    assert.include(workflow, 'voice_root="$extract_root/squashfs-root/resources/jarvis-resources"');
    assert.include(workflow, '"$voice_root/parakeet"');
    assert.include(workflow, '"$voice_root/pocket"');
    assert.include(workflow, "desktopVoiceWorker.cjs");
    assert.include(workflow, "pocket-worker.cjs");
    assert.include(workflow, "THIRD_PARTY_NOTICES.md");
    assert.include(workflow, 'require("./scripts/node_modules/@electron/asar")');
    assert.notInclude(workflow, 'require("@electron/asar")');
    assert.include(workflow, 'ELECTRON_RUN_AS_NODE: "1"');
    assert.include(workflow, "JARVIS_VOICE_ROOT: voiceRoot");
    assert.include(workflow, 'send("smoke-prepare", "prepare")');
    assert.include(workflow, 'send("smoke-shutdown", "shutdown")');
    assert.include(workflow, "Packaged voice worker smoke timed out");
    assert.include(workflow, 'phase !== "stopped" || code !== 0');
  });

  it("keeps the manual Linux Full build explicit about native voice resources", () => {
    const packageJson = JSON.parse(
      NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const command = packageJson.scripts?.["dist:desktop:linux"];

    assert.isString(command);
    assert.include(command, "vp run --filter @t3tools/jarvis-native-voice prepare:voice");
    assert.include(command, "--voice-resources-dir packages/jarvis-native-voice/resources");
  });

  it("keeps Windows Desktop voice resources in the shared Desktop payload", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/jarvis-setup-windows.yml", import.meta.url),
      "utf8",
    );
    assert.include(workflow, "Prepare shared native voice resources for Windows Desktop");
    assert.include(workflow, "prepare:voice");
    assert.include(workflow, "'--voice-resources-dir', $env:JARVIS_VOICE_RESOURCES");
    assert.notInclude(workflow, "JARVIS_COMPANION_PAYLOAD");
    assert.notInclude(workflow, "--companion-dir");
  });

  it("keeps a packaged GUI smoke on the Linux AppImage wrapper", () => {
    const workflow = NodeFS.readFileSync(
      new URL("../.github/workflows/jarvis-desktop-linux.yml", import.meta.url),
      "utf8",
    );
    assert.include(workflow, "Smoke Linux AppImage GUI startup");
    assert.include(
      workflow,
      "apt-get install -y dbus-x11 gnome-keyring inotify-tools libsecret-1-0 libasound2-dev libx11-dev libxrandr-dev libxtst-dev libxt-dev openbox x11-utils xvfb imagemagick",
    );
    assert.include(workflow, "dbus-run-session --");
    assert.include(workflow, "setsid");
    assert.include(workflow, 'x_display=":99"');
    assert.include(workflow, 'x_socket="/tmp/.X11-unix/X${x_display#:}"');
    assert.include(workflow, 'xvfb_log="$RUNNER_TEMP/jarvis-xvfb.log"');
    assert.include(workflow, 'openbox_log="$RUNNER_TEMP/jarvis-openbox.log"');
    assert.include(workflow, 'chmod 700 "$smoke_root/xdg-runtime"');
    assert.include(workflow, "sudo install -d -m 1777 /tmp/.X11-unix");
    assert.include(workflow, "Refusing to reuse an existing X11 socket");
    assert.include(workflow, 'setsid Xvfb "$x_display" -screen 0 1280x800x24 -nolisten tcp');
    assert.include(workflow, "openbox");
    assert.include(workflow, "x11-utils");
    assert.include(workflow, "_NET_SUPPORTING_WM_CHECK");
    assert.notInclude(workflow, "WAYLAND");
    assert.notInclude(workflow, "--headless");
    assert.include(workflow, "inotifywait -q -e create,moved_to");
    assert.include(workflow, 'smoke_root="$RUNNER_TEMP/jarvis-gui-smoke-home"');
    assert.include(
      workflow,
      'mkdir -p "$smoke_root/t3-home" "$smoke_root/xdg-config" "$smoke_root/xdg-data" "$smoke_root/xdg-cache"',
    );
    assert.include(
      workflow,
      'T3CODE_HOME="$smoke_root/t3-home" XDG_CONFIG_HOME="$smoke_root/xdg-config"',
    );
    assert.include(
      workflow,
      'XDG_DATA_HOME="$smoke_root/xdg-data" XDG_CACHE_HOME="$smoke_root/xdg-cache"',
    );
    assert.include(workflow, 'appimage="$GITHUB_WORKSPACE/$artifact"');
    assert.include(workflow, "APPIMAGE_EXTRACT_AND_RUN=1");
    assert.include(
      workflow,
      '"$appimage" --ozone-platform=x11 --no-sandbox --disable-gpu --password-store=basic --jarvis-startup-probe="$probe_file"',
    );
    assert.notInclude(workflow, '"$app" --ozone-platform=x11 --no-sandbox');
    assert.include(workflow, "ELECTRON_ENABLE_LOGGING=1");
    assert.include(workflow, "JARVIS_STARTUP_PROBE_FILE");
    assert.include(workflow, "inotifywait");
    const startupGate = workflow.slice(
      workflow.indexOf("# Arm the watcher before launching the app."),
    );
    const watcherArm = startupGate.indexOf(
      'timeout --signal=TERM 45 inotifywait -q -e moved_to "$probe_dir"',
    );
    assert.isAtLeast(watcherArm, 0);
    assert.isAbove(
      startupGate.indexOf("setsid --wait dbus-run-session -- env", watcherArm),
      watcherArm,
    );
    assert.include(startupGate, ">/dev/null 2>&1 &");
    assert.include(startupGate, 'if [[ ! -s "$probe_file" ]]; then');
    assert.include(startupGate, "wait_status == 124");
    assert.include(startupGate, "watcher woke for an unrelated event");
    assert.notInclude(startupGate, "close_write");
    assert.notInclude(startupGate, "--include");
    assert.notInclude(startupGate, "grep -qx");
    assert.include(workflow, "wait -n");
    assert.include(workflow, "watcher_pid");
    assert.include(workflow, 'kill -TERM -- "-$app_pid"');
    assert.include(workflow, 'kill -TERM -- "-$xvfb_pid"');
    assert.include(workflow, 'kill -TERM -- "-$openbox_pid"');
    assert.include(workflow, 'tail -n 200 "$xvfb_log" >&2 || true');
    assert.include(workflow, 'tail -n 200 "$openbox_log" >&2 || true');
    assert.include(workflow, 'find "$probe_dir" -maxdepth 1 -mindepth 1 -printf');
    assert.include(workflow, 'stat -- "$probe_dir" "$probe_file" >&2 || true');
    assert.include(workflow, 'head -c 4096 "$probe_file" >&2 || true');
    assert.include(workflow, "Packaged GUI smoke diagnostics; startup probe directory listing:");
    assert.include(workflow, "Packaged GUI smoke diagnostics; startup probe stat:");
    assert.include(workflow, "Packaged GUI smoke diagnostics; startup probe content:");
    assert.include(workflow, "xwininfo -root -tree");
    assert.include(workflow, "Packaged GUI smoke diagnostics; X window tree:");
    assert.include(workflow, "--no-sandbox");
    assert.include(workflow, "main-window-revealed");
    assert.include(workflow, "renderer mount and window reveal");
    assert.include(workflow, "DesktopClerkBridgeInitializationError");
    assert.include(workflow, "registerSchemesAsPrivileged");
  });

  it("keeps staged package metadata outside the repository", () => {
    const source = NodeFS.readFileSync(
      new URL("./build-desktop-artifact.ts", import.meta.url),
      "utf8",
    );
    assert.include(source, "fs.makeTempDirectory : fs.makeTempDirectoryScoped");
    assert.include(source, "prefix: `t3code-desktop-${options.platform}-stage-`");
    assert.include(source, 'const stageAppDir = path.join(stageRoot, "app")');
    assert.notInclude(source, 'path.join(repoRoot, "package.json")');
    assert.notInclude(source, 'path.join(repoRoot, "main.cjs")');
  });

  it.effect("rejects a stage rooted in the repository", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.throws(() =>
        assertDesktopArtifactStageIsolated({
          repoRoot: "/repo",
          stageRoot: "/repo/stage",
          path,
        }),
      );
      assert.doesNotThrow(() =>
        assertDesktopArtifactStageIsolated({
          repoRoot: "/repo",
          stageRoot: "/tmp/stage",
          path,
        }),
      );
    }),
  );

  it("allows a Windows stage on a different volume", () => {
    const windowsPath: Pick<Path.Path, "isAbsolute" | "relative" | "resolve"> = {
      isAbsolute: (value) => /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\"),
      relative: () => "C:\\runner-temp\\stage",
      resolve: (value) => value,
    };
    assert.doesNotThrow(() =>
      assertDesktopArtifactStageIsolated({
        repoRoot: "D:\\a\\Jarvis",
        stageRoot: "C:\\runner-temp\\stage",
        path: windowsPath,
      }),
    );
  });

  it("stages only target-platform native voice dependencies", () => {
    assert.isFalse("total" in WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS);
    assert.equal(WINDOWS_PACKAGED_PAYLOAD_BYTE_BUDGETS.voiceResources, 448 * 1024 * 1024);
    assert.deepStrictEqual(resolveJarvisNativeVoiceDependencies("linux", "x64", {}), {
      "node-cpal": NODE_CPAL_VERSION,
      "sherpa-onnx-linux-x64": "1.13.6",
      "sherpa-onnx-node": "1.13.6",
    });
    assert.deepStrictEqual(resolveJarvisNativeVoiceDependencies("win", "x64", {}), {
      "node-cpal": NODE_CPAL_VERSION,
      "sherpa-onnx-node": "1.13.6",
      "sherpa-onnx-win-x64": "1.13.6",
    });
    assert.deepStrictEqual(resolveJarvisNativeVoiceDependencies("linux", "arm64", {}), {});
    assert.deepStrictEqual(resolveJarvisNativeVoiceDependencies("mac", "x64", {}), {
      "sherpa-onnx-darwin-x64": "1.13.6",
      "sherpa-onnx-node": "1.13.6",
    });
    assert.deepStrictEqual(resolveJarvisNativeVoiceDependencies("mac", "arm64", {}), {
      "sherpa-onnx-darwin-arm64": "1.13.6",
      "sherpa-onnx-node": "1.13.6",
    });
    assert.deepStrictEqual(resolveJarvisNativeVoiceDependencies("mac", "universal", {}), {
      "sherpa-onnx-darwin-arm64": "1.13.6",
      "sherpa-onnx-darwin-x64": "1.13.6",
      "sherpa-onnx-node": "1.13.6",
    });
    assert.equal(nodeCpalTargetDirectory("linux", "x64"), "linux-x64");
    assert.equal(nodeCpalTargetDirectory("win", "x64"), "win32-x64");
    assert.equal(nodeCpalTargetDirectory("mac", "x64"), undefined);
    assert.equal(uiohookTargetDirectory("linux", "x64"), "linux-x64");
    assert.equal(uiohookTargetDirectory("win", "x64"), "win32-x64");
    assert.equal(uiohookTargetDirectory("mac", "x64"), undefined);
    assert.include(
      uiohookFileExclusions("linux", "x64"),
      "!**/node_modules/uiohook-napi/prebuilds/win32-x64/**",
    );
    assert.include(
      nodeCpalFileExclusions("linux", "arm64"),
      "!**/node_modules/node-cpal/bin/linux-x64/**",
    );
    assert.include(
      uiohookFileExclusions("win", "arm64"),
      "!**/node_modules/uiohook-napi/prebuilds/win32-x64/**",
    );
    assert.deepStrictEqual(NODE_CPAL_PLATFORM_BINARIES, [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    assert.deepStrictEqual(nodeCpalFileExclusions("linux", "x64"), [
      "!**/node_modules/node-cpal/bin/darwin-arm64",
      "!**/node_modules/node-cpal/bin/darwin-arm64/**",
      "!**/node_modules/node-cpal/bin/darwin-x64",
      "!**/node_modules/node-cpal/bin/darwin-x64/**",
      "!**/node_modules/node-cpal/bin/linux-arm64",
      "!**/node_modules/node-cpal/bin/linux-arm64/**",
      "!**/node_modules/node-cpal/bin/win32-x64",
      "!**/node_modules/node-cpal/bin/win32-x64/**",
    ]);
    assert.equal(JARVIS_VOICE_RESOURCE_DESTINATION_DIR, "jarvis-resources");
    assert.deepStrictEqual(JARVIS_NATIVE_VOICE_WORKER_FILES, [
      "desktopVoiceWorker.cjs",
      "pocket-worker.cjs",
    ]);
  });
  it("promotes target fff binaries to direct staged dependencies", () => {
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("mac", "universal", "0.9.4"), {
      "@ff-labs/fff-bin-darwin-arm64": "0.9.4",
      "@ff-labs/fff-bin-darwin-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("win", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-win32-x64": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "x64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-x64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-x64-musl": "0.9.4",
    });
    assert.deepStrictEqual(resolveFffNativeDependencies("linux", "arm64", "0.9.4"), {
      "@ff-labs/fff-bin-linux-arm64-gnu": "0.9.4",
      "@ff-labs/fff-bin-linux-arm64-musl": "0.9.4",
    });
  });

  it("resolves target Clerk passkey native artifacts", () => {
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("mac", "universal"), [
      {
        packageName: "@clerk/electron-passkeys-darwin-arm64",
        binaryFileName: "electron-passkeys.darwin-arm64.node",
      },
      {
        packageName: "@clerk/electron-passkeys-darwin-x64",
        binaryFileName: "electron-passkeys.darwin-x64.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("win", "x64"), [
      {
        packageName: "@clerk/electron-passkeys-win32-x64-msvc",
        binaryFileName: "electron-passkeys.win32-x64-msvc.node",
      },
    ]);
    assert.deepStrictEqual(resolveClerkPasskeyNativeArtifacts("linux", "x64"), []);
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
  });

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
    }),
  );

  it.effect("rejects universal builds on Linux and Windows before staging binaries", () =>
    Effect.gen(function* () {
      for (const platform of ["linux", "win"] as const) {
        const error = yield* Effect.flip(
          resolveBuildOptions({
            platform: Option.some(platform),
            target: Option.none(),
            arch: Option.some("universal"),
            buildVersion: Option.none(),
            outputDir: Option.none(),
            skipBuild: Option.none(),
            keepStage: Option.none(),
            signed: Option.none(),
            verbose: Option.none(),
            mockUpdates: Option.none(),
            mockUpdateServerPort: Option.none(),
            wslPrebuild: Option.none(),
          }),
        );

        assert.instanceOf(error, UnsupportedDesktopBuildArchitectureError);
        assert.deepStrictEqual(error.supportedArchitectures, ["x64", "arm64"]);
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});

// The self-containment check runs the packaged tree in a scratch directory. Its
// own node_modules holds the sidecar externals and must be ignored, but any
// node_modules *above* it would let Node's parent walk satisfy an import that is
// missing from the package, so the probe refuses to run in that case.
it("lists ancestor node_modules, nearest first, excluding the start directory", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"), [
    "C:\\tmp\\probe\\node_modules",
    "C:\\tmp\\node_modules",
    "C:\\node_modules",
  ]);
});

it("includes the filesystem root for posix paths", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("/tmp/probe", "/"), [
    "/tmp/node_modules",
    "/node_modules",
  ]);
});

// A UNC root must keep its \\server\share prefix. Rebuilding it from segments
// produced relative paths, which fs.exists resolves against the build cwd, so
// the guard checked directories that do not exist and silently passed.
it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("ignores trailing separators", () => {
  assert.deepStrictEqual(
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app\\", "\\"),
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
  );
});
