import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const layerRelayClientAvailable = Layer.succeed(
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
    pruneManagedVersions: Effect.void,
  }),
);

const runtimeDependencies = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    relayClientLayer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeedNone,
    }),
  );

const buildCloudManagedEndpointRuntime = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
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
  readonly output?: Stream.Stream<Uint8Array>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.sync(() => input.isRunning?.() ?? true),
    kill: () =>
      Effect.sync(() => {
        input.onKill();
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: input.output ?? Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("CloudManagedEndpointRuntime", () => {
  it("retries connector startup failures but stops for unsupported runtimes", () => {
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({
        status: "failed",
        failure: "not-installed",
        reason: "The relay client is not installed.",
      }),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({
        status: "failed",
        failure: "spawn-failed",
        reason: "spawn failed",
      }),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({
        status: "failed",
        failure: "unsupported-platform",
        reason: "Relay client is unsupported on linux-arm.",
      }),
    ).toBe(false);
    expect(
      ManagedEndpointRuntime.isRetryableManagedEndpointRuntimeStatus({ status: "unsupported" }),
    ).toBe(false);
  });

  it.effect("serializes updates to persisted cloud link state", () =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(() => Effect.die("unused")),
      );

      const first = yield* runtime
        .withLinkStateLock(
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);

      const second = yield* runtime
        .withLinkStateLock(Deferred.succeed(secondEntered, undefined))
        .pipe(Effect.forkChild);
      expect(yield* Deferred.isDone(secondEntered)).toBe(false);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Deferred.isDone(secondEntered)).toBe(true);
    }),
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

  it("recognizes tunnel authorization failures without matching ordinary transport errors", () => {
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-09-15T06:30:43Z ERR Register tunnel error from server side error="Failed to get tunnel" connIndex=0 event=0 ip=198.41.200.23',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Register tunnel error from server side error="Unauthorized: Record for tunnel not found" connIndex=0',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Register tunnel error from server side error="Unauthorized: Invalid tunnel secret" connIndex=0',
      ),
    ).toBe(true);
    // Seen in production on 2026-10-06 after the relay deleted an idle tunnel.
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-10-06T12:00:00Z ERR Register tunnel error from server side error="Unauthorized: Tunnel not found" connIndex=0 event=0 ip=198.41.200.23',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-10-06T12:00:00Z ERR Register tunnel error from server side error="Tunnel not found" connIndex=0',
      ),
    ).toBe(true);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Register tunnel error from server side error="connection timed out" connIndex=0',
      ),
    ).toBe(false);
    expect(
      ManagedEndpointRuntime.isRejectedRelayClientTunnelOutput(
        '2026-06-17T02:00:00Z ERR Failed to serve tunnel connection error="Unauthorized: Tunnel not found" connIndex=0',
      ),
    ).toBe(false);
  });

  it.effect("keeps recovery requests sent before the server starts consuming them", () =>
    Effect.gen(function* () {
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(() => Effect.die("unused")),
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      yield* runtime.requestRecovery(config);

      expect(Option.getOrNull(yield* Stream.runHead(runtime.recoveryRequests))).toEqual(config);
    }),
  );

  it.effect("signals each registered tunnel connection", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 700,
            onKill: () => {},
            output: Stream.fromQueue(output),
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
      yield* Queue.offer(
        output,
        new TextEncoder().encode(
          "2026-10-04T06:30:43Z INF Registered tunnel connection connIndex=0 event=0\n",
        ),
      );
      expect(Option.isSome(yield* Stream.runHead(runtime.tunnelConnected))).toBe(true);
    }),
  );

  it.effect("recovers a rejected tunnel without waiting for the connector to exit", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const firstBatchObserved = yield* Deferred.make<void>();
      const secondBatchObserved = yield* Deferred.make<void>();
      const recoveryRequested = yield* Deferred.make<RelayManagedEndpointRuntimeConfig>();
      const recoveryRetried = yield* Deferred.make<RelayManagedEndpointRuntimeConfig>();
      let recoveryRequestCount = 0;
      const spawned: Array<number> = [];
      const encoder = new TextEncoder();
      const connectorOutput = Stream.fromQueue(output).pipe(
        Stream.tap((chunk) => {
          const line = new TextDecoder().decode(chunk);
          if (line === "first checkpoint\n") {
            return Deferred.succeed(firstBatchObserved, undefined).pipe(Effect.asVoid);
          }
          if (line === "second checkpoint\n") {
            return Deferred.succeed(secondBatchObserved, undefined).pipe(Effect.asVoid);
          }
          return Effect.void;
        }),
      );
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 600;
          spawned.push(pid);
          const handle = makeHandle({ pid, onKill: () => {}, output: connectorOutput });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "deleted-tunnel",
      };
      const rejectedLine =
        '2026-09-15T06:30:43Z ERR Register tunnel error from server side error="Failed to get tunnel" connIndex=0 event=0 ip=198.41.200.23\n';

      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((requested) => {
          recoveryRequestCount += 1;
          return Deferred.succeed(
            recoveryRequestCount === 1 ? recoveryRequested : recoveryRetried,
            requested,
          ).pipe(Effect.asVoid);
        }),
        Effect.forkChild,
      );
      yield* runtime.applyConfig(config);

      yield* Queue.offer(output, encoder.encode(rejectedLine.repeat(3)));
      yield* Queue.offer(output, encoder.encode("first checkpoint\n"));
      yield* Deferred.await(firstBatchObserved);
      expect(yield* Deferred.isDone(recoveryRequested)).toBe(false);

      yield* Queue.offer(
        output,
        encoder.encode(
          "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0\n" +
            rejectedLine.repeat(3),
        ),
      );
      yield* Queue.offer(output, encoder.encode("second checkpoint\n"));
      yield* Deferred.await(secondBatchObserved);
      expect(yield* Deferred.isDone(recoveryRequested)).toBe(false);

      yield* Queue.offer(output, encoder.encode(rejectedLine));

      expect(yield* Deferred.await(recoveryRequested)).toEqual(config);

      yield* Queue.offer(output, encoder.encode(rejectedLine.repeat(4)));

      expect(yield* Deferred.await(recoveryRetried)).toEqual(config);
      expect(spawned).toEqual([600]);
    }),
  );

  it.effect("requests recovery while the connector never registers a connection", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 800,
            onKill: () => {},
            output: Stream.fromQueue(output),
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const requests = yield* Queue.unbounded<RelayManagedEndpointRuntimeConfig>();
      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((config) => Queue.offer(requests, config)),
        Effect.forkChild,
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "silently-deleted",
      };
      yield* runtime.applyConfig(config);

      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* Queue.size(requests)).toBe(0);
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* Queue.take(requests)).toEqual(config);
      // Still unconnected, so it asks again.
      yield* TestClock.adjust(Duration.minutes(3));
      expect(yield* Queue.take(requests)).toEqual(config);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not request recovery once the connector has connected", () =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 801,
            onKill: () => {},
            output: Stream.fromQueue(output),
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const requests = yield* Queue.unbounded<RelayManagedEndpointRuntimeConfig>();
      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((config) => Queue.offer(requests, config)),
        Effect.forkChild,
      );
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Queue.offer(
        output,
        new TextEncoder().encode(
          "2026-10-06T00:00:00Z INF Registered tunnel connection connIndex=0\n",
        ),
      );
      yield* Stream.runHead(runtime.tunnelConnected);

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* Queue.size(requests)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

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
        ["tunnel", "--no-autoupdate", "--loglevel", "info", "--output", "default", "run"],
        ["tunnel", "--no-autoupdate", "--loglevel", "info", "--output", "default", "run"],
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

  it.effect("a recovery that returns the same config keeps the crash backoff", () =>
    Effect.gen(function* () {
      const { spawner, spawned, exits, spawnSignals } = yield* makeCrashLoopSpawner(900, 4);
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "same-token",
        tunnelId: "same-tunnel",
      };
      // The startup consumer re-applies whatever the relay hands back. When the
      // relay confirms the current tunnel, that must not look like a config change.
      yield* runtime.recoveryRequests.pipe(
        Stream.runForEach((requested) => runtime.applyConfig(requested).pipe(Effect.asVoid)),
        Effect.forkChild,
      );

      yield* runtime.applyConfig(config);
      yield* Deferred.succeed(exits[0]!, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(spawnSignals[1]!);
      expect(spawned).toEqual([900, 901]);

      // Second rapid crash still waits out the base delay.
      yield* Deferred.succeed(exits[1]!, ChildProcessSpawner.ExitCode(1));
      yield* TestClock.adjust(Duration.millis(999));
      expect(spawned).toEqual([900, 901]);
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.await(spawnSignals[2]!);
      expect(spawned).toEqual([900, 901, 902]);
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
            pruneManagedVersions: Effect.void,
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
        failure: "not-installed",
        reason: "The relay client is not installed.",
      });
      expect(spawn).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "runs an older relay client while the pinned one installs, then hands off to it and prunes",
    () =>
      Effect.gen(function* () {
        const olderClient = {
          status: "available",
          executablePath: "/managed/2025.9.0/cloudflared",
          source: "managed",
          version: "2025.9.0",
        } as const;
        const pinnedClient = {
          status: "available",
          executablePath: "/managed/pinned/cloudflared",
          source: "managed",
          version: RelayClient.CLOUDFLARED_VERSION,
        } as const;
        let installed = false;
        const releaseInstall = yield* Deferred.make<void>();
        const pruned = yield* Deferred.make<void>();
        const spawned = yield* Queue.unbounded<string>();
        const olderStopped = yield* Deferred.make<void>();
        const output = yield* Queue.unbounded<Uint8Array>();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const executable = ChildProcess.isStandardCommand(command) ? command.command : "";
            yield* Queue.offer(spawned, executable);
            const handle = makeHandle({
              pid: executable === pinnedClient.executablePath ? 2 : 1,
              onKill: () => {
                if (executable === olderClient.executablePath) {
                  Deferred.doneUnsafe(olderStopped, Effect.void);
                }
              },
              ...(executable === pinnedClient.executablePath
                ? { output: Stream.fromQueue(output) }
                : {}),
            });
            yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
            return handle;
          }),
        );
        const runtime = yield* buildCloudManagedEndpointRuntime(
          spawner,
          Layer.succeed(
            RelayClient.RelayClient,
            RelayClient.RelayClient.of({
              resolve: Effect.sync(() => (installed ? pinnedClient : olderClient)),
              install: Deferred.await(releaseInstall).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    installed = true;
                    return pinnedClient;
                  }),
                ),
              ),
              installWithProgress: () => Effect.die("unused"),
              pruneManagedVersions: Deferred.succeed(pruned, undefined).pipe(Effect.asVoid),
            }),
          ),
        );

        const status = yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
        });
        expect(status).toMatchObject({ status: "running", pid: 1 });
        expect(yield* Queue.take(spawned)).toBe(olderClient.executablePath);

        yield* Deferred.succeed(releaseInstall, undefined);
        expect(yield* Queue.take(spawned)).toBe(pinnedClient.executablePath);
        // The older connector keeps serving until the pinned one registers.
        expect(Option.isNone(yield* Deferred.poll(olderStopped))).toBe(true);

        yield* Queue.offer(
          output,
          new TextEncoder().encode(
            "2026-10-08T00:00:00Z INF Registered tunnel connection connIndex=0\n",
          ),
        );
        yield* Deferred.await(olderStopped);
        yield* Deferred.await(pruned);
      }),
  );

  it.effect("installs a missing relay client in the background and then starts it", () =>
    Effect.gen(function* () {
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      const spawned = yield* Deferred.make<string>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(
            spawned,
            ChildProcess.isStandardCommand(command) ? command.command : "",
          );
          const handle = makeHandle({ pid: 3, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() =>
              installed
                ? pinnedClient
                : { status: "missing" as const, version: RelayClient.CLOUDFLARED_VERSION },
            ),
            install: Effect.sync(() => {
              installed = true;
              return pinnedClient;
            }),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      // The first attempt reports the gap; the install then starts the connector itself.
      expect(status).toMatchObject({ status: "failed", failure: "not-installed" });
      expect(yield* Deferred.await(spawned)).toBe(pinnedClient.executablePath);
    }),
  );

  it.effect("leaves a PATH relay client alone", () =>
    Effect.gen(function* () {
      const install = vi.fn(() => Effect.die("unexpected install"));
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({ pid: 8, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "available",
              executablePath: "/opt/homebrew/bin/cloudflared",
              source: "path",
              version: "2026.10.0",
            }),
            install: Effect.suspend(install),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );
      expect(
        yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" }),
      ).toMatchObject({ status: "running", pid: 8 });
      yield* TestClock.adjust(Duration.minutes(30));
      expect(install).not.toHaveBeenCalled();
    }),
  );

  it.effect("leaves an override relay client alone", () =>
    Effect.gen(function* () {
      const install = vi.fn(() => Effect.die("unexpected install"));
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({ pid: 4, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "available",
              executablePath: "/opt/cloudflared",
              source: "override",
              version: "2025.10.0",
            }),
            install: Effect.suspend(install),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );
      expect(
        yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" }),
      ).toMatchObject({ status: "running", pid: 4 });
      yield* Effect.yieldNow;
      expect(install).not.toHaveBeenCalled();
    }),
  );

  it.effect("retries a failed background install while the older connector keeps running", () =>
    Effect.gen(function* () {
      const olderClient = {
        status: "available",
        executablePath: "/managed/2025.9.0/cloudflared",
        source: "managed",
        version: "2025.9.0",
      } as const;
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      let installAttempts = 0;
      const spawned = yield* Queue.unbounded<string>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Queue.offer(
            spawned,
            ChildProcess.isStandardCommand(command) ? command.command : "",
          );
          const handle = makeHandle({ pid: 5, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() => (installed ? pinnedClient : olderClient)),
            install: Effect.suspend(() => {
              installAttempts += 1;
              if (installAttempts === 1) {
                // A real download fails some time after it starts.
                return Effect.sleep(Duration.seconds(30)).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new RelayClient.RelayClientInstallError({
                        reason: "download_failed",
                        message: "offline",
                      }),
                    ),
                  ),
                );
              }
              installed = true;
              return Effect.succeed(pinnedClient);
            }),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" });
      expect(yield* Queue.take(spawned)).toBe(olderClient.executablePath);
      yield* TestClock.adjust(Duration.seconds(30));
      expect(installAttempts).toBe(1);

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* Queue.take(spawned)).toBe(pinnedClient.executablePath);
      expect(installAttempts).toBe(2);
    }),
  );

  it.effect("keeps the older connector when the updated relay client fails to start", () =>
    Effect.gen(function* () {
      const olderClient = {
        status: "available",
        executablePath: "/managed/2025.9.0/cloudflared",
        source: "managed",
        version: "2025.9.0",
      } as const;
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      let olderKilled = false;
      const releaseInstall = yield* Deferred.make<void>();
      const pinnedAttempted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const executable = ChildProcess.isStandardCommand(command) ? command.command : "";
          if (executable === pinnedClient.executablePath) {
            yield* Deferred.succeed(pinnedAttempted, undefined);
            return yield* PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
            });
          }
          const handle = makeHandle({
            pid: 6,
            onKill: () => {
              olderKilled = true;
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() => (installed ? pinnedClient : olderClient)),
            install: Deferred.await(releaseInstall).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  installed = true;
                  return pinnedClient;
                }),
              ),
            ),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );
      const config = { providerKind: "cloudflare_tunnel", connectorToken: "token" } as const;
      expect(yield* runtime.applyConfig(config)).toMatchObject({ status: "running", pid: 6 });

      yield* Deferred.succeed(releaseInstall, undefined);
      yield* Deferred.await(pinnedAttempted);
      // The failed swap leaves the older connector active and running.
      expect(yield* runtime.applyConfig(config)).toMatchObject({ status: "running", pid: 6 });
      expect(olderKilled).toBe(false);
    }),
  );

  it.effect("requests recovery when the older connector exited during a failed swap", () =>
    Effect.gen(function* () {
      const olderClient = {
        status: "available",
        executablePath: "/managed/2025.9.0/cloudflared",
        source: "managed",
        version: "2025.9.0",
      } as const;
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      const releaseInstall = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const executable = ChildProcess.isStandardCommand(command) ? command.command : "";
          if (executable === pinnedClient.executablePath) {
            return yield* PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
            });
          }
          // The older connector has exited by the time the swap fails.
          const handle = makeHandle({ pid: 12, onKill: () => {}, isRunning: () => !installed });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() => (installed ? pinnedClient : olderClient)),
            install: Deferred.await(releaseInstall).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  installed = true;
                  return pinnedClient;
                }),
              ),
            ),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );
      const config = { providerKind: "cloudflare_tunnel", connectorToken: "token" } as const;
      expect(yield* runtime.applyConfig(config)).toMatchObject({ status: "running", pid: 12 });

      yield* Deferred.succeed(releaseInstall, undefined);
      expect(Option.getOrThrow(yield* Stream.runHead(runtime.recoveryRequests))).toEqual(config);
    }),
  );

  it.effect("restarts a self-updated pinned-folder connector once the pin is reinstalled", () =>
    Effect.gen(function* () {
      const executablePath = "/managed/pinned/cloudflared";
      let version = "2026.9.3";
      const releaseInstall = yield* Deferred.make<void>();
      const spawned = yield* Queue.unbounded<string>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Queue.offer(spawned, version);
          const handle = makeHandle({ pid: 7, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const current = () =>
        ({ status: "available", executablePath, source: "managed", version }) as const;
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(current),
            install: Deferred.await(releaseInstall).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  version = RelayClient.CLOUDFLARED_VERSION;
                  return current();
                }),
              ),
            ),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" });
      expect(yield* Queue.take(spawned)).toBe("2026.9.3");
      yield* Deferred.succeed(releaseInstall, undefined);
      expect(yield* Queue.take(spawned)).toBe(RelayClient.CLOUDFLARED_VERSION);
    }),
  );

  it.effect("retries a failed install when no relay client is installed", () =>
    Effect.gen(function* () {
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      let installAttempts = 0;
      const spawned = yield* Deferred.make<string>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(
            spawned,
            ChildProcess.isStandardCommand(command) ? command.command : "",
          );
          const handle = makeHandle({ pid: 9, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() =>
              installed
                ? pinnedClient
                : { status: "missing" as const, version: RelayClient.CLOUDFLARED_VERSION },
            ),
            install: Effect.suspend(() => {
              installAttempts += 1;
              if (installAttempts === 1) {
                return Effect.fail(
                  new RelayClient.RelayClientInstallError({
                    reason: "download_failed",
                    message: "offline",
                  }),
                );
              }
              installed = true;
              return Effect.succeed(pinnedClient);
            }),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      expect(
        yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" }),
      ).toMatchObject({ status: "failed", failure: "not-installed" });
      yield* Effect.yieldNow;
      expect(installAttempts).toBe(1);

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* Deferred.await(spawned)).toBe(pinnedClient.executablePath);
      expect(installAttempts).toBe(2);
    }),
  );

  it.effect("restarts on the pin when the first post-install probe failed", () =>
    Effect.gen(function* () {
      const olderClient = {
        status: "available",
        executablePath: "/managed/2025.9.0/cloudflared",
        source: "managed",
        version: "2025.9.0",
      } as const;
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      // The first resolve after the install misses the new binary, as when a
      // scanner briefly holds it; later resolves see it.
      let missedProbes = 0;
      const spawned = yield* Queue.unbounded<string>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Queue.offer(
            spawned,
            ChildProcess.isStandardCommand(command) ? command.command : "",
          );
          const handle = makeHandle({ pid: 10, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() => {
              if (installed && missedProbes === 0) {
                missedProbes += 1;
                return olderClient;
              }
              return installed ? pinnedClient : olderClient;
            }),
            install: Effect.sync(() => {
              installed = true;
              return pinnedClient;
            }),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" });
      expect(yield* Queue.take(spawned)).toBe(olderClient.executablePath);
      yield* Effect.yieldNow;
      // The missed probe kept the older connector running.
      expect(Option.isNone(yield* Queue.poll(spawned))).toBe(true);

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* Queue.take(spawned)).toBe(pinnedClient.executablePath);
    }),
  );

  it.effect("starts the connector when the pin landed but its first probe failed", () =>
    Effect.gen(function* () {
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      const missing = { status: "missing" as const, version: RelayClient.CLOUDFLARED_VERSION };
      let installed = false;
      // The resolve right after the install misses the new binary.
      let missedProbes = 0;
      const spawned = yield* Deferred.make<string>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(
            spawned,
            ChildProcess.isStandardCommand(command) ? command.command : "",
          );
          const handle = makeHandle({ pid: 11, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() => {
              if (!installed) return missing;
              if (missedProbes === 0) {
                missedProbes += 1;
                return missing;
              }
              return pinnedClient;
            }),
            install: Effect.sync(() => {
              installed = true;
              return pinnedClient;
            }),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      expect(
        yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" }),
      ).toMatchObject({ status: "failed", failure: "not-installed" });
      yield* Effect.yieldNow;
      expect(Option.isNone(yield* Deferred.poll(spawned))).toBe(true);

      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* Deferred.await(spawned)).toBe(pinnedClient.executablePath);
    }),
  );
});
