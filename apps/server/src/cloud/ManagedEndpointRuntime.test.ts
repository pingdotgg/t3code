import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
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

const unusedHttpClient = HttpClient.make(() => Effect.die("unused"));

const emptySecretStoreLayer = Layer.mock(ServerSecretStore.ServerSecretStore)({
  get: () => Effect.succeedNone,
  set: () => Effect.void,
});

const runtimeDependencies = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
  httpClient = unusedHttpClient,
  secretStoreLayer = emptySecretStoreLayer,
) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HttpClient.HttpClient, httpClient),
    relayClientLayer,
    secretStoreLayer,
  );

const buildCloudManagedEndpointRuntime = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = layerRelayClientAvailable,
  httpClient = unusedHttpClient,
  secretStoreLayer = emptySecretStoreLayer,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(runtimeDependencies(spawner, relayClientLayer, httpClient, secretStoreLayer)),
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
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z FTL Cannot determine default origin certificate path",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput("2026-06-17T02:00:00Z PNC runtime panic"),
    ).toBe("warning");
  });

  it("classifies connection unregistration apart from registration and routine output", () => {
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-10-06T00:00:00Z INF Unregistered tunnel connection connIndex=0 event=0 ip=198.41.200.23",
      ),
    ).toBe("unregistered");
    for (const level of ["ERR", "WRN", "FTL", "PNC"]) {
      expect(
        ManagedEndpointRuntime.classifyRelayClientOutput(
          `2026-10-06T00:00:00Z ${level} Unregistered tunnel connection connIndex=0`,
        ),
      ).toBe("warning");
    }
    for (const line of [
      "2026-10-06T00:00:00Z INF Initiating graceful shutdown due to signal terminated ...",
      "2026-10-06T00:00:00Z INF Starting metrics server on 127.0.0.1:20241/metrics",
      "2026-10-06T00:00:00Z DBG Unregistered tunnel connection connIndex=0",
    ]) {
      expect(ManagedEndpointRuntime.classifyRelayClientOutput(line)).toBe("debug");
    }
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

  it.effect("logs a connection unregistration at info with the connector token redacted", () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
    const unregistrationLogged = Deferred.makeUnsafe<void>();
    const logger = Logger.make(({ logLevel, message }) => {
      logs.push({ level: logLevel, message });
      if (Array.isArray(message) && message[0] === "Relay client tunnel connection unregistered") {
        Deferred.doneUnsafe(unregistrationLogged, Effect.void);
      }
    });

    return Effect.gen(function* () {
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "secret-connector-token",
        tunnelId: "tunnel-1",
      };
      const encoder = new TextEncoder();
      const output = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 701,
            onKill: () => {},
            output: Stream.fromQueue(output),
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      yield* runtime.applyConfig(config);
      yield* Queue.offer(
        output,
        encoder.encode(
          "2026-10-06T00:00:00Z INF Unregistered tunnel connection connIndex=0 token=secret-connector-token\n",
        ),
      );
      yield* Deferred.await(unregistrationLogged);

      // An unregistration is not a registration, so the registration timeout still recovers.
      yield* TestClock.adjust(Duration.minutes(3));
      expect(Option.getOrNull(yield* Stream.runHead(runtime.recoveryRequests))).toEqual(config);

      yield* Queue.offer(
        output,
        encoder.encode(
          "2026-10-06T00:00:01Z INF Starting metrics server on 127.0.0.1:20241/metrics\n" +
            "2026-10-06T00:00:01Z INF Registered tunnel connection connIndex=0\n",
        ),
      );
      yield* Stream.runHead(runtime.tunnelConnected);

      const relayLogs = logs.filter(
        ({ message }) =>
          Array.isArray(message) && String(message[0]).startsWith("Relay client tunnel"),
      );
      expect(relayLogs.map(({ level, message }) => [level, (message as unknown[])[0]])).toEqual([
        ["Info", "Relay client tunnel connection unregistered"],
        ["Info", "Relay client tunnel connection registered"],
      ]);
      expect((relayLogs[0]!.message as unknown[])[1]).toMatchObject({
        output:
          "2026-10-06T00:00:00Z INF Unregistered tunnel connection connIndex=0 token=<redacted>",
      });
      const logged = JSON.stringify(logs.map(({ message }) => message));
      expect(logged).not.toContain("secret-connector-token");
      expect(logged).not.toContain("Starting metrics server");
    }).pipe(
      Effect.provide(
        Layer.merge(
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Info"),
        ),
      ),
    );
  });

  const tunnelConfig = {
    providerKind: "cloudflare_tunnel" as const,
    connectorToken: "token",
    tunnelId: "tunnel-1",
  };
  const quicDialWarning =
    '2026-10-16T20:29:43Z ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=1\n';
  const quicDatagramWarning =
    '2026-10-16T20:29:41Z ERR Connection terminated error="datagram manager error: timeout: no recent network activity" connIndex=1\n';

  const makeTransportSpawner = Effect.fnUntraced(function* (
    options: {
      transport?: string;
      failSpawn?: number;
      isRunning?: Effect.Effect<boolean>;
    } = {},
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.env.TUNNEL_TRANSPORT_PROTOCOL;
        if (options.transport === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
        else process.env.TUNNEL_TRANSPORT_PROTOCOL = options.transport;
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
          else process.env.TUNNEL_TRANSPORT_PROTOCOL = previous;
        }),
    );
    const spawned: Array<ChildProcess.StandardCommand> = [];
    const killed: Array<number> = [];
    const outputs: Array<Queue.Queue<Uint8Array>> = [];
    const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
    const started = yield* Queue.unbounded<number>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die("Expected standard command.");
        }
        const index = spawned.length;
        spawned.push(command);
        if (index === options.failSpawn) {
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "cloudflared temporarily unavailable",
          });
        }
        const output = yield* Queue.unbounded<Uint8Array>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        outputs[index] = output;
        exits[index] = exit;
        const handle = ChildProcessSpawner.makeHandle({
          ...makeHandle({
            pid: 800 + index,
            exitCode: Deferred.await(exit),
            output: Stream.fromQueue(output),
            onKill: () => {
              killed.push(800 + index);
              Deferred.doneUnsafe(exit, Exit.succeed(ChildProcessSpawner.ExitCode(143)));
            },
          }),
          isRunning: options.isRunning ?? Effect.succeed(true),
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        yield* Queue.offer(started, index);
        return handle;
      }),
    );
    const emit = (index: number, lines: string) =>
      Queue.offer(outputs[index]!, new TextEncoder().encode(lines));
    const observe = (
      runtime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"],
      index: number,
      lines = "",
    ) =>
      emit(
        index,
        lines + "2026-10-16T20:30:00Z INF Registered tunnel connection connIndex=0\n",
      ).pipe(Effect.andThen(Stream.runHead(runtime.tunnelConnected)));
    return { spawner, spawned, killed, exits, started, emit, observe };
  });

  it.effect("preserves an explicit transport choice despite repeated QUIC stalls", () =>
    Effect.gen(function* () {
      const fixture = yield* makeTransportSpawner({ transport: "quic" });
      const runtime = yield* buildCloudManagedEndpointRuntime(fixture.spawner);
      yield* runtime.applyConfig(tunnelConfig);
      yield* fixture.observe(runtime, 0, quicDialWarning.repeat(30));
      yield* fixture.observe(runtime, 0, quicDatagramWarning.repeat(30));
      expect(fixture.spawned).toHaveLength(1);
      expect(fixture.killed).toEqual([]);
      expect(fixture.spawned[0]!.args).not.toContain("--protocol");
      expect(fixture.spawned[0]!.options.env?.TUNNEL_TRANSPORT_PROTOCOL).toBe("quic");
    }),
  );

  it.effect(
    "retains automatic HTTP/2 fallback across restarts until expiry and respects overrides",
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(
          ServerSecretStore.layer.pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-transport-test-" })),
            Layer.provide(NodeServices.layer),
          ),
        );
        const secretStoreLayer = Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          context.pipe(Context.get(ServerSecretStore.ServerSecretStore)),
        );
        const fixture = yield* makeTransportSpawner();
        const start = (spawner = fixture.spawner) =>
          buildCloudManagedEndpointRuntime(
            spawner,
            layerRelayClientAvailable,
            unusedHttpClient,
            secretStoreLayer,
          );
        yield* Effect.gen(function* () {
          const runtime = yield* start();
          yield* runtime.applyConfig(tunnelConfig);
          expect(yield* Queue.take(fixture.started)).toBe(0);
          expect(fixture.spawned[0]!.args).not.toContain("--protocol");
          yield* fixture.emit(0, quicDialWarning.repeat(30));
          expect(yield* Queue.take(fixture.started)).toBe(1);
          yield* fixture.observe(runtime, 1);
          expect(fixture.spawned[1]!.args.slice(-3)).toEqual(["--protocol", "http2", "run"]);
        }).pipe(Effect.scoped);

        yield* TestClock.adjust(Duration.hours(1));
        for (const transport of [undefined, "quic", "http2", "auto", undefined]) {
          yield* Effect.gen(function* () {
            const next = yield* makeTransportSpawner(transport ? { transport } : {});
            const restarted = yield* start(next.spawner);
            yield* restarted.applyConfig(tunnelConfig);
            if (transport === undefined) {
              expect(next.spawned[0]!.args.slice(-3)).toEqual(["--protocol", "http2", "run"]);
            } else {
              expect(next.spawned[0]!.args).not.toContain("--protocol");
              expect(next.spawned[0]!.options.env?.TUNNEL_TRANSPORT_PROTOCOL).toBe(transport);
              yield* next.observe(restarted, 0, quicDialWarning.repeat(30));
              expect(next.spawned).toHaveLength(1);
            }
          }).pipe(Effect.scoped);
        }

        // Reusing the hint one hour later must not extend its original lifetime.
        yield* TestClock.adjust(Duration.hours(23));
        yield* Effect.gen(function* () {
          const next = yield* makeTransportSpawner();
          const restarted = yield* start(next.spawner);
          yield* restarted.applyConfig(tunnelConfig);
          expect(next.spawned[0]!.args).not.toContain("--protocol");
          expect(yield* Queue.take(next.started)).toBe(0);
          yield* next.emit(0, quicDatagramWarning.repeat(30));
          expect(yield* Queue.take(next.started)).toBe(1);
          expect(next.spawned[1]!.args.slice(-3)).toEqual(["--protocol", "http2", "run"]);
        }).pipe(Effect.scoped);
      }),
  );

  it.effect(
    "ignores invalid or unreadable fallback state and still falls back if persistence fails",
    () =>
      Effect.gen(function* () {
        for (const cached of [
          "not json",
          '{"fellBackAt":"invalid"}',
          '{"fellBackAt":9007199254740991}',
          null,
        ]) {
          yield* Effect.gen(function* () {
            const fixture = yield* makeTransportSpawner();
            const runtime = yield* buildCloudManagedEndpointRuntime(
              fixture.spawner,
              layerRelayClientAvailable,
              unusedHttpClient,
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () =>
                  cached === null
                    ? Effect.fail(
                        new ServerSecretStore.SecretStoreReadError({
                          resource: "test",
                          cause: "unreadable",
                        }),
                      )
                    : Effect.succeedSome(new TextEncoder().encode(cached)),
                set: () =>
                  Effect.fail(
                    new ServerSecretStore.SecretStorePersistError({
                      resource: "test",
                      cause: "read-only",
                    }),
                  ),
              }),
            );
            yield* runtime.applyConfig(tunnelConfig);
            expect(yield* Queue.take(fixture.started)).toBe(0);
            expect(fixture.spawned[0]!.args).not.toContain("--protocol");
            yield* fixture.emit(0, quicDialWarning.repeat(30));
            expect(yield* Queue.take(fixture.started)).toBe(1);
            expect(fixture.spawned[1]!.args.slice(-3)).toEqual(["--protocol", "http2", "run"]);
          }).pipe(Effect.scoped);
        }
      }),
  );

  it.effect("requests recovery after a failed HTTP/2 spawn and retries with HTTP/2", () =>
    Effect.gen(function* () {
      const fixture = yield* makeTransportSpawner({ failSpawn: 1 });
      const runtime = yield* buildCloudManagedEndpointRuntime(fixture.spawner);
      yield* runtime.applyConfig(tunnelConfig);
      expect(yield* Queue.take(fixture.started)).toBe(0);
      yield* fixture.emit(0, quicDialWarning.repeat(30));

      const requested = Option.getOrThrow(yield* Stream.runHead(runtime.recoveryRequests));
      expect(requested).toEqual(tunnelConfig);
      expect(fixture.killed).toEqual([800]);
      expect(fixture.spawned).toHaveLength(2);
      expect(fixture.spawned[1]!.args.slice(-3)).toEqual(["--protocol", "http2", "run"]);
      expect(yield* runtime.applyConfig(requested)).toMatchObject({ status: "running", pid: 802 });
      yield* fixture.observe(runtime, 2);
      expect(fixture.spawned[2]!.args.slice(-3)).toEqual(["--protocol", "http2", "run"]);
    }),
  );

  it.effect("discards a pending fallback when its connector is replaced or removed", () =>
    Effect.gen(function* () {
      for (const nextConfig of [{ ...tunnelConfig, connectorToken: "replacement" }, null]) {
        yield* Effect.gen(function* () {
          const checking = yield* Deferred.make<void>();
          const releaseCheck = yield* Deferred.make<void>();
          const fixture = yield* makeTransportSpawner({
            isRunning: Deferred.succeed(checking, undefined).pipe(
              Effect.andThen(Deferred.await(releaseCheck)),
              Effect.as(true),
            ),
          });
          const runtime = yield* buildCloudManagedEndpointRuntime(fixture.spawner);
          yield* runtime.applyConfig(tunnelConfig);
          yield* fixture.observe(runtime, 0);

          // Hold reconciliation in a process probe so config changes queue before fallback.
          const probe = yield* runtime.applyConfig(tunnelConfig).pipe(Effect.forkChild);
          yield* Deferred.await(checking);
          const change = yield* runtime
            .applyConfig(nextConfig)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* fixture.observe(runtime, 0, quicDialWarning.repeat(30));
          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(probe);
          yield* Fiber.join(change);
          yield* TestClock.adjust(Duration.zero);

          expect(fixture.killed).toEqual([800]);
          expect(fixture.spawned).toHaveLength(nextConfig ? 2 : 1);
          if (nextConfig) {
            expect(fixture.spawned[1]!.options.env?.TUNNEL_TOKEN).toBe("replacement");
            expect(fixture.spawned[1]!.args).not.toContain("--protocol");
          }
          yield* runtime.applyConfig(null);
          // Buffered output and the old exit cannot revive a removed configuration.
          yield* fixture.emit(0, quicDialWarning.repeat(30));
          yield* TestClock.adjust(Duration.minutes(5));
          expect(fixture.spawned).toHaveLength(nextConfig ? 2 : 1);
          expect(fixture.killed).toEqual(nextConfig ? [800, 801] : [800]);
        }).pipe(Effect.scoped);
      }
    }).pipe(Effect.provide(TestClock.layer())),
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
        [
          "tunnel",
          "--no-autoupdate",
          "--loglevel",
          "info",
          "--output",
          "default",
          "--metrics",
          "127.0.0.1:0",
          "run",
        ],
        [
          "tunnel",
          "--no-autoupdate",
          "--loglevel",
          "info",
          "--output",
          "default",
          "--metrics",
          "127.0.0.1:0",
          "run",
        ],
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
      expect(status).toMatchObject({ status: "failed", failure: "not-installed" });
      expect(yield* Deferred.await(spawned)).toBe(pinnedClient.executablePath);
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
});
