// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NetService from "@t3tools/shared/Net";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  checkPortAvailabilityOnHosts,
  createDevRunnerEnv,
  devPortProbeHosts,
  findFirstAvailableOffset,
  getDevRunnerModeArgs,
  isBrowserAllowedPort,
  resolveModePortOffsets,
  resolveOffset,
  runDevRunnerWithInput,
} from "./dev-runner.ts";

const emptyConfigLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
const netServiceLayer = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(49_152),
  findAvailablePort: (port) => Effect.succeed(port),
});

function mockProcess(exit: number | PlatformError.PlatformError) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      typeof exit === "number"
        ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
        : Effect.fail(exit),
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

const devServerInput = {
  mode: "dev:server",
  t3Home: "/tmp/t3code-dev-runner",
  browser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: 13_773,
  devUrl: undefined,
  dryRun: false,
  share: false,
  runArgs: ["--inspect", "secret-token-value"],
} as const;

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("getDevRunnerModeArgs", () => {
    it.effect("lets Vite+ honor the desktop dev task graph", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(getDevRunnerModeArgs("dev:desktop"), [
          "run",
          "--filter=@t3tools/desktop",
          "--filter=@t3tools/web",
          "dev",
        ]);
      }),
    );

    it.effect("places Vite+ run flags before the task name", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(getDevRunnerModeArgs("dev"), [
          "run",
          "--filter=@t3tools/contracts",
          "--filter=@t3tools/web",
          "--filter=t3",
          "--parallel",
          "dev",
        ]);
      }),
    );
  });

  describe("resolveOffset", () => {
    it.effect("uses explicit T3CODE_PORT_OFFSET when provided", () =>
      Effect.gen(function* () {
        const result = yield* resolveOffset({ portOffset: 12, devInstance: undefined });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "T3CODE_PORT_OFFSET=12",
        });
      }),
    );

    it.effect("hashes non-numeric instance values", () =>
      Effect.gen(function* () {
        const result = yield* resolveOffset({
          portOffset: undefined,
          devInstance: "feature-branch",
        });
        assert.ok(result.offset >= 1);
        assert.ok(result.offset <= 3000);
      }),
    );

    it.effect("returns structured context for a negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* resolveOffset({ portOffset: -1, devInstance: undefined }).pipe(
          Effect.flip,
        );

        assert.equal(error._tag, "DevRunnerInvalidPortOffsetError");
        assert.equal(error.configKey, "T3CODE_PORT_OFFSET");
        assert.equal(error.portOffset, -1);
        assert.equal(error.minimum, 0);
        assert.ok(!("cause" in error));
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    it.effect("leaves the shared home implicit and disables browser auto-open", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_HOME, undefined);
        assert.equal(env.T3CODE_NO_BROWSER, "1");
      }),
    );

    it.effect("allows browser auto-open to be explicitly enabled", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_NO_BROWSER, "0");
      }),
    );

    it.effect("requires the browser flag even when the environment enables auto-open", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { T3CODE_NO_BROWSER: "0" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: false,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_NO_BROWSER, "1");
      }),
    );

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: "/tmp/custom-t3",
          browser: false,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.T3CODE_HOME, path.resolve("/tmp/custom-t3"));
        assert.equal(env.T3CODE_PORT, "4222");
        assert.equal(env.VITE_HTTP_URL, "http://localhost:4222");
        assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
        assert.equal(env.T3CODE_NO_BROWSER, "1");
        assert.equal(env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.T3CODE_LOG_WS_EVENTS, "1");
        assert.equal(env.T3CODE_HOST, "0.0.0.0");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
      }),
    );

    it.effect("strips inherited service-launcher context", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            T3_SERVICE_LAUNCHER_CONTEXT: '{"childVersion":"9.9.9"}',
            T3_BOOT_SERVICE_UNIT: "t3code.service",
          },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3_SERVICE_LAUNCHER_CONTEXT, undefined);
        assert.equal(env.T3_BOOT_SERVICE_UNIT, undefined);
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            T3CODE_LOG_WS_EVENTS: "keep-me-out",
          },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_MODE, "web");
        assert.equal(env.T3CODE_LOG_WS_EVENTS, undefined);
      }),
    );

    it.effect("forwards explicit websocket logging false without coercing it away", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            T3CODE_LOG_WS_EVENTS: "1",
          },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: false,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_LOG_WS_EVENTS, "0");
      }),
    );

    it.effect("uses custom t3Home when provided", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: "/tmp/my-t3",
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_HOME, path.resolve("/tmp/my-t3"));
      }),
    );

    it.effect("pins desktop dev to a stable backend port and websocket url", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {
            T3CODE_PORT: "13773",
            T3CODE_MODE: "web",
            T3CODE_NO_BROWSER: "0",
            T3CODE_HOST: "0.0.0.0",
            VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
            VITE_WS_URL: "ws://localhost:13773",
          },
          serverOffset: 0,
          webOffset: 0,
          t3Home: "/tmp/my-t3",
          browser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "127.0.0.1",
          port: 4222,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_HOME, path.resolve("/tmp/my-t3"));
        assert.equal(env.PORT, "5733");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://127.0.0.1:5733");
        assert.equal(env.HOST, "127.0.0.1");
        assert.equal(env.T3CODE_PORT, "4222");
        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:4222");
        assert.equal(env.T3CODE_MODE, undefined);
        assert.equal(env.T3CODE_NO_BROWSER, undefined);
        assert.equal(env.T3CODE_HOST, undefined);
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:4222");
      }),
    );

    it.effect("defaults dev server mode to the higher backend port range", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_PORT, "13773");
        assert.equal(env.PORT, "5733");
      }),
    );

    // Browser dev is single-origin: Vite proxies the backend, and the client
    // resolves it from window.location.origin. Baking a localhost URL here is
    // what breaks sharing a dev server to another device.
    for (const mode of ["dev", "dev:web"] as const) {
      it.effect(`leaves the client backend URLs unset in ${mode} mode`, () =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: {
              VITE_HTTP_URL: "http://localhost:1234",
              VITE_WS_URL: "ws://localhost:1234",
            },
            serverOffset: 0,
            webOffset: 0,
            t3Home: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.VITE_HTTP_URL, undefined);
          assert.equal(env.VITE_WS_URL, undefined);
          assert.equal(env.T3CODE_PORT, "13773");
          // Deleting the keys is not sufficient — vite.config.ts merges
          // `.env`/`.env.local` underneath this env and would revive them, so
          // the intent has to be stated positively.
          assert.equal(env.T3CODE_SINGLE_ORIGIN_DEV, "1");
        }),
      );
    }

    // Desktop pins the renderer at loopback deliberately; an ambient marker
    // must not make Vite discard those URLs.
    it.effect("clears the single-origin marker in dev:desktop mode", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: { T3CODE_SINGLE_ORIGIN_DEV: "1" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_SINGLE_ORIGIN_DEV, undefined);
        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:13773");
      }),
    );

    it.effect("clears the single-origin marker in dev:server mode", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: { T3CODE_SINGLE_ORIGIN_DEV: "1" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_SINGLE_ORIGIN_DEV, undefined);
        assert.equal(env.VITE_HTTP_URL, "http://localhost:13773");
      }),
    );

    // HOST is Vite's bind address and gates the HMR pin in vite.config.ts. An
    // inherited one would survive into browser dev and point HMR at the wrong
    // interface — invisible over a shared origin, since the page still loads.
    for (const mode of ["dev", "dev:web"] as const) {
      it.effect(`drops an inherited HOST in ${mode} mode`, () =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: { HOST: "0.0.0.0" },
            serverOffset: 0,
            webOffset: 0,
            t3Home: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.HOST, undefined);
        }),
      );
    }

    // --host configures the *backend* (T3CODE_HOST). It must not become Vite's
    // bind address by way of an inherited HOST that happens to agree with it.
    it.effect("drops an inherited HOST even when --host is given", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { HOST: "0.0.0.0" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "0.0.0.0",
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.HOST, undefined);
        assert.equal(env.T3CODE_HOST, "0.0.0.0");
      }),
    );

    // Desktop sets HOST itself, so the clearing must not reach it.
    it.effect("still pins HOST for dev:desktop", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: { HOST: "0.0.0.0" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.HOST, "127.0.0.1");
      }),
    );

    it.effect("keeps explicit backend URLs for the desktop renderer", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:13773");
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:13773");
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("returns the starting offset when required ports are available", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 0);
      }),
    );

    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733, 13774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("skips browser-blocked web ports before probing availability", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];
        const offset = yield* findFirstAvailableOffset({
          // 5733 + 833 = 6566, which browsers block as sane-port.
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.equal(offset, 834);
        assert.deepStrictEqual(probed, [
          { port: 14_607, role: "server" },
          { port: 6567, role: "web" },
        ]);
      }),
    );

    it.effect("does not reject a server-only offset because its unused web port is blocked", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 833);
      }),
    );

    it.effect("allows offsets where the non-required server port exceeds max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_802,
          requireServerPort: false,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_802);
      }),
    );

    it.effect("reports the exhausted range and required port set", () =>
      Effect.gen(function* () {
        const error = yield* findFirstAvailableOffset({
          startOffset: 51_763,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        }).pipe(Effect.flip);

        if (error._tag !== "DevRunnerPortExhaustedError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.startOffset, 51_763);
        assert.equal(error.requireServerPort, true);
        assert.equal(error.requireWebPort, false);
        assert.equal(error.baseServerPort, 13_773);
        assert.equal(error.baseWebPort, 5_733);
        assert.equal(error.maximumPort, 65_535);
        assert.ok(!("cause" in error));
      }),
    );
  });

  describe("isBrowserAllowedPort", () => {
    it.each([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697])(
      "rejects Fetch-blocked web port %s from the worktree offset range",
      (port) => {
        assert.equal(isBrowserAllowedPort(port), false);
      },
    );

    it.each([5733, 5900, 6567, 6670, 8733])("allows browser-safe web port %s", (port) => {
      assert.equal(isBrowserAllowedPort(port), true);
    });
  });

  describe("checkPortAvailabilityOnHosts", () => {
    it.effect("checks overlapping hosts sequentially to avoid self-interference", () =>
      Effect.gen(function* () {
        let inFlightCount = 0;
        const calls: Array<[number, string]> = [];

        const available = yield* checkPortAvailabilityOnHosts(
          13_773,
          ["127.0.0.1", "0.0.0.0", "::"],
          (port, host) =>
            Effect.promise(async () => {
              calls.push([port, host]);
              inFlightCount += 1;
              const overlapped = inFlightCount > 1;
              await Promise.resolve();
              inFlightCount -= 1;
              return !overlapped;
            }),
        );

        assert.equal(available, true);
        assert.deepStrictEqual(calls, [
          [13_773, "127.0.0.1"],
          [13_773, "0.0.0.0"],
          [13_773, "::"],
        ]);
      }),
    );
  });

  describe("devPortProbeHosts", () => {
    it.effect("probes loopback only when no bind host is configured", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts(undefined), ["127.0.0.1", "::1"]);
        assert.deepStrictEqual(devPortProbeHosts("  "), ["127.0.0.1", "::1"]);
      }),
    );

    // A port free on loopback can be taken on the interface the server will
    // actually bind, so --host/T3CODE_HOST has to be probed as well.
    it.effect("adds a non-loopback bind host to the probe list", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts("0.0.0.0"), ["127.0.0.1", "::1", "0.0.0.0"]);
        assert.deepStrictEqual(devPortProbeHosts("192.168.1.10"), [
          "127.0.0.1",
          "::1",
          "192.168.1.10",
        ]);
      }),
    );

    it.effect("does not probe loopback twice when it is the configured host", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts("127.0.0.1"), ["127.0.0.1", "::1"]);
      }),
    );

    // Only the backend honours --host/T3CODE_HOST. Vite reads HOST (set for
    // desktop only), so judging the web port against the backend's interface
    // would reject ports for a server that never binds there.
    it.effect("passes the port role so only the server port sees the bind host", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];

        yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.deepStrictEqual(probed, [
          { port: 13_773, role: "server" },
          { port: 5733, role: "web" },
        ]);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([13773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );
  });

  describe("runDevRunnerWithInput", () => {
    it.effect("preserves invalid configuration as the exact cause", () =>
      Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({ ...devServerInput, dryRun: true }).pipe(
          Effect.provide(
            Layer.merge(
              netServiceLayer,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { T3CODE_PORT_OFFSET: "not-an-integer" } }),
              ),
            ),
          ),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerConfigurationError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.deepStrictEqual(error.configKeys, ["T3CODE_PORT_OFFSET", "T3CODE_DEV_INSTANCE"]);
        assert.ok(error.cause !== undefined);
        assert.ok(!error.message.includes(String((error.cause as Error).message)));
      }),
    );

    it.effect("preserves process spawn context and the exact platform cause", () => {
      const cause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "vp was not found",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(cause)),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.operation, "spawn");
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    // `tailscale serve` config outlives the process, so a dry run that shared
    // would replace and then tear down whatever mapping the port already had.
    // Base-dir precedence (--home-dir > worktree .t3 > ambient T3CODE_HOME)
    // lives in runDevRunnerWithInput; the env builder must not consult the
    // ambient variable on its own, or it would silently outrank the worktree
    // default and land dev state on the user's real database.
    it.effect("ignores an ambient T3CODE_HOME when no home is resolved", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { T3CODE_HOME: "/home/user/.t3" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_HOME, undefined);
      }),
    );

    // Sharing dev:desktop would publish a URL whose renderer dials the
    // visitor's own loopback, and would clobber the VITE_DEV_SERVER_URL that
    // Electron loads from. It must decline, not half-work.
    it.effect("declines to share for dev:desktop and still starts the stack", () => {
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(mockProcess(0));
        }),
      );

      return Effect.gen(function* () {
        yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev:desktop",
          port: undefined,
          share: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        assert.equal(spawnCount, 1);
      });
    });

    // Single-origin browser dev proxies the backend at localhost, so a backend
    // bound only to a specific interface breaks every proxied request in a way
    // that looks like a broken server. Reject the combination up front.
    it.effect("rejects a specific non-loopback --host for browser dev modes", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          host: "192.168.1.10",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerHostNotProxiableError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev");
        assert.equal(error.host, "192.168.1.10");
        assert.include(error.message, "0.0.0.0");
        assert.include(error.message, "--share");
      });
    });

    // Wildcards keep loopback answering, so the proxy target stays valid and
    // the combination must keep working — it is the documented way to serve a
    // LAN interface and the browser proxy at once.
    it.effect("still spawns the stack for a wildcard --host in dev mode", () => {
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(mockProcess(0));
        }),
      );

      return Effect.gen(function* () {
        yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          host: "0.0.0.0",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        assert.equal(spawnCount, 1);
      });
    });

    // dev:server does not proxy — the client talks to the backend directly —
    // so a specific interface bind stays legitimate there.
    it.effect("keeps a specific --host working for dev:server", () => {
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(mockProcess(0));
        }),
      );

      return Effect.gen(function* () {
        yield* runDevRunnerWithInput({
          ...devServerInput,
          host: "192.168.1.10",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        assert.equal(spawnCount, 1);
      });
    });

    // A shared origin means a remote browser, where unbundled dev's
    // per-module waterfall pays a tailnet round trip per import level. The
    // runner defaults bundled dev on for the spawned stack, but only
    // defaults: an explicit T3CODE_BUNDLED_DEV (even "0") must pass through.
    describe("--share bundled dev default", () => {
      const shareSpawnedEnv = (input: { readonly ambientBundledDev: string | undefined }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const spawned = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options?: { readonly env?: Record<string, string | undefined> };
              };
              if (spawned.command === "vp") {
                captured = spawned.options?.env;
                return Effect.succeed(mockProcess(0));
              }
              // tailscale: answer `status --json` with a valid tailnet name,
              // succeed the `serve`/`off` calls.
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(2),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: spawned.args.includes("status")
                    ? Stream.make(
                        new TextEncoder().encode(
                          JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }),
                        ),
                      )
                    : Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              );
            }),
          );

          yield* runDevRunnerWithInput({
            ...devServerInput,
            mode: "dev",
            port: undefined,
            share: true,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(
              HostProcessEnvironment,
              input.ambientBundledDev === undefined
                ? {}
                : { T3CODE_BUNDLED_DEV: input.ambientBundledDev },
            ),
          );

          return captured;
        });

      it.effect("defaults T3CODE_BUNDLED_DEV=1 for a shared run", () =>
        Effect.gen(function* () {
          const env = yield* shareSpawnedEnv({ ambientBundledDev: undefined });
          assert.equal(env?.T3CODE_BUNDLED_DEV, "1");
        }),
      );

      it.effect("keeps an explicit T3CODE_BUNDLED_DEV=0 opt-out", () =>
        Effect.gen(function* () {
          const env = yield* shareSpawnedEnv({ ambientBundledDev: "0" });
          assert.equal(env?.T3CODE_BUNDLED_DEV, "0");
        }),
      );

      it.effect("leaves T3CODE_BUNDLED_DEV unset without --share", () =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured = (
                command as {
                  readonly options?: { readonly env?: Record<string, string | undefined> };
                }
              ).options?.env;
              return Effect.succeed(mockProcess(0));
            }),
          );

          yield* runDevRunnerWithInput({
            ...devServerInput,
            mode: "dev",
            port: undefined,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(HostProcessEnvironment, {}),
          );

          assert.equal(captured?.T3CODE_BUNDLED_DEV, undefined);
        }),
      );
    });

    it.effect("spawns nothing when --dry-run is combined with --share", () => {
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(mockProcess(0));
        }),
      );

      return Effect.gen(function* () {
        yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          dryRun: true,
          share: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        assert.equal(spawnCount, 0);
      });
    });

    it.effect("reports non-zero exits without manufacturing a cause", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(17))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessExitError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.exitCode, 17);
        assert.ok(!("cause" in error));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    it.effect("preserves wait-for-exit failures as the exact cause", () => {
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        description: "process status became unavailable",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(cause))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.operation, "wait-for-exit");
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    describe("t3 home precedence", () => {
      const makeWorktree = Effect.acquireRelease(
        Effect.sync(() => {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devrunner-"));
          NodeFS.writeFileSync(
            NodePath.join(root, ".git"),
            "gitdir: /elsewhere/.git/worktrees/x\n",
          );
          return root;
        }),
        (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );

      const spawnedHome = (input: {
        readonly t3Home: string | undefined;
        readonly cwd: string;
        readonly ambientHome: string | undefined;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured = (
                command as {
                  readonly options?: { readonly env?: Record<string, string | undefined> };
                }
              ).options?.env;
              return Effect.succeed(mockProcess(0));
            }),
          );

          yield* runDevRunnerWithInput({ ...devServerInput, t3Home: input.t3Home }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(HostProcessWorkingDirectory, input.cwd),
            Effect.provideService(
              HostProcessEnvironment,
              input.ambientHome === undefined ? {} : { T3CODE_HOME: input.ambientHome },
            ),
          );

          return captured?.T3CODE_HOME;
        });

      it.effect("prefers an explicit --home-dir over the worktree default", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t3Home: "/tmp/explicit-home",
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.resolve("/tmp/explicit-home"));
        }).pipe(Effect.scoped),
      );

      it.effect("treats a blank --home-dir as unset rather than as a selection", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t3Home: "   ",
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.join(path.resolve(root), ".t3"));
        }).pipe(Effect.scoped),
      );

      it.effect("prefers the worktree .t3 over an ambient T3CODE_HOME", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            t3Home: undefined,
            cwd: root,
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.join(path.resolve(root), ".t3"));
        }).pipe(Effect.scoped),
      );

      it.effect("falls back to an ambient T3CODE_HOME outside a worktree", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = yield* spawnedHome({
            t3Home: undefined,
            cwd: NodeOS.tmpdir(),
            ambientHome: "/home/user/.t3",
          });
          assert.equal(home, path.resolve("/home/user/.t3"));
        }),
      );

      it.effect("leaves the home implicit with no worktree and no ambient value", () =>
        Effect.gen(function* () {
          const home = yield* spawnedHome({
            t3Home: undefined,
            cwd: NodeOS.tmpdir(),
            ambientHome: undefined,
          });
          assert.equal(home, undefined);
        }),
      );
    });
  });
});
