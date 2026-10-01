import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Path } from "effect";

import {
  buildDevRunnerArgs,
  checkPortAvailabilityOnHosts,
  computeProcessTreeKillOrder,
  createDevRunnerEnv,
  devRunnerCommandMatchesHome,
  findFirstAvailableOffset,
  isBrowserAllowedPort,
  isProxiableBindHost,
  parseDevRunnerPidFile,
  readDevRunnerPidFile,
  resolveDevT3Home,
  resolveModePortOffsets,
  resolveOffset,
  stopDevEnvironment,
  writeDevRunnerPidFile,
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

  describe("dev-runner pidfile", () => {
    it.effect("round-trips a pid record through the base directory", () =>
      Effect.gen(function* () {
        const fs = yield* Effect.promise(() => import("node:fs/promises"));
        const os = yield* Effect.promise(() => import("node:os"));
        const path = yield* Effect.promise(() => import("node:path"));
        const baseDir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "t3-pid-")));
        const record = {
          pid: 424242,
          serverPort: 14994,
          webPort: 6954,
          baseDir,
          startedAt: "2026-10-01T00:00:00.000Z",
        };
        const written = yield* writeDevRunnerPidFile(baseDir, record);
        try {
          assert.deepStrictEqual(yield* readDevRunnerPidFile(baseDir), {
            path: written.path,
            record,
          });
          assert.strictEqual(yield* readDevRunnerPidFile(`${baseDir}-missing`), null);
        } finally {
          yield* Effect.promise(() => fs.rm(baseDir, { recursive: true, force: true }));
        }
      }),
    );

    it("rejects malformed pid records", () => {
      assert.strictEqual(parseDevRunnerPidFile("not json"), null);
      assert.strictEqual(parseDevRunnerPidFile(JSON.stringify({ pid: "x" })), null);
      assert.strictEqual(
        parseDevRunnerPidFile(
          JSON.stringify({
            pid: 1,
            serverPort: 2,
            webPort: 3,
            baseDir: "/tmp/x",
            startedAt: "x",
          }),
        ),
        null,
      );
    });
  });

  describe("dev-runner process identity", () => {
    it("matches only dev-runner commands carrying the same home directory", () => {
      assert.strictEqual(
        devRunnerCommandMatchesHome(
          "node scripts/dev-runner.ts dev --home-dir /tmp/t3code-test-a",
          "/tmp/t3code-test-a",
        ),
        true,
      );
      assert.strictEqual(
        devRunnerCommandMatchesHome(
          "node scripts/dev-runner.ts dev --home-dir /tmp/t3code-test-a",
          "/tmp/t3code-test-b",
        ),
        false,
      );
      assert.strictEqual(
        devRunnerCommandMatchesHome("node apps/server/src/bin.ts", "/tmp/x"),
        false,
      );
    });

    it("orders kills leaves-first and tolerates cycles", () => {
      assert.deepStrictEqual(
        computeProcessTreeKillOrder(
          [
            { pid: 10, ppid: 1, command: "dev-runner" },
            { pid: 11, ppid: 10, command: "vp" },
            { pid: 12, ppid: 11, command: "node server" },
            { pid: 13, ppid: 11, command: "node web" },
            { pid: 99, ppid: 1, command: "unrelated" },
          ],
          10,
        ),
        [12, 13, 11, 10],
      );
      assert.deepStrictEqual(
        computeProcessTreeKillOrder([{ pid: 7, ppid: 7, command: "x" }], 7),
        [7],
      );
      assert.deepStrictEqual(computeProcessTreeKillOrder([], 424242), []);
    });
  });

  describe("stopDevEnvironment", () => {
    const livePid = 424243;
    const staleRecord = (baseDir: string) => ({
      path: `${baseDir}/dev-runner.pid`,
      record: {
        pid: livePid,
        serverPort: 1,
        webPort: 2,
        baseDir,
        startedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    const operatorFor = (options: { live: boolean; command: string | null }) => ({
      isLive: () => Effect.succeed(options.live),
      commandOf: () => Effect.succeed(options.command),
      killTree: () => Effect.succeed([livePid] as const),
    });

    it.effect("reports missing pidfiles without touching processes", () =>
      Effect.gen(function* () {
        const kills: Array<number> = [];
        const exit = yield* Effect.exit(
          stopDevEnvironment({
            baseDir: "/tmp/t3code-test-missing",
            readPidFile: () => Effect.succeed(null),
            removePidFile: () => Effect.sync(() => kills.push(-1)).pipe(Effect.as(undefined)),
            operator: {
              isLive: () => Effect.succeed(true),
              commandOf: () => Effect.succeed(null),
              killTree: (pid: number) =>
                Effect.sync(() => kills.push(pid)).pipe(Effect.as([] as const)),
            },
          }),
        );
        assert.isTrue(exit._tag === "Failure");
        assert.deepStrictEqual(kills, []);
      }),
    );

    it.effect("clears stale pidfiles without killing anything", () =>
      Effect.gen(function* () {
        const removed: Array<string> = [];
        const result = yield* stopDevEnvironment({
          baseDir: "/tmp/t3code-test-stale",
          readPidFile: () => Effect.succeed(staleRecord("/tmp/t3code-test-stale")),
          removePidFile: (path: string) =>
            Effect.sync(() => {
              removed.push(path);
            }),
          operator: operatorFor({ live: false, command: null }),
        });
        assert.deepStrictEqual(result, { stopped: false, reason: "not-running", killed: [] });
        assert.deepStrictEqual(removed, ["/tmp/t3code-test-stale/dev-runner.pid"]);
      }),
    );

    it.effect("refuses pidfiles that point at unrelated processes", () =>
      Effect.gen(function* () {
        const removed: Array<string> = [];
        const exit = yield* Effect.exit(
          stopDevEnvironment({
            baseDir: "/tmp/t3code-test-foreign",
            readPidFile: () => Effect.succeed(staleRecord("/tmp/t3code-test-foreign")),
            removePidFile: (path: string) =>
              Effect.sync(() => {
                removed.push(path);
              }),
            operator: operatorFor({ live: true, command: "node apps/server/src/bin.ts" }),
          }),
        );
        assert.isTrue(exit._tag === "Failure");
        assert.deepStrictEqual(removed, []);
      }),
    );

    it.effect("kills the recorded tree for a live dev server", () =>
      Effect.gen(function* () {
        const killed: Array<number> = [];
        const removed: Array<string> = [];
        const result = yield* stopDevEnvironment({
          baseDir: "/tmp/t3code-test-live",
          readPidFile: () => Effect.succeed(staleRecord("/tmp/t3code-test-live")),
          removePidFile: (path: string) =>
            Effect.sync(() => {
              removed.push(path);
            }),
          operator: {
            isLive: () => Effect.succeed(true),
            commandOf: () =>
              Effect.succeed("node scripts/dev-runner.ts dev --home-dir /tmp/t3code-test-live"),
            killTree: (pid: number) =>
              Effect.sync(() => {
                killed.push(pid);
              }).pipe(Effect.as([pid, pid + 1] as const)),
          },
        });
        assert.deepStrictEqual(result, {
          stopped: true,
          killed: [livePid, livePid + 1],
        });
        assert.deepStrictEqual(killed, [livePid]);
        assert.deepStrictEqual(removed, ["/tmp/t3code-test-live/dev-runner.pid"]);
      }),
    );
  });
});
