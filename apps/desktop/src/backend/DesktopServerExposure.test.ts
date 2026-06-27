import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const encoder = new TextEncoder();

const emptyNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {};
const lanNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  en0: [
    {
      address: "192.168.1.20",
      family: "IPv4",
      internal: false,
    },
  ],
};

const tailnetNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  tailscale0: [
    {
      address: "100.90.1.2",
      family: "IPv4",
      internal: false,
    },
  ],
};

function mockSpawnerLayer(statusJson = "{}") {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(statusJson)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    ),
  );
}

function dieOnSpawnLayer() {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unexpected tailscale spawn")),
  );
}

function makeEnvironmentLayer(baseDir: string, env: Record<string, string | undefined> = {}) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir, ...env })),
    ),
  );
}

function makeLayer(input: {
  readonly baseDir: string;
  readonly networkInterfaces?: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly env?: Record<string, string | undefined>;
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>;
}) {
  const env = { T3CODE_HOME: input.baseDir, ...input.env };
  const environmentLayer = makeEnvironmentLayer(input.baseDir, env);
  const networkLayer = Layer.succeed(DesktopNetworkInterfaces.DesktopNetworkInterfaces, {
    read: Effect.succeed(input.networkInterfaces ?? emptyNetworkInterfaces),
  });

  return DesktopServerExposure.layer.pipe(
    Layer.provideMerge(input.desktopSettingsLayer ?? DesktopAppSettings.layer),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
    Layer.provideMerge(input.spawnerLayer ?? mockSpawnerLayer()),
    Layer.provideMerge(networkLayer),
    Layer.provideMerge(DesktopConfig.layerTest(env)),
    Layer.provideMerge(environmentLayer),
  );
}

