import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

const PersistedServerObservabilitySettingsDocument = Schema.Struct({
  observability: Schema.Struct({
    otlpTracesUrl: Schema.String,
    otlpMetricsUrl: Schema.String,
  }),
});

const encodePersistedServerObservabilitySettingsDocument = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerObservabilitySettingsDocument),
);

const isDesktopBackendObservabilitySettingsReadError = Schema.is(
  DesktopBackendConfiguration.DesktopBackendObservabilitySettingsReadError,
);

const serverExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    tailscaleServeEnabled: true,
    tailscaleServePort: 8443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

function makeEnvironmentLayer(
  baseDir: string,
  options?: {
    readonly appPath?: string;
    readonly dirname?: string;
    readonly isPackaged?: boolean;
    readonly devServerUrl?: string;
    readonly platform?: NodeJS.Platform;
    readonly resourcesPath?: string;
    readonly appVersion?: string;
    readonly processArch?: NodeJS.Architecture;
  },
) {
  return DesktopEnvironment.layer({
    dirname: options?.dirname ?? "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: options?.platform ?? "darwin",
    processArch: options?.processArch ?? "x64",
    appVersion: options?.appVersion ?? "1.2.3",
    appPath: options?.appPath ?? "/repo",
    isPackaged: options?.isPackaged ?? true,
    resourcesPath: options?.resourcesPath ?? "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
          T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
        }),
      ),
    ),
  );
}

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

