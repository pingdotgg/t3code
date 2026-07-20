import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "PowerShell is not installed in the test environment",
        }),
      }),
    ),
});

const makeProbeFailureLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(TestProcessRunner, Net.layer, Layer.succeed(HostProcessPlatform, "win32")),
  ),
);

const openServer = (port: number): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
) {
  for (const port of ports) {
    const server = yield* openServer(port);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS),
  ({ server }) => closeServer(server),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns a server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);

effectIt("replays snapshots without rescanning unchanged terminal registrations", () => {
  let probeCount = 0;
  let replayCount = 0;
  const layer = makeProbeFailureLayer(() =>
    Effect.sync(() => {
      probeCount += 1;
      return {
        stdout: "",
        stderr: "",
        code: null,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    }),
  );

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.subscribe(() => Effect.void);
    yield* scanner.retain;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-1",
      terminalId: "terminal-1",
      processIds: [42],
    });
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-1",
      terminalId: "terminal-1",
      processIds: [42],
    });
    yield* scanner.subscribe(() =>
      Effect.sync(() => {
        replayCount += 1;
      }),
    );

    expect(probeCount).toBe(2);
    expect(replayCount).toBe(1);
  }).pipe(Effect.provide(layer));
});

effectIt("serializes snapshot replay with concurrent broadcasts", () =>
  Effect.gen(function* () {
    const replayStarted = yield* Deferred.make<void>();
    const releaseReplay = yield* Deferred.make<void>();
    const secondProbeCompleted = yield* Deferred.make<void>();
    const secondDeliveryStarted = yield* Deferred.make<void>();
    const deliveries: Array<ReadonlyArray<number>> = [];
    let probeCount = 0;
    let deliveryCount = 0;
    const layer = makeProbeFailureLayer(() =>
      Effect.gen(function* () {
        probeCount += 1;
        if (probeCount === 2) {
          yield* Deferred.succeed(secondProbeCompleted, undefined).pipe(Effect.ignore);
        }
        return {
          stdout: probeCount === 1 ? "p100\ncnode\nn*:3000\n" : "p101\ncnode\nn*:3001\n",
          stderr: "",
          code: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
    );

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.retain;

      const subscription = yield* scanner
        .subscribe((servers) =>
          Effect.gen(function* () {
            deliveryCount += 1;
            if (deliveryCount === 1) {
              yield* Deferred.succeed(replayStarted, undefined).pipe(Effect.ignore);
              yield* Deferred.await(releaseReplay);
            } else {
              yield* Deferred.succeed(secondDeliveryStarted, undefined).pipe(Effect.ignore);
            }
            deliveries.push(servers.map((server) => server.port));
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(replayStarted);

      const registration = yield* scanner
        .registerTerminalProcesses({
          threadId: "thread-1",
          terminalId: "terminal-1",
          processIds: [101],
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(secondProbeCompleted);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(secondDeliveryStarted)).toBe(false);

      yield* Deferred.succeed(releaseReplay, undefined);
      yield* Fiber.join(subscription);
      yield* Fiber.join(registration);

      expect(deliveries).toEqual([[3000], [3001]]);
    }).pipe(Effect.provide(layer));
  }),
);
