import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as RelayClient from "@t3tools/shared/relayClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG, encodeEndpointRuntimeConfigJson } from "./config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const relayClientAvailableLayer = Layer.succeed(
  RelayClient.RelayClient,
  RelayClient.RelayClient.of({
    resolve: Effect.succeed({
      status: "available",
      executablePath: "cloudflared",
      source: "path",
      version: RelayClient.CLOUDFLARED_VERSION,
    }),
    install: Effect.die("unused"),
    installWithProgress: () => Effect.die("unused"),
  }),
);

const runtimeDependencies = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = relayClientAvailableLayer,
) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    relayClientLayer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeed(Option.none()),
    }),
  );

const buildCloudManagedEndpointRuntime = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = relayClientAvailableLayer,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(runtimeDependencies(spawner, relayClientLayer)),
      ),
    );
    return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
  });

function makeHandle(input: {
  readonly pid: number;
  readonly onKill: () => void;
  readonly isRunning?: () => boolean;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly all?: ChildProcessSpawner.ChildProcessHandle["all"];
}) {
  const stopped = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>();
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: (input.exitCode ?? Effect.never).pipe(Effect.race(Deferred.await(stopped))),
    isRunning: Effect.sync(() => input.isRunning?.() ?? true),
    kill: () =>
      Effect.sync(() => {
        input.onKill();
      }).pipe(Effect.andThen(Deferred.succeed(stopped, ChildProcessSpawner.ExitCode(0)))),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all:
      input.all ??
      Stream.make(
        new TextEncoder().encode(
          "2026-08-27T10:00:00Z INF Registered tunnel connection connIndex=0\n",
        ),
      ),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("CloudManagedEndpointRuntime", () => {
  it.effect.each([
    { change: "replacement", maxOps: 64 },
    { change: "replacement", maxOps: 2048 },
    { change: "disable", maxOps: 64 },
    { change: "disable", maxOps: 2048 },
  ])(
    "does not report a stopped connector after $change with scheduling budget $maxOps",
    ({ change, maxOps }) =>
      Effect.gen(function* () {
        const receipts: Array<string> = [];
        let count = 0;
        const spawner = ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const pid = 710 + count++;
            const handle = makeHandle({
              pid,
              isRunning: () => !receipts.includes(`killed-${pid}`),
              onKill: () => receipts.push(`killed-${pid}`),
            });
            yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
            return handle;
          }),
        );
        const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
        const config = {
          providerKind: "cloudflare_tunnel" as const,
          connectorToken: "first",
          tunnelId: "old-tunnel",
        };
        expect(yield* runtime.applyConfig(config)).toMatchObject({ status: "running", pid: 710 });
        const replacement =
          change === "disable"
            ? null
            : { ...config, connectorToken: "replacement", tunnelId: "new-tunnel" };
        const statuses = yield* Effect.all(
          [
            runtime
              .applyConfig(config)
              .pipe(
                Effect.tap((status) => Effect.sync(() => receipts.push(`first-${status.status}`))),
              ),
            runtime
              .applyConfig(replacement)
              .pipe(
                Effect.tap((status) => Effect.sync(() => receipts.push(`second-${status.status}`))),
              ),
          ],
          { concurrency: 2 },
        );
        expect(statuses[1]).toMatchObject(
          change === "disable"
            ? { status: "disabled" }
            : { status: "running", pid: 711, tunnelId: "new-tunnel" },
        );
        expect(statuses[0]).toMatchObject({ tunnelId: "old-tunnel" });
        expect(receipts).toContain("killed-710");
        if (statuses[0].status === "running") {
          expect(statuses[0].pid).toBe(710);
          expect(receipts.indexOf("first-running")).toBeLessThan(receipts.indexOf("killed-710"));
        } else {
          expect(statuses[0]).toMatchObject({
            status: "failed",
            reason: "Relay client configuration changed before its connection could be confirmed.",
          });
        }
        // Default scheduling and a shorter operation budget exercise both request
        // orderings without delaying process finalizers or sleeping in the fixture.
      }).pipe(Effect.provideService(References.MaxOpsBeforeYield, maxOps)),
  );
  it.effect("does not report registration as ready when the child is no longer running", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({ pid: 720, isRunning: () => false, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      expect(
        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "stopped",
          tunnelId: "stopped-tunnel",
        }),
      ).toEqual({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        tunnelId: "stopped-tunnel",
        reason: "Relay client is no longer running or its status could not be confirmed.",
      });
    }),
  );
  it.effect("a live owned child is not ready until its real output reports registration", () =>
    Effect.gen(function* () {
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const warningObserved = yield* Deferred.make<void>();
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          expect(ChildProcess.isStandardCommand(command)).toBe(true);
          if (!ChildProcess.isStandardCommand(command))
            return yield* Effect.die("standard command required");
          expect(command.args).toEqual(["tunnel", "run"]);
          expect(command.options.env?.TUNNEL_TOKEN).toBe("audit-synthetic-token");
          spawnCount += 1;
          // This child owns no sockets and cannot contact a relay. Its real pipes
          // model a running connector whose registration arrives after a timeout.
          const child = yield* nativeSpawner.spawn(
            ChildProcess.make(
              process.execPath,
              [
                "-e",
                [
                  "process.stdin.resume();",
                  "process.stdout.write('WRN transport connection unavailable\\n');",
                  "process.stdin.once('data', () => process.stdout.write('INF Registered tunnel connection connIndex=0\\n'));",
                ].join("\n"),
              ],
              { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
            ),
          );
          yield* Deferred.succeed(spawned, child);
          return ChildProcessSpawner.makeHandle({
            ...child,
            all: child.all.pipe(Stream.tap(() => Deferred.succeed(warningObserved, undefined))),
          });
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "audit-synthetic-token",
        tunnelId: "audit-owned-child",
      };
      const applying = yield* runtime.applyConfig(config).pipe(Effect.forkChild);
      const child = yield* Deferred.await(spawned);
      yield* Deferred.await(warningObserved);
      expect(yield* child.isRunning).toBe(true);
      yield* TestClock.adjust("15 seconds");
      const beforeRegistration = yield* Fiber.join(applying);
      expect(beforeRegistration).toMatchObject({ status: "failed", tunnelId: "audit-owned-child" });
      expect(yield* child.isRunning).toBe(true);
      yield* Stream.make(new TextEncoder().encode("register\n")).pipe(
        Stream.concat(Stream.never),
        Stream.run(child.stdin),
        Effect.forkChild,
      );
      const registered = yield* runtime.applyConfig(config);
      expect(registered).toMatchObject({ status: "running", pid: Number(child.pid) });
      expect(spawnCount).toBe(1);
      expect(yield* child.isRunning).toBe(true);
      expect(yield* runtime.applyConfig(null)).toEqual({ status: "disabled" });
      yield* Effect.result(child.exitCode);
      expect(yield* child.isRunning).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
  );
  it("classifies Cloudflare connection and warning output", () => {
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0",
      ),
    ).toBe("connected");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z ERR Failed to serve tunnel connection",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Starting metrics server",
      ),
    ).toBe("debug");
    // FTL (fatal) and PNC (panic) are more severe than ERR and must surface.
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z FTL Cannot determine default origin certificate path",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput("2026-06-17T02:00:00Z PNC runtime panic"),
    ).toBe("warning");
  });

  it.effect("starts, deduplicates, rotates, and stops the Cloudflare connector", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.StandardCommand> = [];
      const killed: Array<number> = [];
      let nextPid = 100;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected standard command.");
          }
          spawned.push(command);
          const pid = nextPid;
          nextPid += 1;
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-2",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      const stopped = yield* runtime.applyConfig(null);

      expect(spawned.map((command) => command.command)).toEqual(["cloudflared", "cloudflared"]);
      expect(spawned.map((command) => command.args)).toEqual([
        ["tunnel", "run"],
        ["tunnel", "run"],
      ]);
      expect(spawned.map((command) => command.options.env?.TUNNEL_TOKEN)).toEqual([
        "token-1",
        "token-2",
      ]);
      expect(spawned.map((command) => command.options.stdout)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.stderr)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.detached)).toEqual([false, false]);
      expect(spawned.map((command) => command.options.shell)).toEqual([false, false]);
      expect(killed).toEqual([100, 101]);
      expect(stopped).toEqual({ status: "disabled" });
    }),
  );

  it.effect("stops an active connector when a non-Cloudflare runtime config is applied", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 200,
            onKill: () => {
              killed.push(200);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      const unsupported = yield* runtime.applyConfig({
        providerKind: "manual",
        connectorToken: "manual-token",
      });

      expect(started.status).toBe("running");
      expect(unsupported).toEqual({ status: "unsupported", providerKind: "manual" });
      expect(killed).toEqual([200]);
    }),
  );

  it.effect("restarts the connector when the active process has exited", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      let firstRunning = true;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 300 : 301;
          spawned.push(pid);
          const handle = makeHandle({
            pid,
            isRunning: () => (pid === 300 ? firstRunning : true),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      const first = yield* runtime.applyConfig(config);
      firstRunning = false;
      const second = yield* runtime.applyConfig(config);

      expect(first).toMatchObject({ status: "running", pid: 300 });
      expect(second).toMatchObject({ status: "running", pid: 301 });
      expect(spawned).toEqual([300, 301]);
      expect(killed).toEqual([300]);
    }),
  );

  it.effect("supervises the active connector and restarts it after process exit", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const secondSpawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 400 : 401;
          spawned.push(pid);
          if (pid === 401) {
            yield* Deferred.succeed(secondSpawned, undefined);
          }
          const handle = makeHandle({
            pid,
            exitCode:
              pid === 400
                ? Deferred.await(firstExit)
                : (Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(secondSpawned);

      expect(started).toMatchObject({ status: "running", pid: 400 });
      expect(spawned).toEqual([400, 401]);
      expect(killed).toEqual([400]);
    }),
  );

  const makeCrashLoopSpawner = (basePid: number, slots: number) =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
      const spawnSignals: Array<Deferred.Deferred<void>> = [];
      for (let index = 0; index < slots; index += 1) {
        exits.push(yield* Deferred.make<ChildProcessSpawner.ExitCode>());
        spawnSignals.push(yield* Deferred.make<void>());
      }
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const index = spawned.length;
          spawned.push(basePid + index);
          yield* Deferred.succeed(spawnSignals[index]!, undefined);
          const handle = makeHandle({
            pid: basePid + index,
            exitCode: Deferred.await(exits[index]!),
            onKill: () => {},
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      return { spawner, spawned, exits, spawnSignals };
    });

  it.effect("backs off restarts while the connector crash-loops", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(600, 4);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      expect(spawned).toEqual([600]);

      // The first crash restarts immediately.
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);
      expect(spawned).toEqual([600, 601]);

      // The second rapid crash waits out the base delay before restarting.
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(999));
      expect(spawned).toEqual([600, 601]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[2]!);
      expect(spawned).toEqual([600, 601, 602]);

      // The third rapid crash doubles the delay.
      yield* Deferred.succeed(exits[2]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(1999));
      expect(spawned).toEqual([600, 601, 602]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[3]!);
      expect(spawned).toEqual([600, 601, 602, 603]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resets the backoff after the connector runs stably", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(700, 5);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      // One rapid crash arms the backoff.
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);

      // The replacement stays up past the stable-uptime window, so its exit
      // restarts immediately and the backoff starts over.
      yield* TestClock.adjust(Duration.millis(30_000));
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[2]!);
      yield* Deferred.succeed(exits[2]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[3]!);

      // The next rapid crash waits the base delay again, not a doubled one.
      yield* Deferred.succeed(exits[3]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(999));
      expect(spawned).toEqual([700, 701, 702, 703]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[4]!);
      expect(spawned).toEqual([700, 701, 702, 703, 704]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an explicit config change clears the backoff and preempts a delayed restart", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(800, 3);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
      });
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);

      // Leave the supervisor sleeping on the base delay, then change config.
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-2",
      });
      expect(status).toMatchObject({ status: "running", pid: 802 });
      expect(spawned).toEqual([800, 801, 802]);

      // The preempted supervisor wakes later and must not spawn a duplicate.
      yield* TestClock.adjust(Duration.millis(60_000));
      expect(spawned).toEqual([800, 801, 802]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not block config changes while a restarted connector registers", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const firstExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const secondSpawned = yield* Deferred.make<void>();
      const secondRegistration = yield* Deferred.make<void>();
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          spawnCount += 1;
          const pid = 410 + spawnCount;
          if (spawnCount === 2) {
            yield* Deferred.succeed(secondSpawned, undefined);
          }
          const handle = makeHandle({
            pid,
            ...(spawnCount === 1
              ? {}
              : {
                  all: Stream.fromEffect(Deferred.await(secondRegistration)).pipe(
                    Stream.map(() =>
                      new TextEncoder().encode(
                        "2026-08-27T10:00:00Z INF Registered tunnel connection connIndex=0\n",
                      ),
                    ),
                  ),
                }),
            exitCode:
              spawnCount === 1
                ? Deferred.await(firstExit)
                : (Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(secondSpawned);

      const stopped = yield* runtime.applyConfig(null);
      expect(stopped).toEqual({ status: "disabled" });
      expect(killed).toEqual([411, 412]);
    }),
  );

  it.effect("serializes concurrent connector config changes", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstSpawnEntered = yield* Deferred.make<void>();
      const releaseFirstSpawn = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 500 + spawned.length;
          spawned.push(pid);
          if (pid === 500) {
            yield* Deferred.succeed(firstSpawnEntered, undefined);
            yield* Deferred.await(releaseFirstSpawn);
          }
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const first = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSpawnEntered);
      const second = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-2",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseFirstSpawn, undefined);

      yield* Fiber.join(first);
      const status = yield* Fiber.join(second);

      expect(status).toMatchObject({ status: "running", pid: 501 });
      expect(spawned).toEqual([500, 501]);
      expect(killed).toEqual([500]);
    }),
  );

  it.effect("does not report a running connector before Cloudflare registers it", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const registerConnection = yield* Deferred.make<void>();
      const outputStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 600,
            all: Stream.fromEffect(
              Deferred.succeed(outputStarted, undefined).pipe(
                Effect.andThen(Deferred.await(registerConnection)),
              ),
            ).pipe(
              Stream.map(() =>
                new TextEncoder().encode(
                  "2026-08-27T10:00:00Z INF Registered tunnel connection connIndex=0\n",
                ),
              ),
              Stream.concat(Stream.never),
            ),
            onKill: () => {
              killed.push(600);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const statusFiber = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-secret",
          tunnelId: "tunnel-1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(outputStarted);

      expect(statusFiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("15 seconds");
      const status = yield* Fiber.join(statusFiber);

      expect(status).toMatchObject({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason:
          "Relay client did not register a tunnel connection within 15 seconds. Check whether the network allows outbound TCP and UDP traffic on port 7844.",
        tunnelId: "tunnel-1",
      });
      expect(killed).toEqual([]);

      yield* Deferred.succeed(registerConnection, undefined);
      const recovered = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-secret",
        tunnelId: "tunnel-1",
      });

      expect(recovered).toMatchObject({
        status: "running",
        pid: 600,
        tunnelId: "tunnel-1",
      });
      expect(killed).toEqual([]);
    }),
  );

  it.effect("restarts a connector that exits before Cloudflare registers it", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      let spawnCount = 0;
      const secondSpawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          spawnCount += 1;
          const pid = 600 + spawnCount;
          const handle = makeHandle({
            pid,
            ...(spawnCount === 1
              ? {
                  all: Stream.never,
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                }
              : {}),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          if (spawnCount === 2) {
            yield* Deferred.succeed(secondSpawned, undefined);
          }
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-secret",
        tunnelId: "tunnel-1",
      });

      expect(status).toMatchObject({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason: "Relay client exited before it registered a tunnel connection.",
        tunnelId: "tunnel-1",
      });
      yield* Deferred.await(secondSpawned);
      const recovered = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-secret",
        tunnelId: "tunnel-1",
      });

      expect(recovered).toMatchObject({
        status: "running",
        providerKind: "cloudflare_tunnel",
        pid: 602,
        tunnelId: "tunnel-1",
      });
      expect(killed).toEqual([601]);
    }),
  );

  it.effect("stops a connector when its first configuration is interrupted during spawn", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const processStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 602,
            onKill: () => {
              killed.push(602);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          yield* Deferred.succeed(processStarted, undefined);
          return yield* Effect.never;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const statusFiber = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-secret",
          tunnelId: "tunnel-1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(processStarted);
      yield* Fiber.interrupt(statusFiber);

      expect(killed).toEqual([602]);
    }),
  );

  it.effect("clears a pending explicit config within the shutdown release deadline", () =>
    Effect.gen(function* () {
      const outputStarted = yield* Deferred.make<void>();
      const stoppedAt = yield* Deferred.make<number>();
      const killed: Array<number> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 603,
            all: Stream.fromEffect(Deferred.succeed(outputStarted, undefined)).pipe(
              Stream.flatMap(() => Stream.never),
            ),
            onKill: () => {
              killed.push(603);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const pending = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-pending",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(outputStarted);
      const stoppingAt = yield* Clock.currentTimeMillis;
      const stop = yield* runtime.applyConfig(null).pipe(
        Effect.tap(() =>
          Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Deferred.succeed(stoppedAt, now))),
        ),
        Effect.timeoutOption("10 seconds"),
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const stopped = yield* Fiber.join(stop);
      yield* Fiber.interrupt(pending);
      expect(stopped).toEqual(Option.some({ status: "disabled" }));
      expect(yield* Deferred.await(stoppedAt)).toBe(stoppingAt);
      expect(killed).toEqual([603]);
    }),
  );

  it.effect("stops a connector when its first configuration is interrupted", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const outputStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 602,
            all: Stream.fromEffect(Deferred.succeed(outputStarted, undefined)).pipe(
              Stream.flatMap(() => Stream.never),
            ),
            onKill: () => {
              killed.push(602);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const statusFiber = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-secret",
          tunnelId: "tunnel-1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(outputStarted);
      yield* Fiber.interrupt(statusFiber);

      expect(killed).toEqual([602]);
    }),
  );

  it.effect("cancelling a reused registration wait does not take ownership of its child", () =>
    Effect.gen(function* () {
      const registration = yield* Deferred.make<void>();
      const outputStarted = yield* Deferred.make<void>();
      const reused = yield* Deferred.make<void>();
      const killed: Array<number> = [];
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          spawnCount += 1;
          const handle = makeHandle({
            pid: 610,
            all: Stream.fromEffect(Deferred.succeed(outputStarted, undefined)).pipe(
              Stream.flatMap(() => Stream.fromEffect(Deferred.await(registration))),
              Stream.map(() => new TextEncoder().encode("INF Registered tunnel connection\n")),
            ),
            onKill: () => {
              killed.push(610);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return ChildProcessSpawner.makeHandle({
            ...handle,
            isRunning: Deferred.succeed(reused, undefined).pipe(Effect.as(true)),
          });
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = { providerKind: "cloudflare_tunnel" as const, connectorToken: "shared-token" };
      const owner = yield* runtime.applyConfig(config).pipe(Effect.forkChild);
      yield* Deferred.await(outputStarted);
      const reuser = yield* runtime.applyConfig(config).pipe(Effect.forkChild);
      yield* Deferred.await(reused);
      yield* Fiber.interrupt(reuser);
      expect(killed).toEqual([]);
      yield* Deferred.succeed(registration, undefined);
      expect(yield* Fiber.join(owner)).toMatchObject({ status: "running", pid: 610 });
      expect(spawnCount).toBe(1);
    }),
  );

  it.effect("cancelling an old registration wait never stops its replacement", () =>
    Effect.gen(function* () {
      const outputStarted = yield* Deferred.make<void>();
      const killed: Array<number> = [];
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 620 + spawnCount++;
          const handle = makeHandle({
            pid,
            ...(pid === 620
              ? {
                  all: Stream.fromEffect(Deferred.succeed(outputStarted, undefined)).pipe(
                    Stream.flatMap(() => Stream.never),
                  ),
                }
              : {}),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          // Hold the old wait's exit delivery to exercise cancellation after
          // replacement, independently of the supervisor's scheduling.
          return pid === 620
            ? ChildProcessSpawner.makeHandle({ ...handle, exitCode: Effect.never })
            : handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const previous = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "old-token",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(outputStarted);
      const nextConfig = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "new-token",
      };
      expect(yield* runtime.applyConfig(nextConfig)).toMatchObject({ status: "running", pid: 621 });
      yield* Fiber.interrupt(previous);
      expect(killed).toEqual([620]);
      expect(yield* runtime.applyConfig(nextConfig)).toMatchObject({ status: "running", pid: 621 });
      expect(spawnCount).toBe(2);
    }),
  );

  it.effect("cancels a queued apply without waiting for another caller's spawn", () =>
    Effect.gen(function* () {
      const spawning = yield* Deferred.make<void>();
      const releaseSpawn = yield* Deferred.make<void>();
      const queuedStarted = yield* Deferred.make<void>();
      const killed: Array<number> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(spawning, undefined);
          yield* Deferred.await(releaseSpawn);
          const handle = makeHandle({
            pid: 630,
            onKill: () => {
              killed.push(630);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const first = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "first-token",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(spawning);
      const queued = yield* Deferred.succeed(queuedStarted, undefined).pipe(
        Effect.andThen(runtime.applyConfig(null)),
        Effect.forkChild,
      );
      yield* Deferred.await(queuedStarted);
      yield* Fiber.interrupt(queued);
      expect(killed).toEqual([]);
      yield* Deferred.succeed(releaseSpawn, undefined);
      expect(yield* Fiber.join(first)).toMatchObject({ status: "running", pid: 630 });
    }),
  );

  it.effect("builds the layer without waiting for a persisted config to register", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const spawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 700,
            all: Stream.never,
            onKill: () => {
              killed.push(700);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          yield* Deferred.succeed(spawned, undefined);
          return handle;
        }),
      );
      const configJson = yield* encodeEndpointRuntimeConfigJson({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-secret",
        tunnelId: "tunnel-1",
      });
      const secretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) =>
          Effect.succeed(
            name === CLOUD_ENDPOINT_RUNTIME_CONFIG
              ? Option.some(new TextEncoder().encode(configJson))
              : Option.none(),
          ),
      });

      const scope = yield* Scope.make("sequential");
      yield* Layer.build(
        ManagedEndpointRuntime.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              relayClientAvailableLayer,
              secretStoreLayer,
            ),
          ),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      yield* Deferred.await(spawned);
      yield* Scope.close(scope, Exit.void);

      expect(killed).toEqual([700]);
    }),
  );

  it.effect("stops the boot connector without waiting for it to register", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const spawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 701,
            all: Stream.never,
            onKill: () => {
              killed.push(701);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          yield* Deferred.succeed(spawned, undefined);
          return handle;
        }),
      );
      const configJson = yield* encodeEndpointRuntimeConfigJson({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-secret",
        tunnelId: "tunnel-1",
      });
      const secretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) =>
          Effect.succeed(
            name === CLOUD_ENDPOINT_RUNTIME_CONFIG
              ? Option.some(new TextEncoder().encode(configJson))
              : Option.none(),
          ),
      });

      const scope = yield* Scope.make("sequential");
      const context = yield* Layer.build(
        ManagedEndpointRuntime.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              relayClientAvailableLayer,
              secretStoreLayer,
            ),
          ),
        ),
      ).pipe(Effect.provideService(Scope.Scope, scope));
      const runtime = yield* Effect.service(
        ManagedEndpointRuntime.CloudManagedEndpointRuntime,
      ).pipe(Effect.provide(context));
      yield* Deferred.await(spawned);

      // The shutdown tunnel release runs this call under a 10 second timeout.
      // It must not queue behind a boot apply that waits for registration.
      const stopped = yield* runtime.applyConfig(null);

      expect(stopped).toEqual({ status: "disabled" });
      expect(killed).toEqual([701]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("reports connector spawn failures", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "cloudflared missing",
          }),
        ),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });

      expect(status).toMatchObject({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        tunnelId: "tunnel-1",
      });
    }),
  );

  it.effect("reports a missing relay client executable without spawning", () =>
    Effect.gen(function* () {
      const spawn = vi.fn();
      const spawner = ChildProcessSpawner.make(spawn);
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.die("unused"),
            installWithProgress: () => Effect.die("unused"),
          }),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      expect(status).toEqual({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason: "The relay client is not installed.",
      });
      expect(spawn).not.toHaveBeenCalled();
    }),
  );
});
