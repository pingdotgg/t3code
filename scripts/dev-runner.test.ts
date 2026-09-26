import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import {
  buildDevRunnerArgs,
  checkPortAvailabilityOnHosts,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  isBrowserAllowedPort,
  isProxiableBindHost,
  resolveDevT3Home,
  resolveModePortOffsets,
  resolveOffset,
} from "./dev-runner.ts";

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("buildDevRunnerArgs", () => {
    it.effect("places filters before the task for every development mode", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(buildDevRunnerArgs("dev", []), [
          "run",
          "--parallel",
          "--filter",
          "@t3tools/contracts",
          "--filter",
          "@t3tools/web",
          "--filter",
          "t3",
          "dev",
        ]);
        assert.deepStrictEqual(buildDevRunnerArgs("dev:server", []), [
          "run",
          "--filter",
          "t3",
          "dev",
        ]);
        assert.deepStrictEqual(buildDevRunnerArgs("dev:web", []), [
          "run",
          "--filter",
          "@t3tools/web",
          "dev",
        ]);
        assert.deepStrictEqual(buildDevRunnerArgs("dev:desktop", []), [
          "run",
          "--parallel",
          "--filter",
          "@t3tools/desktop",
          "--filter",
          "@t3tools/web",
          "dev",
        ]);
      }),
    );

    it.effect("keeps runner arguments before the task", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(buildDevRunnerArgs("dev:web", ["--host", "127.0.0.1"]), [
          "run",
          "--filter",
          "@t3tools/web",
          "--host",
          "127.0.0.1",
          "dev",
        ]);
      }),
    );
  });

  describe("resolveOffset", () => {
    it.effect("uses explicit T3CODE_PORT_OFFSET when provided", () =>
      Effect.sync(() => {
        const result = resolveOffset({ portOffset: 12, devInstance: undefined });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "T3CODE_PORT_OFFSET=12",
        });
      }),
    );

    it.effect("hashes non-numeric instance values", () =>
      Effect.sync(() => {
        const result = resolveOffset({ portOffset: undefined, devInstance: "feature-branch" });
        assert.ok(result.offset >= 1);
        assert.ok(result.offset <= 3000);
      }),
    );

    it.effect("throws for negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          Effect.try({
            try: () => resolveOffset({ portOffset: -1, devInstance: undefined }),
            catch: (cause) => String(cause),
          }),
        );

        assert.ok(error.includes("Invalid T3CODE_PORT_OFFSET"));
      }),
    );

    it.effect("derives a stable offset from the worktree path", () =>
      Effect.sync(() => {
        const first = resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreePath: "/repo/.t3-thread-workspaces/abc123",
        });
        const second = resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreePath: "/repo/.t3-thread-workspaces/abc123",
        });
        assert.ok(first.offset >= 1);
        assert.ok(first.offset <= 3000);
        assert.deepStrictEqual(second, first);
        assert.ok(first.source.startsWith("worktree "));
      }),
    );

    it.effect("keeps default ports outside a worktree", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(resolveOffset({ portOffset: undefined, devInstance: undefined }), {
          offset: 0,
          source: "default ports",
        });
      }),
    );
  });

  describe("isProxiableBindHost", () => {
    it.effect("accepts loopback and wildcards, rejects LAN IPs", () =>
      Effect.sync(() => {
        for (const host of ["", "localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]) {
          assert.equal(isProxiableBindHost(host), true, host || "(empty)");
        }
        assert.equal(isProxiableBindHost("192.168.1.10"), false);
      }),
    );
  });

  describe("isBrowserAllowedPort", () => {
    it.effect("rejects fetch-blocked ports", () =>
      Effect.sync(() => {
        assert.equal(isBrowserAllowedPort(5733), true);
        assert.equal(isBrowserAllowedPort(6000), false);
        assert.equal(isBrowserAllowedPort(22), false);
      }),
    );
  });

  describe("resolveDevT3Home", () => {
    it.effect("prefers --home-dir over worktree and ambient homes", () =>
      Effect.sync(() => {
        assert.equal(
          resolveDevT3Home({
            flagHome: "/tmp/explicit",
            worktreeHome: "/repo/.t3-work/.t3",
            envHome: "/home/user/.t3-dev",
          }),
          "/tmp/explicit",
        );
      }),
    );

    it.effect("prefers the worktree home over ambient T3CODE_HOME", () =>
      Effect.sync(() => {
        assert.equal(
          resolveDevT3Home({
            flagHome: undefined,
            worktreeHome: "/repo/.t3-work/.t3",
            envHome: "/home/user/.t3-dev",
          }),
          "/repo/.t3-work/.t3",
        );
      }),
    );

    it.effect("falls back to ambient T3CODE_HOME outside a worktree", () =>
      Effect.sync(() => {
        assert.equal(
          resolveDevT3Home({
            flagHome: undefined,
            worktreeHome: undefined,
            envHome: "/home/user/.t3-dev",
          }),
          "/home/user/.t3-dev",
        );
        assert.equal(
          resolveDevT3Home({ flagHome: undefined, worktreeHome: undefined, envHome: undefined }),
          undefined,
        );
      }),
    );

    it.effect("ignores blank selections", () =>
      Effect.sync(() => {
        assert.equal(
          resolveDevT3Home({ flagHome: "  ", worktreeHome: "/repo/.t3", envHome: "/home/.t3-dev" }),
          "/repo/.t3",
        );
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    for (const mode of ["dev", "dev:server", "dev:web", "dev:desktop"] as const) {
      it.effect(`uses one loopback hostname for ${mode} web, HTTP, and WebSocket URLs`, () =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: {
              VITE_DEV_SERVER_URL: "http://localhost:9999",
              VITE_HTTP_URL: "http://localhost:9998",
              VITE_WS_URL: "ws://localhost:9998",
            },
            serverOffset: 3,
            webOffset: 3,
            t3Home: "/tmp/dev-runner-test",
            noBrowser: true,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.HOST, "127.0.0.1");
          assert.equal(env.PORT, "5736");
          assert.equal(env.T3CODE_PORT, "13776");
          assert.equal(env.VITE_DEV_SERVER_URL, "http://127.0.0.1:5736");
          assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:13776");
          assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:13776");
        }),
      );
    }

    it.effect("defaults T3CODE_HOME to isolated development state when not provided", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_HOME, path.resolve(NodeOS.homedir(), ".t3-dev"));
      }),
    );

    it.effect("defaults desktop development to an isolated T3CODE_HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:desktop",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_HOME, path.resolve(NodeOS.homedir(), ".t3-dev"));
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
          noBrowser: true,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.T3CODE_HOME, path.resolve("/tmp/custom-t3"));
        assert.equal(env.T3CODE_PORT, "4222");
        assert.equal(env.HOST, "localhost");
        assert.equal(env.VITE_HTTP_URL, "http://localhost:4222");
        assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
        assert.equal(env.T3CODE_NO_BROWSER, "1");
        assert.equal(env.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.T3CODE_LOG_WS_EVENTS, "1");
        assert.equal(env.T3CODE_HOST, "0.0.0.0");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
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
          noBrowser: undefined,
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
          noBrowser: undefined,
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
          noBrowser: undefined,
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
            VITE_WS_URL: "ws://localhost:13773",
          },
          serverOffset: 0,
          webOffset: 0,
          t3Home: "/tmp/my-t3",
          noBrowser: true,
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
          noBrowser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.T3CODE_PORT, "13773");
        assert.equal(env.VITE_HTTP_URL, "http://127.0.0.1:13773");
        assert.equal(env.VITE_WS_URL, "ws://127.0.0.1:13773");
      }),
    );

    it.effect("defaults T3CODE_NO_BROWSER=1 unless explicitly enabled", () =>
      Effect.gen(function* () {
        const base = {
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;

        const defaulted = yield* createDevRunnerEnv({ ...base, noBrowser: undefined });
        assert.equal(defaulted.T3CODE_NO_BROWSER, "1");

        const enabled = yield* createDevRunnerEnv({ ...base, noBrowser: false });
        assert.equal(enabled.T3CODE_NO_BROWSER, "0");
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
});