const withHarness = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        DesktopBackendConfiguration.layer.pipe(
          Layer.provideMerge(serverExposureLayer),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(DesktopWslEnvironment.layerTest()),
          Layer.provideMerge(DesktopWslServerTree.layerTest()),
          Layer.provideMerge(makeEnvironmentLayer(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopBackendConfiguration", () => {
  it("accepts only normalized SHA-256 archive identities", () => {
    assert.equal(
      DesktopBackendConfiguration.parseWslRuntimeArchiveHash(`  ${"A".repeat(64)}\n`),
      "a".repeat(64),
    );
    assert.isNull(DesktopBackendConfiguration.parseWslRuntimeArchiveHash("abc123"));
  });

  it.effect("resolvePrimary produces a stable scoped bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const first = yield* configuration.resolvePrimary;
        const second = yield* configuration.resolvePrimary;

        assert.equal(first.executablePath, process.execPath);
        assert.equal(first.entryPath, environment.backendEntryPath);
        assert.equal(first.cwd, environment.backendCwd);
        assert.equal(first.captureOutput, true);
        assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
        assert.isUndefined(first.env.T3CODE_PORT);
        assert.isUndefined(first.env.T3CODE_MODE);
        assert.isUndefined(first.env.T3CODE_DESKTOP_LAN_HOST);

        assert.equal(first.bootstrap.mode, "desktop");
        assert.equal(first.bootstrap.noBrowser, true);
        assert.equal(first.bootstrap.port, 4888);
        assert.equal(first.bootstrap.host, "0.0.0.0");
        assert.equal(first.bootstrap.t3Home, environment.baseDir);
        assert.equal(first.bootstrap.tailscaleServeEnabled, true);
        assert.equal(first.bootstrap.tailscaleServePort, 8443);
        assert.match(first.bootstrap.desktopBootstrapToken, /^[0-9a-f]{48}$/i);
        assert.equal(second.bootstrap.desktopBootstrapToken, first.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolvePrimary starts from server.asar without materializing the WSL tree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const resourcesPath = path.join(baseDir, "resources");

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              Layer.succeed(
                DesktopWslServerTree.DesktopWslServerTree,
                DesktopWslServerTree.DesktopWslServerTree.of({
                  ensure: Effect.die("Windows primary must not extract the WSL server tree"),
                }),
              ),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: `${resourcesPath}/app.asar`,
                platform: "win32",
                resourcesPath,
              }),
            ),
          ),
        ),
      );

      assert.equal(
        config.entryPath,
        path.join(resourcesPath, "server.asar/apps/server/dist/bin.mjs"),
      );
      assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl reuses the primary's bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const primary = yield* configuration.resolvePrimary;
        const wsl = yield* configuration.resolveWsl({ port: 5000, distro: null });

        assert.equal(wsl.bootstrap.desktopBootstrapToken, primary.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolveWsl pins a default-tracking run to the concrete default distro", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const entryPath = path.join(baseDir, "apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");

      const observedDistros: Array<string | null> = [];
      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolveWsl({ port: 5000, distro: null });
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [
                  { name: "Debian", isDefault: false, version: 2 },
                  { name: "Ubuntu", isDefault: true, version: 2 },
                ],
                windowsToWslPath: (distro) => {
                  observedDistros.push(distro);
                  return Option.some("/repo");
                },
                ensureNodePty: (distro) => {
                  observedDistros.push(distro);
                  return { ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin:/bin" };
                },
                getDistroIp: (distro) => {
                  observedDistros.push(distro);
                  return Option.some("172.27.0.99");
                },
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      assert.equal(config.runningDistro, "Ubuntu");
      assert.deepEqual(config.args.slice(0, 2), ["-d", "Ubuntu"]);
      assert.deepEqual(observedDistros, ["Ubuntu", "Ubuntu", "Ubuntu"]);
      assert.isTrue(Option.isNone(config.preflightFailure));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl launches a packaged backend from the WSL-local runtime cache", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const archiveHash = "a".repeat(64);
      yield* fileSystem.writeFileString(archivePath, "archive");
      yield* fileSystem.writeFileString(`${archivePath}.sha256`, `${archiveHash}\n`);
      const contentId = "1".repeat(64);
      yield* fileSystem.writeFileString(`${archivePath}.content-id`, `${contentId}\n`);

      const observedArchives: Array<{
        windowsArchivePath: string;
        runtimeId: string;
        sha256: string;
      }> = [];
      const observedNodePtyRoots: string[] = [];
      const linuxAppRoot = "/home/test/.t3/runtime/1.2.3-x64";
      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              Layer.succeed(
                DesktopWslServerTree.DesktopWslServerTree,
                DesktopWslServerTree.DesktopWslServerTree.of({
                  ensure: Effect.die("A valid WSL archive must not extract the Windows fallback"),
                }),
              ),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some("/mnt/c/app.asar.unpacked"),
                prepareRuntime: (_distro, archive) => {
                  observedArchives.push({
                    windowsArchivePath: archive.windowsPath,
                    runtimeId: archive.runtimeId,
                    sha256: archive.sha256,
                  });
                  return { ok: true, linuxAppRoot };
                },
                ensureNodePty: (_distro, root) => {
                  observedNodePtyRoots.push(root);
                  return { ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin:/bin" };
                },
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      assert.deepEqual(observedArchives, [
        {
          windowsArchivePath: archivePath,
          runtimeId: `sha256-${contentId}`,
          sha256: archiveHash,
        },
      ]);
      assert.deepEqual(observedNodePtyRoots, [linuxAppRoot]);
      assert.equal(config.entryPath, path.join(baseDir, "server.asar/apps/server/dist/bin.mjs"));
      assert.include(config.args, `${linuxAppRoot}/apps/server/dist/bin.mjs`);
      assert.equal(config.wslRuntimeId, `sha256-${contentId}`);
      assert.isTrue(Option.isNone(config.preflightFailure));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // The point of keying on content alone: shipping a new desktop release whose
  // server payload did not change must land on the directory the previous
  // release already installed, instead of extracting an identical tree under a
  // new name and leaving the old one to be pruned.
  it.effect("resolveWsl reuses one cache id across app versions with the same runtime", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const contentId = "a".repeat(64);
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");
      yield* fileSystem.writeFileString(archivePath, "archive");
      yield* fileSystem.writeFileString(`${archivePath}.sha256`, `${"b".repeat(64)}\n`);
      yield* fileSystem.writeFileString(`${archivePath}.content-id`, `${contentId}\n`);

      const resolveForAppVersion = (appVersion: string) =>
        Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(
                DesktopWslServerTree.layerTest({
                  result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
                }),
              ),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                  windowsToWslPath: () => Option.some("/mnt/c/app.asar.unpacked"),
                  prepareRuntime: (_distro, archive) => ({
                    ok: true,
                    linuxAppRoot: `/home/test/.t3/runtime/${archive.runtimeId}`,
                  }),
                  ensureNodePty: () => ({
                    ok: true,
                    nodePath: "/usr/bin/node",
                    resolvedPath: "/usr/bin:/bin",
                  }),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(
                makeEnvironmentLayer(baseDir, {
                  appPath: baseDir,
                  platform: "win32",
                  resourcesPath: baseDir,
                  appVersion,
                }),
              ),
            ),
          ),
        );

      const older = yield* resolveForAppVersion("1.2.3");
      const newer = yield* resolveForAppVersion("9.9.9");

      assert.equal(older.wslRuntimeId, `sha256-${contentId}`);
      assert.equal(newer.wslRuntimeId, older.wslRuntimeId);
      // Same directory, so the upgrade launches from the runtime that is
      // already on disk rather than paying for a cold install.
      assert.include(
        newer.args,
        `/home/test/.t3/runtime/sha256-${contentId}/apps/server/dist/bin.mjs`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl reinstalls under a new cache id when the runtime content changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const hashPath = `${archivePath}.sha256`;
      const contentIdPath = `${archivePath}.content-id`;
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      const firstContentId = "a".repeat(64);
      const secondContentId = "b".repeat(64);
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");
      yield* fileSystem.writeFileString(archivePath, "archive");
      // The archive digest stays put across both resolves: it gates the
      // install, but it is the content id that names the cache directory.
      yield* fileSystem.writeFileString(hashPath, "c".repeat(64));
      yield* fileSystem.writeFileString(contentIdPath, firstContentId);

      const observedRuntimeIds: string[] = [];
      const [first, second, invalidIdentity] = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const first = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        yield* fileSystem.writeFileString(contentIdPath, secondContentId);
        const second = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        yield* fileSystem.writeFileString(contentIdPath, "not-a-sha256");
        const invalidIdentity = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        return [first, second, invalidIdentity] as const;
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
              }),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some("/mnt/c/app.asar.unpacked"),
                prepareRuntime: (_distro, archive) => {
                  observedRuntimeIds.push(archive.runtimeId);
                  return { ok: true, linuxAppRoot: `/runtime/${archive.runtimeId}` };
                },
                ensureNodePty: () => ({
                  ok: true,
                  nodePath: "/usr/bin/node",
                  resolvedPath: "/usr/bin:/bin",
                }),
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      // Changed server content is a different runtime, so it installs under its
      // own directory instead of being served from the one already cached.
      assert.deepEqual(observedRuntimeIds, [
        `sha256-${firstContentId}`,
        `sha256-${secondContentId}`,
      ]);
      assert.equal(first.wslRuntimeId, observedRuntimeIds[0]);
      assert.equal(second.wslRuntimeId, observedRuntimeIds[1]);
      assert.isUndefined(invalidIdentity.wslRuntimeId);
      assert.include(invalidIdentity.args, "/mnt/c/app.asar.unpacked/apps/server/dist/bin.mjs");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl falls back to the mounted runtime when archive staging fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const archiveHash = "b".repeat(64);
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");
      yield* fileSystem.writeFileString(archivePath, "corrupt archive");
      yield* fileSystem.writeFileString(`${archivePath}.sha256`, `${archiveHash}\n`);
      const contentId = "2".repeat(64);
      yield* fileSystem.writeFileString(`${archivePath}.content-id`, `${contentId}\n`);

      const mountedAppRoot = "/mnt/c/app.asar.unpacked";
      const observedNodePtyRoots: string[] = [];
      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
              }),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some(mountedAppRoot),
                prepareRuntime: () => ({ ok: false, reason: "archive is corrupt" }),
                ensureNodePty: (_distro, root) => {
                  observedNodePtyRoots.push(root);
                  return { ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin:/bin" };
                },
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      assert.deepEqual(observedNodePtyRoots, [mountedAppRoot]);
      assert.equal(config.entryPath, entryPath);
      assert.include(config.args, `${mountedAppRoot}/apps/server/dist/bin.mjs`);
      assert.isUndefined(config.wslRuntimeId);
      assert.isTrue(Option.isNone(config.preflightFailure));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl retires a staged runtime that cannot load node-pty", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const archiveHash = "c".repeat(64);
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");
      yield* fileSystem.writeFileString(archivePath, "archive");
      yield* fileSystem.writeFileString(`${archivePath}.sha256`, `${archiveHash}\n`);
      const contentId = "3".repeat(64);
      yield* fileSystem.writeFileString(`${archivePath}.content-id`, `${contentId}\n`);

      const stagedAppRoot = `/home/test/.t3/runtime/sha256-${contentId}`;
      const mountedAppRoot = "/mnt/c/app.asar.unpacked";
      const observedNodePtyRoots: string[] = [];
      const invalidatedRuntimeIds: string[] = [];
      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
              }),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some(mountedAppRoot),
                prepareRuntime: () => ({ ok: true, linuxAppRoot: stagedAppRoot }),
                invalidateRuntime: (_distro, runtimeId) =>
                  Effect.sync(() => {
                    invalidatedRuntimeIds.push(runtimeId);
                  }),
                // The staged tree passes the install's presence check but its
                // pty.node will not load, which only the probe can detect.
                ensureNodePty: (_distro, root) => {
                  observedNodePtyRoots.push(root);
                  return root === stagedAppRoot
                    ? { ok: false, reason: "pty.node could not be loaded", fatal: true }
                    : { ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin:/bin" };
                },
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      assert.deepEqual(observedNodePtyRoots, [stagedAppRoot, mountedAppRoot]);
      assert.include(config.args, `${mountedAppRoot}/apps/server/dist/bin.mjs`);
      assert.equal(config.entryPath, entryPath);
      assert.isUndefined(config.wslRuntimeId);
      assert.isTrue(Option.isNone(config.preflightFailure));
      // Without this the broken cache stays ready and every later launch
      // repeats the failed probe instead of reinstalling.
      assert.deepEqual(invalidatedRuntimeIds, [`sha256-${contentId}`]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl keeps the staged runtime when the mounted tree fails too", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const archiveHash = "d".repeat(64);
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");
      yield* fileSystem.writeFileString(archivePath, "archive");
      yield* fileSystem.writeFileString(`${archivePath}.sha256`, `${archiveHash}\n`);
      const contentId = "4".repeat(64);
      yield* fileSystem.writeFileString(`${archivePath}.content-id`, `${contentId}\n`);

      const invalidatedRuntimeIds: string[] = [];
      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        // Both copies ship the same prebuilt, so the distro is what is wrong.
        // Reporting the staged verdict keeps the actionable message and leaves
        // the cache alone rather than reinstalling hundreds of MB every launch.
        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "unsupported CPU architecture");
        assert.deepEqual(invalidatedRuntimeIds, []);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
              }),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some("/mnt/c/app.asar.unpacked"),
                prepareRuntime: () => ({ ok: true, linuxAppRoot: "/home/test/.t3/runtime/cache" }),
                invalidateRuntime: (_distro, runtimeId) =>
                  Effect.sync(() => {
                    invalidatedRuntimeIds.push(runtimeId);
                  }),
                ensureNodePty: (_distro, root) => ({
                  ok: false,
                  reason:
                    root === "/home/test/.t3/runtime/cache"
                      ? "unsupported CPU architecture or incompatible system libraries"
                      : "mounted tree is broken in some other way",
                  fatal: true,
                }),
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl keeps WSL retryable when the mounted fallback fails transiently", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const archiveHash = "f".repeat(64);
      const entryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");
      yield* fileSystem.writeFileString(archivePath, "archive");
      yield* fileSystem.writeFileString(`${archivePath}.sha256`, `${archiveHash}\n`);
      const contentId = "5".repeat(64);
      yield* fileSystem.writeFileString(`${archivePath}.content-id`, `${contentId}\n`);

      const stagedAppRoot = "/home/test/.t3/runtime/cache";
      const invalidatedRuntimeIds: string[] = [];
      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        // The /mnt probe timing out rules nothing out. Reporting the staged
        // fatal verdict here would cap the attempts and persist Windows mode
        // instead of letting the slow mount path answer on a later try.
        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "timed out");
        assert.deepEqual(invalidatedRuntimeIds, []);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
              }),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some("/mnt/c/app.asar.unpacked"),
                prepareRuntime: () => ({ ok: true, linuxAppRoot: stagedAppRoot }),
                invalidateRuntime: (_distro, runtimeId) =>
                  Effect.sync(() => {
                    invalidatedRuntimeIds.push(runtimeId);
                  }),
                ensureNodePty: (_distro, root) =>
                  root === stagedAppRoot
                    ? { ok: false, reason: "pty.node could not be loaded", fatal: true }
                    : {
                        ok: false,
                        reason: "WSL backend preflight timed out while probing for Node.js.",
                        fatal: false,
                      },
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl retries the staged runtime after a transient probe failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
      const archiveHash = "e".repeat(64);
      yield* fileSystem.writeFileString(archivePath, "archive");
      yield* fileSystem.writeFileString(`${archivePath}.sha256`, `${archiveHash}\n`);
      const contentId = "6".repeat(64);
      yield* fileSystem.writeFileString(`${archivePath}.content-id`, `${contentId}\n`);

      const invalidatedRuntimeIds: string[] = [];
      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "timed out");
        assert.deepEqual(invalidatedRuntimeIds, []);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              Layer.succeed(
                DesktopWslServerTree.DesktopWslServerTree,
                DesktopWslServerTree.DesktopWslServerTree.of({
                  // A transport failure says nothing about the staged tree, so
                  // the retry belongs on the cache, not on the mounted copy.
                  ensure: Effect.die("A transient probe failure must not extract the fallback"),
                }),
              ),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                windowsToWslPath: () => Option.some("/mnt/c/app.asar.unpacked"),
                prepareRuntime: () => ({ ok: true, linuxAppRoot: "/home/test/.t3/runtime/cache" }),
                invalidateRuntime: (_distro, runtimeId) =>
                  Effect.sync(() => {
                    invalidatedRuntimeIds.push(runtimeId);
                  }),
                ensureNodePty: () => ({
                  ok: false,
                  reason: "WSL backend preflight timed out while probing for Node.js.",
                  fatal: false,
                  retryLimit: 12,
                }),
                getDistroIp: () => Option.some("172.27.0.99"),
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolveWsl preserves inherited PATH with quote-sensitive values as separate args",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });
        const entryPath = path.join(baseDir, "apps/server/dist/bin.mjs");
        yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fileSystem.writeFileString(entryPath, "");

        const nodePath = "/home/test user's/.nvm/versions/node/v22.0.0/bin/node";
        const linuxAppRoot = "/tmp/t3 code's launch";
        const linuxEntryPath = `${linuxAppRoot}/apps/server/dist/bin.mjs`;
        const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
        const devServerUrl = "http://127.0.0.1:5733/dev%20assets/?label=hello%20world";
        const config = yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                  windowsToWslPath: () => Option.some(linuxAppRoot),
                  ensureNodePty: () => ({ ok: true, nodePath, resolvedPath }),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(
                makeEnvironmentLayer(baseDir, {
                  appPath: baseDir,
                  devServerUrl,
                  isPackaged: true,
                  platform: "win32",
                  resourcesPath: baseDir,
                }),
              ),
            ),
          ),
        );

        assert.equal(config.bootstrapDelivery, "stdin");
        assert.deepEqual(config.args, [
          "-d",
          "Ubuntu",
          "--exec",
          "env",
          "PATH=/home/test user's/.nvm/versions/node/v22.0.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin",
          nodePath,
          linuxEntryPath,
          "--bootstrap-fd",
          "0",
          "--dev-url",
          devServerUrl,
        ]);
        assert.notInclude(config.args, "bash");
        assert.notInclude(config.args, "/bin/sh");
        assert.notInclude(config.args, "-c");
        assert.isTrue(Option.isNone(config.preflightFailure));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimary and resolveWsl share one token under concurrent resolution", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        // Resolve both before any token is cached, concurrently, so the
        // generate step (a yield point) can interleave. The atomic
        // get-or-create must still hand both the same token; a non-atomic
        // Ref would let each generate its own and break the shared-token
        // invariant.
        const [primary, wsl] = yield* Effect.all(
          [configuration.resolvePrimary, configuration.resolveWsl({ port: 5000, distro: null })],
          { concurrency: "unbounded" },
        );

        assert.equal(wsl.bootstrap.desktopBootstrapToken, primary.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolvePrimary surfaces persisted backend observability endpoints", () =>
    withHarness(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        yield* fileSystem.makeDirectory(environment.path.dirname(environment.serverSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
              otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
            },
          }),
        );

        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
      }),
    ),
  );

  it.effect("resolvePrimary omits backend observability endpoints when settings are missing", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;

        assert.isUndefined(config.bootstrap.otlpTracesUrl);
        assert.isUndefined(config.bootstrap.otlpMetricsUrl);
      }),
    ),
  );

  it.effect("logs structured context when persisted observability settings cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const settingsPath = path.join(baseDir, "userdata", "settings.json");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: settingsPath,
      });
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });
      const failingFileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(cause),
        }),
      );

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(DesktopWslEnvironment.layerTest()),
              Layer.provideMerge(makeEnvironmentLayer(baseDir)),
              Layer.provideMerge(failingFileSystemLayer),
            ),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );

      assert.isUndefined(config.bootstrap.otlpTracesUrl);
      assert.isUndefined(config.bootstrap.otlpMetricsUrl);

      const error = messages
        .flatMap((message) => (Array.isArray(message) ? message : [message]))
        .find(isDesktopBackendObservabilitySettingsReadError);
      assert.isDefined(error);
      assert.equal(error.settingsPath, settingsPath);
      assert.equal(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to read persisted backend observability settings at ${settingsPath}.`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimary captures backend output in dev so child logs can be persisted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.captureOutput, true);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                isPackaged: false,
                devServerUrl: "http://127.0.0.1:5733",
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl preserves existing WSLENV entries when forwarding backend secrets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const previousWslEnv = process.env.WSLENV;
      const previousOpenAiKey = process.env.OPENAI_API_KEY;
      const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
      try {
        process.env.WSLENV = "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u";
        process.env.OPENAI_API_KEY = "openai-key";
        process.env.ANTHROPIC_API_KEY = "anthropic-key";

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

          assert.equal(config.executablePath, "wsl.exe");
          assert.equal(config.bootstrap.port, 5050);
          // Binds to 0.0.0.0 inside WSL so the backend is reachable via
          // both wslhost-forwarded localhost and the distro's eth0 IP.
          assert.equal(config.bootstrap.host, "0.0.0.0");
          assert.equal(config.bootstrap.tailscaleServeEnabled, false);
          assert.notProperty(config.bootstrap, "desktopTelemetryFd");
          assert.notProperty(config.bootstrap, "resourceMonitorPath");
          // httpBaseUrl uses the resolved distro IP from the test stub,
          // not localhost — the renderer reaches the backend directly to
          // avoid relying on wslhost forwarding.
          assert.equal(config.httpBaseUrl.href, "http://172.27.0.99:5050/");
          assert.equal(config.env.OPENAI_API_KEY, "openai-key");
          assert.equal(config.env.ANTHROPIC_API_KEY, "anthropic-key");
          // The existing WSLENV is preserved byte-for-byte (note the empty
          // "::" segment survives — WSL ignores it, so we don't normalize
          // it away) and ANTHROPIC_API_KEY is appended. OPENAI_API_KEY is
          // already declared, so it isn't forwarded twice.
          assert.equal(
            config.env.WSLENV,
            "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u:ANTHROPIC_API_KEY",
          );
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      } finally {
        restoreEnv("WSLENV", previousWslEnv);
        restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
        restoreEnv("ANTHROPIC_API_KEY", previousAnthropicKey);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolvePrimary falls back to the Windows primary when wsl-only but WSL is unavailable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        yield* Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolvePrimary;

          // wsl-only is persisted but WSL is unavailable, so the primary must
          // not spawn wsl.exe (which would loop on preflight failures while the
          // Connections backend control is hidden). Resolve the Windows primary.
          assert.equal(config.executablePath, process.execPath);
          assert.equal(config.bootstrap.t3Home, environment.baseDir);
          assert.isTrue(Option.isNone(config.preflightFailure));
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  wslBackendEnabled: true,
                  wslOnly: true,
                }),
              ),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: false })),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolvePrimary marks a removed persisted WSL distro as a fatal preflight failure",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolvePrimary;
          const failure = Option.getOrThrow(config.preflightFailure);

          assert.equal(config.executablePath, "wsl.exe");
          assert.isTrue(failure.fatal);
          assert.include(failure.reason, "Removed-Distro");
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  wslBackendEnabled: true,
                  wslOnly: true,
                  wslDistro: "Removed-Distro",
                }),
              ),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                }),
              ),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl keeps a transient distro-list failure retryable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "timed out");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distroListError: new DesktopWslEnvironment.DesktopWslDistroListError({
                  reason: "wsl.exe --list --verbose timed out",
                }),
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl marks a missing packaged server entry as fatal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "missing server entry");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl surfaces sidecar extraction failures through typed preflight", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "could not be extracted");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: {
                  ok: false,
                  reason: "WSL server files could not be extracted",
                  fatal: false,
                },
              }),
            ),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl marks a missing selected distro as a fatal preflight failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Removed-Distro" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "Removed-Distro");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports the WSL distro when wsl-only and WSL is available", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "WSL (Ubuntu)");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
              }),
            ),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the external packaged resource monitor over the copy inside the asar", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const resourcesPath = path.join(baseDir, "resources");
      const dirname = `${resourcesPath}/app.asar/apps/desktop/dist-electron`;
      const embeddedMonitorPath = `${resourcesPath}/app.asar/apps/desktop/prod-resources/resource-monitor/t3-resource-monitor`;
      const monitorPath = path.join(resourcesPath, "resource-monitor/t3-resource-monitor");
      yield* fileSystem.makeDirectory(
        `${resourcesPath}/app.asar/apps/desktop/prod-resources/resource-monitor`,
        { recursive: true },
      );
      yield* fileSystem.makeDirectory(`${resourcesPath}/resource-monitor`, {
        recursive: true,
      });
      yield* fileSystem.writeFileString(embeddedMonitorPath, "embedded");
      yield* fileSystem.writeFileString(monitorPath, "binary");
      yield* fileSystem.chmod(monitorPath, 0o755);

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.resourceMonitorPath, monitorPath);
        assert.equal(config.bootstrap.desktopTelemetryFd, 4);
        assert.equal(config.bootstrap.desktopTelemetryControlFd, 5);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: `${resourcesPath}/app.asar`,
                dirname,
                isPackaged: true,
                resourcesPath,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the release resource monitor when both development builds exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });
      const dirname = path.join(baseDir, "apps/desktop/src");
      const releaseMonitorPath = path.join(
        baseDir,
        "native/resource-monitor/target/release/t3-resource-monitor",
      );
      const debugMonitorPath = path.join(
        baseDir,
        "native/resource-monitor/target/debug/t3-resource-monitor",
      );
      yield* fileSystem.makeDirectory(path.dirname(releaseMonitorPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(debugMonitorPath), { recursive: true });
      yield* fileSystem.writeFileString(releaseMonitorPath, "release");
      yield* fileSystem.writeFileString(debugMonitorPath, "debug");

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.resourceMonitorPath, releaseMonitorPath);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                dirname,
                devServerUrl: "http://127.0.0.1:5733",
                isPackaged: false,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports the local environment on non-Windows platforms", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Local environment");
      }),
    ),
  );

  it.effect("resolvePrimaryLabel reports Windows when wsl-only but WSL is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        // Mirrors the resolvePrimary fall-back: the label must follow the
        // backend that actually resolves, not the persisted preference, so the
        // env switcher can't show "WSL" for a Windows backend.
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Windows");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
              }),
            ),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: false })),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("resolvePrimaryLabel is runSync-safe against the real WSL availability probe", async () => {
    // getLocalEnvironmentBootstraps is a sync IPC method: it resolves the
    // primary instance's lazy label through Effect.runSync. The label chains
    // to wslEnvironment.isAvailable, whose real layer probes the filesystem.
    // That probe must run once at layer build and expose a resolved value, not
    // a live async effect — otherwise runSync throws in the handler. Build the
    // real WSL layer (not the sync test stub) and resolve the label with a
    // top-level runSync, exactly as the handler does.
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This test intentionally replicates the sync IPC handler's runSync path to catch a regression to async-only resolution; it.effect would mask it.
    const runtime = ManagedRuntime.make(
      DesktopBackendConfiguration.layer.pipe(
        Layer.provideMerge(serverExposureLayer),
        Layer.provideMerge(DesktopAppSettings.layerTest()),
        Layer.provideMerge(DesktopWslServerTree.layerTest()),
        Layer.provideMerge(DesktopWslEnvironment.layer),
        // isAvailable on win32 only touches the filesystem, never the spawner,
        // so a die-stub is enough to satisfy the layer's deps.
        Layer.provideMerge(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.die("spawner should not be used while probing WSL availability"),
            ),
          ),
        ),
        Layer.provideMerge(makeEnvironmentLayer("/tmp/t3-wsl-isavailable", { platform: "win32" })),
        Layer.provide(NodeServices.layer),
      ),
    );
    try {
      const configuration = await runtime.runPromise(
        DesktopBackendConfiguration.DesktopBackendConfiguration,
      );
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Same reason: this is the synchronous resolution the IPC handler performs.
      const label = Effect.runSync(configuration.resolvePrimaryLabel);
      assert.equal(typeof label, "string");
    } finally {
      await runtime.dispose();
    }
  });
});
