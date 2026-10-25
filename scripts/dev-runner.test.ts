// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  checkPortAvailabilityOnHosts,
  createDevRunnerEnv,
  findFirstAvailableOffset,
  resolveModePortOffsets,
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
  built: false,
  runArgs: ["--inspect", "secret-token-value"],
} as const;

it.layer(NodeServices.layer)("dev-runner", (it) => {
  describe("createDevRunnerEnv", () => {
    it.effect("forwards the reusable auth token to web dev and removes it for desktop", () =>
      Effect.gen(function* () {
        const input = {
          baseEnv: { T3CODE_DEV_AUTH_TOKEN: "reusable-dev-auth-token-that-is-long-enough" },
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const web = yield* createDevRunnerEnv({ ...input, mode: "dev" });
        const desktop = yield* createDevRunnerEnv({ ...input, mode: "dev:desktop" });

        assert.equal(web.T3CODE_DEV_AUTH_TOKEN, input.baseEnv.T3CODE_DEV_AUTH_TOKEN);
        assert.equal(desktop.T3CODE_DEV_AUTH_TOKEN, undefined);
      }),
    );

    it.effect("turns product analytics off unless the developer opts in", () =>
      Effect.gen(function* () {
        const input = {
          mode: "dev",
          serverOffset: 0,
          webOffset: 0,
          t3Home: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const byDefault = yield* createDevRunnerEnv({ ...input, baseEnv: {} });
        const optedIn = yield* createDevRunnerEnv({
          ...input,
          baseEnv: { T3CODE_TELEMETRY_ENABLED: "true" },
        });

        assert.equal(byDefault.T3CODE_TELEMETRY_ENABLED, "false");
        assert.equal(optedIn.T3CODE_TELEMETRY_ENABLED, "true");
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

    it.effect.each(["dev", "dev:web"] as const)(
      "leaves the client backend URLs unset in %s mode",
      (mode) =>
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
          assert.equal(env.T3CODE_SINGLE_ORIGIN_DEV, "1");
        }),
    );

    it.effect.each(["dev", "dev:web"] as const)("drops an inherited HOST in %s mode", (mode) =>
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
  });

  describe("findFirstAvailableOffset", () => {
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
  });

  describe("runDevRunnerWithInput", () => {
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
          Effect.provideService(HostProcess.Platform, "linux"),
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
          Effect.provideService(HostProcess.Platform, "linux"),
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

    // A shared origin means a remote browser, where unbundled dev's
    // per-module waterfall pays a tailnet round trip per import level. The
    // runner defaults bundled dev on for the spawned stack, but only
    // defaults: an explicit T3CODE_BUNDLED_DEV (even "0") must pass through.
    describe("--share spawn wiring", () => {
      const shareSpawned = (input: {
        readonly ambientBundledDev?: string | undefined;
        readonly built?: boolean;
        readonly host?: string;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          let vpArgs: ReadonlyArray<string> = [];
          const tailscaleCalls: Array<ReadonlyArray<string>> = [];
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
                vpArgs = spawned.args;
                return Effect.succeed(mockProcess(0));
              }
              tailscaleCalls.push(spawned.args);
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
            built: input.built ?? false,
            host: input.host,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(
              HostProcess.Environment,
              input.ambientBundledDev === undefined
                ? {}
                : { T3CODE_BUNDLED_DEV: input.ambientBundledDev },
            ),
          );

          return { env: captured, vpArgs, tailscaleCalls };
        });

      it.effect("keeps an explicit T3CODE_BUNDLED_DEV=0 opt-out", () =>
        Effect.gen(function* () {
          const { env } = yield* shareSpawned({ ambientBundledDev: "0" });
          assert.equal(env?.T3CODE_BUNDLED_DEV, "0");
        }),
      );

      it.effect("--built serves the backend on the web port's tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({ built: true });
          assert.include(vpArgs, "dev:built");
          assert.equal(env?.T3CODE_BUILT_DEV, "1");
          assert.equal(env?.T3CODE_BUNDLED_DEV, undefined);
          assert.equal(env?.VITE_DEV_SERVER_URL, `https://host.example.ts.net:${env?.PORT}/`);
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.deepEqual(serve?.slice(-2), [
            `--https=${env?.PORT}`,
            `http://127.0.0.1:${env?.T3CODE_PORT}`,
          ]);
        }),
      );

      it.effect("--built --host ::1 targets the backend's IPv6 loopback", () =>
        Effect.gen(function* () {
          const { env, tailscaleCalls } = yield* shareSpawned({ built: true, host: "::1" });
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://[::1]:${env?.T3CODE_PORT}`);
        }),
      );

      it.effect("without --built keeps Vite behind the tailnet URL", () =>
        Effect.gen(function* () {
          const { env, vpArgs, tailscaleCalls } = yield* shareSpawned({});
          assert.include(vpArgs, "dev");
          assert.notInclude(vpArgs, "dev:built");
          assert.equal(env?.T3CODE_BUNDLED_DEV, "1");
          const serve = tailscaleCalls.find((args) => args.includes("--bg"));
          assert.equal(serve?.at(-1), `http://localhost:${env?.PORT}`);
        }),
      );
    });

    it.effect.each([
      { mode: "dev", share: false },
      { mode: "dev:web", share: true },
      { mode: "dev:desktop", share: true },
    ] as const)("rejects --built for $mode with share=$share", ({ mode, share }) => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode,
          port: undefined,
          share,
          built: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.flip,
        );

        assert.equal(error._tag, "DevRunnerBuiltNeedsShareError");
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
          Effect.provideService(HostProcess.Platform, "linux"),
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
            Effect.provideService(HostProcess.Platform, "linux"),
            Effect.provideService(HostProcess.WorkingDirectory, input.cwd),
            // No ~/.t3 here, so these runs never seed from this machine's install.
            Effect.provideService(HostProcess.HomeDirectory, input.cwd),
            Effect.provideService(
              HostProcess.Environment,
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

      it.effect("seeds a worktree database from ~/.t3 only when it has none", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = path.join(root, "home");
          NodeFS.mkdirSync(path.join(home, ".t3", "userdata"), { recursive: true });
          NodeFS.writeFileSync(path.join(home, ".t3", "userdata", "statev2.sqlite"), "");

          const spawnedArgs = (seed: boolean | undefined) =>
            Effect.gen(function* () {
              const spawned: Array<ReadonlyArray<string>> = [];
              const spawnerLayer = Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) => {
                  spawned.push(
                    (command as unknown as { readonly args: ReadonlyArray<string> }).args,
                  );
                  return Effect.succeed(mockProcess(0));
                }),
              );
              yield* runDevRunnerWithInput({ ...devServerInput, t3Home: undefined, seed }).pipe(
                Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
                Effect.provideService(HostProcess.Platform, "linux"),
                Effect.provideService(HostProcess.WorkingDirectory, root),
                Effect.provideService(HostProcess.HomeDirectory, home),
                Effect.provideService(HostProcess.Environment, {}),
              );
              return spawned.filter((args) =>
                args.some((arg) => arg.endsWith("migrate-dev-db.ts")),
              );
            });

          assert.deepStrictEqual(yield* spawnedArgs(false), []);
          const [seedArgs] = yield* spawnedArgs(undefined);
          assert.includeMembers([...(seedArgs ?? [])], ["--base-dir", path.join(root, ".t3")]);

          // Either database means the worktree already has data.
          for (const name of ["state.sqlite", "statev2.sqlite"]) {
            const file = path.join(root, ".t3", "userdata", name);
            NodeFS.mkdirSync(path.dirname(file), { recursive: true });
            NodeFS.writeFileSync(file, "");
            assert.deepStrictEqual(yield* spawnedArgs(undefined), []);
            NodeFS.rmSync(file);
          }
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
    });
  });
});
