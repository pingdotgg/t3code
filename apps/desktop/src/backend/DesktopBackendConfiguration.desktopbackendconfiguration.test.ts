import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { currentDesktopBootstrapToken } from "@t3tools/shared/desktopBootstrapToken";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

const layerShellEnvironment = (prepared = true) =>
  Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
    installIntoProcess: Effect.succeed(prepared),
    awaitDiscovery: Effect.succeed(prepared),
    updates: Stream.empty,
  });

const layerBackendConfiguration = (prepared = true) =>
  DesktopBackendConfiguration.layer.pipe(Layer.provide(layerShellEnvironment(prepared)));

const layerServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
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

function layerEnvironment(
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
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
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
        NodeCrypto.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
          T3CODE_DESKTOP_LAN_HOST: "192.168.1.50",
          VITE_DEV_SERVER_URL: options?.devServerUrl,
          T3CODE_OTLP_TRACES_URL: options?.otlpTracesUrl,
          T3CODE_OTLP_METRICS_URL: options?.otlpMetricsUrl,
          T3CODE_OTLP_LOGS_URL: options?.otlpLogsUrl,
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
  prepared = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });

    return yield* effect.pipe(
      Effect.provide(
        layerBackendConfiguration(prepared).pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(DesktopWslEnvironment.layerTest()),
          Layer.provideMerge(DesktopWslServerTree.layerTest()),
          Layer.provideMerge(layerEnvironment(baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

interface PackagedWslHarnessContext {
  readonly baseDir: string;
  readonly archivePath: string;
  readonly hashPath: string;
  readonly archiveHash: string;
  readonly mountedAppRoot: string;
  readonly mountedEntryPath: string;
}

const withPackagedWslHarness = <A, E, R>(
  input: {
    readonly archiveHash: string;
    readonly wsl: (
      context: PackagedWslHarnessContext,
    ) => DesktopWslEnvironment.DesktopWslEnvironmentTestStub;
    readonly forbidFallback?: string;
    readonly cleanupLegacy?: Effect.Effect<void>;
    readonly forbidCleanup?: string;
  },
  effect: (
    context: PackagedWslHarnessContext,
  ) => Effect.Effect<
    A,
    E,
    R | FileSystem.FileSystem | Path.Path | DesktopBackendConfiguration.DesktopBackendConfiguration
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-backend-config-test-",
    });
    const archivePath = path.join(baseDir, "wsl-runtime.tar.gz");
    const hashPath = `${archivePath}.sha256`;
    const mountedAppRoot = "/mnt/c/app.asar.unpacked";
    const mountedEntryPath = path.join(baseDir, "app.asar.unpacked/apps/server/dist/bin.mjs");
    yield* fileSystem.makeDirectory(path.dirname(mountedEntryPath), { recursive: true });
    yield* fileSystem.writeFileString(mountedEntryPath, "");
    yield* fileSystem.writeFileString(archivePath, "archive");
    yield* fileSystem.writeFileString(hashPath, `${input.archiveHash}\n`);

    const context = {
      baseDir,
      archivePath,
      hashPath,
      archiveHash: input.archiveHash,
      mountedAppRoot,
      mountedEntryPath,
    } satisfies PackagedWslHarnessContext;
    const layerServerTree = input.forbidFallback
      ? Layer.succeed(
          DesktopWslServerTree.DesktopWslServerTree,
          DesktopWslServerTree.DesktopWslServerTree.of({
            ensure: Effect.die(input.forbidFallback),
            cleanupLegacy: input.forbidCleanup
              ? Effect.die(input.forbidCleanup)
              : (input.cleanupLegacy ?? Effect.void),
          }),
        )
      : DesktopWslServerTree.layerTest({
          result: { ok: true, root: path.join(baseDir, "app.asar.unpacked") },
          cleanupLegacy: input.cleanupLegacy ?? Effect.void,
        });

    return yield* effect(context).pipe(
      Effect.provide(
        layerBackendConfiguration().pipe(
          Layer.provideMerge(layerServerExposure),
          Layer.provideMerge(DesktopAppSettings.layerTest()),
          Layer.provideMerge(layerServerTree),
          Layer.provideMerge(
            DesktopWslEnvironment.layerTest({
              isAvailable: true,
              distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              windowsToWslPath: () => Option.some(mountedAppRoot),
              getDistroIp: () => Option.some("172.27.0.99"),
              ...input.wsl(context),
            }),
          ),
          Layer.provideMerge(
            layerEnvironment(baseDir, {
              appPath: baseDir,
              platform: "win32",
              resourcesPath: baseDir,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("DesktopBackendConfiguration", () => {
  it.effect("resolveWsl preserves existing WSLENV entries when forwarding backend secrets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const previousWslEnv = process.env.WSLENV;
      const previousOpenAiKey = process.env.OPENAI_API_KEY;
      const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const previousOtlpHeaders = process.env.T3CODE_OTLP_HEADERS;
      const previousOtlpProtocol = process.env.T3CODE_OTLP_PROTOCOL;
      const ambientOtel = Object.entries(process.env).filter(([name]) => name.startsWith("OTEL_"));
      try {
        for (const [name] of ambientOtel) delete process.env[name];
        process.env.WSLENV = "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u";
        process.env.OPENAI_API_KEY = "openai-key";
        process.env.ANTHROPIC_API_KEY = "anthropic-key";
        process.env.T3CODE_OTLP_HEADERS = 'authorization="Bearer%20my-token"';
        process.env.T3CODE_OTLP_PROTOCOL = "http/protobuf";

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

          assert.equal(config.executablePath, "wsl.exe");
          assert.equal(config.bootstrap.port, 5050);
          assert.equal(config.bootstrap.host, "0.0.0.0");
          assert.equal(config.bootstrap.tailscaleServeEnabled, false);
          assert.notProperty(config.bootstrap, "desktopTelemetryFd");
          assert.notProperty(config.bootstrap, "resourceMonitorPath");
          assert.equal(config.httpBaseUrl.href, "http://172.27.0.99:5050/");
          assert.equal(config.env.OPENAI_API_KEY, "openai-key");
          assert.equal(config.env.ANTHROPIC_API_KEY, "anthropic-key");
          assert.equal(config.env.T3CODE_OTLP_PROTOCOL, "http/protobuf");
          assert.equal(
            config.env.WSLENV,
            "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u:ANTHROPIC_API_KEY:T3CODE_OTLP_HEADERS:T3CODE_OTLP_PROTOCOL",
          );
        }).pipe(
          Effect.provide(
            layerBackendConfiguration().pipe(
              Layer.provideMerge(layerServerExposure),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
            ),
          ),
        );
      } finally {
        restoreEnv("WSLENV", previousWslEnv);
        restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
        restoreEnv("ANTHROPIC_API_KEY", previousAnthropicKey);
        restoreEnv("T3CODE_OTLP_HEADERS", previousOtlpHeaders);
        restoreEnv("T3CODE_OTLP_PROTOCOL", previousOtlpProtocol);
        for (const [name, value] of ambientOtel) restoreEnv(name, value);
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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

          assert.equal(config.executablePath, process.execPath);
          assert.equal(config.bootstrap.t3Home, environment.baseDir);
          assert.isTrue(Option.isNone(config.preflightFailure));
        }).pipe(
          Effect.provide(
            layerBackendConfiguration().pipe(
              Layer.provideMerge(layerServerExposure),
              Layer.provideMerge(
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  wslBackendEnabled: true,
                  wslOnly: true,
                }),
              ),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: false })),
              Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
            layerBackendConfiguration().pipe(
              Layer.provideMerge(layerServerExposure),
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
              Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(layerEnvironment(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
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
          layerBackendConfiguration().pipe(
            Layer.provideMerge(layerServerExposure),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              layerEnvironment(baseDir, {
                appPath: `${resourcesPath}/app.asar`,
                dirname,
                isPackaged: true,
                resourcesPath,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it("resolvePrimaryLabel is runSync-safe against the real WSL availability probe", async () => {
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- This test intentionally replicates the sync IPC handler's runSync path to catch a regression to async-only resolution; it.effect would mask it.
    const runtime = ManagedRuntime.make(
      layerBackendConfiguration().pipe(
        Layer.provideMerge(layerServerExposure),
        Layer.provideMerge(DesktopAppSettings.layerTest()),
        Layer.provideMerge(DesktopWslServerTree.layerTest()),
        Layer.provideMerge(DesktopWslEnvironment.layer),
        Layer.provideMerge(DesktopManagedPolicy.layerTest()),
        Layer.provideMerge(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.die("spawner should not be used while probing WSL availability"),
            ),
          ),
        ),
        Layer.provideMerge(layerEnvironment("/tmp/t3-wsl-isavailable", { platform: "win32" })),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
