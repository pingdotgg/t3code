import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

effectIt("Windows listener probe builds the process-name map once", () =>
  Effect.gen(function* () {
    let seenCommand: string | undefined;
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              seenCommand = input.args.at(-1);
              return Effect.succeed({
                stdout: "127.0.0.1|5173|4242|node\n",
                stderr: "",
                code: 0,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
          Layer.succeed(Net.NetService, {
            canListenOnHost: () => Effect.succeed(true),
            isPortAvailableOnLoopback: () => Effect.succeed(true),
            reserveLoopbackPort: () => Effect.succeed(40_000),
            findAvailablePort: (preferred) => Effect.succeed(preferred),
          }),
          Layer.succeed(HostProcessPlatform, "win32"),
        ),
      ),
    );

    const servers = yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      return yield* scanner.scan();
    }).pipe(Effect.provide(layer), Effect.scoped);

    expect(seenCommand).toBe(PortScanner.WINDOWS_LISTENER_COMMAND);
    // Regression for #5900: never call Get-Process -Id per listener.
    expect(seenCommand).toContain("$m = @{}");
    expect(seenCommand).not.toMatch(/Get-Process\s+-Id/);
    expect(servers).toEqual([
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173",
        processName: "node",
        pid: 4242,
        terminal: null,
      },
    ]);
  }),
);

effectIt("Windows listener probe cools down after a timeout", () =>
  Effect.gen(function* () {
    let probeRuns = 0;
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: () => {
              probeRuns += 1;
              return Effect.fail(
                new ProcessRunner.ProcessTimeoutError({
                  command: "powershell.exe",
                  argumentCount: 4,
                  timeoutMs: 5_000,
                }),
              );
            },
          }),
          Layer.succeed(Net.NetService, {
            canListenOnHost: () => Effect.succeed(true),
            isPortAvailableOnLoopback: () => Effect.succeed(true),
            reserveLoopbackPort: () => Effect.succeed(40_000),
            findAvailablePort: (preferred) => Effect.succeed(preferred),
          }),
          Layer.succeed(HostProcessPlatform, "win32"),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      // First scan hits the probe and records a wall-clock cooldown.
      yield* scanner.scan();
      expect(probeRuns).toBe(1);
      // Immediate re-scans (retain, subscribe, poll) must not re-spawn PowerShell.
      yield* scanner.scan();
      yield* scanner.scan();
      expect(probeRuns).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

effectIt("Windows listener probe is single-flight under concurrent scan()", () =>
  Effect.gen(function* () {
    let probeRuns = 0;
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: () => {
              probeRuns += 1;
              return Effect.tryPromise({
                try: async () => {
                  await probeGate;
                  return {
                    stdout: "127.0.0.1|5173|4242|node\n",
                    stderr: "",
                    code: 0,
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  };
                },
                catch: (cause) =>
                  new ProcessRunner.ProcessReadError({
                    command: "powershell.exe",
                    argumentCount: 4,
                    stream: "stdout",
                    cause,
                  }),
              });
            },
          }),
          Layer.succeed(Net.NetService, {
            canListenOnHost: () => Effect.succeed(true),
            isPortAvailableOnLoopback: () => Effect.succeed(true),
            reserveLoopbackPort: () => Effect.succeed(40_000),
            findAvailablePort: (preferred) => Effect.succeed(preferred),
          }),
          Layer.succeed(HostProcessPlatform, "win32"),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const first = scanner.scan().pipe(Effect.forkChild);
      // Second claim must skip while the first probe is in flight.
      yield* Effect.yieldNow();
      const second = yield* scanner.scan();
      expect(probeRuns).toBe(1);
      // Common-port fallback while the expensive probe is busy.
      expect(second.every((server) => server.processName === null)).toBe(true);

      releaseProbe?.();
      yield* first;
      expect(probeRuns).toBe(1);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

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

effectIt("clears Windows listener probe in-flight flag after interruption", () =>
  Effect.gen(function* () {
    let probeRuns = 0;
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: () => {
              probeRuns += 1;
              if (probeRuns === 1) {
                return Effect.interrupt;
              }
              return Effect.succeed({
                stdout: "127.0.0.1|5173|4242|node\n",
                stderr: "",
                code: 0,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
          Layer.succeed(Net.NetService, {
            canListenOnHost: () => Effect.succeed(true),
            isPortAvailableOnLoopback: () => Effect.succeed(true),
            reserveLoopbackPort: () => Effect.succeed(40_000),
            findAvailablePort: (preferred) => Effect.succeed(preferred),
          }),
          Layer.succeed(HostProcessPlatform, "win32"),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const first = yield* scanner.scan().pipe(Effect.exit);
      expect(Exit.isFailure(first)).toBe(true);
      if (Exit.isFailure(first)) {
        expect(Cause.hasInterruptsOnly(first.cause)).toBe(true);
      }
      // Release must clear inFlight; otherwise every later scan would skip.
      const second = yield* scanner.scan();
      expect(probeRuns).toBe(2);
      expect(second).toEqual([
        {
          host: "localhost",
          port: 5173,
          url: "http://localhost:5173",
          processName: "node",
          pid: 4242,
          terminal: null,
        },
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);