const withHarness = <A, E, R>(
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopServerExposure.DesktopServerExposure
    | DesktopAppSettings.DesktopAppSettings
  >,
  env: Record<string, string | undefined> = {},
  spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-server-exposure-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        makeLayer({
          baseDir,
          networkInterfaces,
          env,
          ...(spawnerLayer ? { spawnerLayer } : {}),
          ...(desktopSettingsLayer ? { desktopSettingsLayer } : {}),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopServerExposure", () => {
  it.effect("falls back to local-only without losing the requested network preference", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "local-only");
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* settings.get).serverExposureMode, "network-accessible");

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "127.0.0.1");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");
      }),
    ),
  );

  it.effect("returns a typed error when network access is explicitly unavailable", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const error = yield* serverExposure.setMode("network-accessible").pipe(Effect.flip);
        assert.ok(error._tag === "DesktopServerExposureNoNetworkAddressError");
        assert.equal(error.port, 4173);
      }),
    ),
  );

  it.effect("persists network-accessible mode and updates backend binding state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const change = yield* serverExposure.setMode("network-accessible");
        assert.equal(change.requiresRelaunch, true);
        assert.deepEqual(change.state, {
          mode: "network-accessible",
          endpointUrl: "http://192.168.1.20:4173",
          advertisedHost: "192.168.1.20",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        });

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "0.0.0.0");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");

        const persisted = yield* settings.get;
        assert.equal(persisted.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("persists tailscale serve preferences atomically and reports no-op updates", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const changed = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(changed.requiresRelaunch, true);
        assert.equal(changed.state.tailscaleServeEnabled, true);
        assert.equal(changed.state.tailscaleServePort, 8443);

        const unchanged = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(unchanged.requiresRelaunch, false);

        const persisted = yield* settings.get;
        assert.equal(persisted.tailscaleServeEnabled, true);
        assert.equal(persisted.tailscaleServePort, 8443);
      }),
    ),
  );

  it.effect("preserves persistence request context and the settings failure chain", () => {
    const diskFailure = new Error("disk exploded");
    const settingsFailure = new DesktopAppSettings.DesktopSettingsWriteError({
      operation: "replace-settings-file",
      path: "/tmp/desktop-settings.json",
      cause: diskFailure,
    });
    const settingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
      get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      setServerExposureMode: () => Effect.fail(settingsFailure),
      setTailscaleServe: () => Effect.fail(settingsFailure),
      setUpdateChannel: () => Effect.die("unexpected update channel change"),
      setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
      setWslDistro: () => Effect.die("unexpected WSL distro change"),
      setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
      applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
      applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
    } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

    return withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const modeError = yield* serverExposure.setMode("network-accessible").pipe(Effect.flip);
        assert.instanceOf(
          modeError,
          DesktopServerExposure.DesktopServerExposureModePersistenceError,
        );
        assert.isTrue(DesktopServerExposure.isDesktopServerExposureSetModeError(modeError));
        assert.isTrue(DesktopServerExposure.isDesktopServerExposureError(modeError));
        assert.equal(modeError.mode, "network-accessible");
        assert.strictEqual(modeError.cause, settingsFailure);
        assert.strictEqual(modeError.cause.cause, diskFailure);
        assert.equal(
          modeError.message,
          "Failed to persist desktop server exposure mode network-accessible.",
        );
        assert.notInclude(modeError.message, diskFailure.message);

        const tailscaleError = yield* serverExposure
          .setTailscaleServeEnabled({ enabled: true, port: 8443 })
          .pipe(Effect.flip);
        assert.instanceOf(
          tailscaleError,
          DesktopServerExposure.DesktopTailscaleServePersistenceError,
        );
        assert.isTrue(DesktopServerExposure.isDesktopServerExposureError(tailscaleError));
        assert.equal(tailscaleError.enabled, true);
        assert.equal(tailscaleError.port, 8443);
        assert.strictEqual(tailscaleError.cause, settingsFailure);
        assert.strictEqual(tailscaleError.cause.cause, diskFailure);
        assert.equal(
          tailscaleError.message,
          "Failed to persist desktop Tailscale Serve settings (enabled: true, port: 8443).",
        );
        assert.notInclude(tailscaleError.message, diskFailure.message);
      }),
      {},
      undefined,
      settingsLayer,
    );
  });

  it.effect("resolves advertised endpoints from the scoped runtime state", () =>
    withHarness(
      { ...lanNetworkInterfaces, ...tailnetNetworkInterfaces },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/", "http://100.90.1.2:4173/"],
        );
      }),
    ),
  );

  it.effect("does not spawn the tailscale CLI while server exposure is local-only", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        // mode stays at default "local-only", tailscaleServeEnabled stays false.

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        // Only the loopback endpoint; no tailscale spawn means the dieOnSpawnLayer
        // would have crashed the test if the gate was missing.
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/"],
        );
      }),
      {},
      dieOnSpawnLayer(),
    ),
  );

  it.effect("uses ConfigProvider desktop exposure overrides", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        const change = yield* serverExposure.setMode("network-accessible");

        assert.equal(change.state.advertisedHost, "10.0.0.7");
        assert.equal(change.state.endpointUrl, "http://10.0.0.7:4173");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://10.0.0.7:4173/", "https://public.example.test/"],
        );
      }),
      {
        T3CODE_DESKTOP_LAN_HOST: "10.0.0.7",
        T3CODE_DESKTOP_HTTPS_ENDPOINTS: "https://public.example.test",
      },
    ),
  );

  it.effect("advertises loopback, LAN, and configured manual endpoints from runtime state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 3773 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(endpoints, [
          {
            id: "desktop-loopback:3773",
            label: "This machine",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
            reachability: "loopback",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            description: "Loopback endpoint for this desktop app.",
          },
          {
            id: "desktop-lan:http://192.168.1.20:3773",
            label: "Local network",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://192.168.1.20:3773/",
            wsBaseUrl: "ws://192.168.1.20:3773/",
            reachability: "lan",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            isDefault: true,
            description: "Reachable from devices on the same network.",
          },
          {
            id: "manual:https://desktop.example.ts.net",
            label: "Custom HTTPS",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "https://desktop.example.ts.net/",
            wsBaseUrl: "wss://desktop.example.ts.net/",
            reachability: "public",
            compatibility: {
              hostedHttpsApp: "compatible",
              desktopApp: "compatible",
            },
            source: "user",
            status: "unknown",
            description: "User-configured HTTPS endpoint for this desktop backend.",
          },
          {
            id: "manual:http://desktop.example.test:3773",
            label: "Custom endpoint",
            provider: {
              id: "manual",
              label: "Manual",
              kind: "manual",
              isAddon: false,
            },
            httpBaseUrl: "http://desktop.example.test:3773/",
            wsBaseUrl: "ws://desktop.example.test:3773/",
            reachability: "public",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "user",
            status: "unknown",
            description: "User-configured endpoint for this desktop backend.",
          },
        ]);
      }),
      {
        T3CODE_DESKTOP_HTTPS_ENDPOINTS:
          "https://desktop.example.ts.net,http://desktop.example.test:3773,not-a-url",
      },
    ),
  );
});
