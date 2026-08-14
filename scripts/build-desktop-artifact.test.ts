import * as NodeServices from "@effect/platform-node/NodeServices";
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
  createStageWorkspaceConfig,
  createStagePatchedDependencies,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_EXTRA_RESOURCES,
  InvalidMacPasskeyRpDomainError,
  InvalidMacPasskeyPublishableKeyError,
  InvalidMockUpdateServerPortError,
  UnsupportedDesktopBuildArchitectureError,
  isMacPasskeySigningConfigurationError,
  LinuxIconResizeError,
  MacPasskeySigningConfigurationResolutionError,
  MissingMacPasskeyProvisioningProfileError,
  packWindowsServerAsar,
  renderMacPasskeyEntitlements,
  resolveClerkPasskeyNativeArtifacts,
  resolveMacPasskeySigningConfiguration,
  resolveDesktopRuntimeDependencies,
  resolveFffNativeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveResourceMonitorRustTargets,
  resourceMonitorExecutableName,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolvePackageManagerUserAgent,
  stageLinuxIconSize,
  STAGE_INSTALL_ARGS,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  validateWindowsPackagedPayload,
  WindowsPrimaryNativeProbeError,
  WindowsPackagedPayloadValidationError,
  WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_ASAR_RESOURCE,
  WINDOWS_SERVER_ASAR_UNPACK_GLOB,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
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

const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(function* (input: {
  readonly copyUnpackedNatives: boolean;
  readonly serverEntrySource?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({
    prefix: "t3-windows-payload-test-",
  });
  const sourceDir = path.join(tempDir, "server-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");
  yield* fs.writeFileString(nativePath, "native-binary");

  const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
  yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath });

  const stageDistDir = path.join(tempDir, "dist");
  const packagedAppDir = path.join(stageDistDir, "win-unpacked");
  const resourcesDir = path.join(packagedAppDir, "resources");
  yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
  yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
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
  const appExecutableName = "t3code.exe";
  yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
  yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

  return {
    stageDistDir,
    packagedAppDir,
    sourceDir,
    generatedAsarPath,
    appExecutableName,
  } as const;
});

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "T3 Code (Alpha)");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "T3 Code (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches the bundled splash and favicon branding for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
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

  it("limits Electron locales and excludes the unused Claude SDK executable", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
      "!apps/desktop/prod-resources/windows-server",
      "!apps/desktop/prod-resources/windows-server/**/*",
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
      );
      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );
      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      // All platforms keep app.asar fully packed; Windows ships the server
      // tree as the hand-packed server.asar sidecar in extraResources instead
      // of unpacking thousands of loose files at install time.
      assert.notProperty(mac, "asarUnpack");
      assert.notProperty(linux, "asarUnpack");
      assert.notProperty(win, "asarUnpack");
      assert.deepStrictEqual(win.extraResources, [
        {
          from: "apps/desktop/prod-resources/resource-monitor",
          to: "resource-monitor",
        },
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
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
      // Linux must register the renderer schemes so the generated .desktop
      // entry advertises MimeType=x-scheme-handler/t3code; for OAuth deep links.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
      ]);
      for (const config of [mac, linux, win]) {
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
        assert.deepStrictEqual(config.files, DESKTOP_FILE_EXCLUSIONS);
      }
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
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
        });
        const [firstAsar, secondAsar] = yield* Effect.all([
          fs.readFile(fixture.generatedAsarPath),
          fs.readFile(secondAsarPath),
        ]);

        assert.equal(result.packagedAppDir, fixture.packagedAppDir);
        assert.deepStrictEqual(result.unpackedFiles, ["node_modules/native/addon.node"]);
        assert.isBelow(result.fileCount, WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT);
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
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
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

  it.effect("rejects a cross-architecture Windows payload without its primary executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
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

  it.effect("rejects a Windows payload that regresses above the file-count budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeWindowsPayloadFixture({ copyUnpackedNatives: true });
        const error = yield* validateWindowsPackagedPayload({
          stageDistDir: fixture.stageDistDir,
          appExecutableName: fixture.appExecutableName,
          targetArch: "x64",
          fileLimit: 2,
        }).pipe(Effect.flip);

        assert.instanceOf(error, WindowsPackagedPayloadValidationError);
        assert.equal(error.reason, "file-limit-exceeded");
        assert.isAbove(error.fileCount ?? 0, 2);
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

  it("derives macOS passkey signing configuration from the Clerk publishable key", () => {
    const configuration = resolveMacPasskeySigningConfiguration({
      T3CODE_APPLE_TEAM_ID: "abc1234567",
      T3CODE_MACOS_PROVISIONING_PROFILE: "/tmp/t3code.provisionprofile",
      T3CODE_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("example.clerk.accounts.dev$")}`,
    });

    assert.deepStrictEqual(configuration, {
      appId: "com.t3tools.t3code",
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
    assert.include(entitlements, "<string>ABC1234567.com.t3tools.t3code</string>");
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
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
        provisioningProfilePath: "/tmp/t3code.provisionprofile",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "com.t3tools.t3code");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.provisioningProfile, "/tmp/t3code.provisionprofile");
      assert.deepStrictEqual(mac.protocols, [
        { name: "T3 Code", schemes: ["t3code", "t3code-dev"] },
      ]);
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
