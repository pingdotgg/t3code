import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { DiscoveredServerKillError } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { expect, vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentSessionRegistryModule from "../process/AgentSessionRegistry.ts";
import * as PortScanner from "./PortScanner.ts";

const AgentSessionRegistryLive = AgentSessionRegistryModule.layer;
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
        AgentSessionRegistryLive,
      ),
    ),
  );

const TestPortDiscoveryLive = Layer.mergeAll(
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProcessRunner,
        Net.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        AgentSessionRegistryLive,
      ),
    ),
  ),
  AgentSessionRegistryLive,
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
      const found = result.servers.find((server) => server.port === port);
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
      yield* scanner.subscribe((snapshot) =>
        Effect.sync(() => {
          for (const server of snapshot.servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

const withKillSpy = <A, E, R>(
  impl: (pid: number, signal?: string | number) => boolean,
  use: (spy: ReturnType<typeof vi.spyOn>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => vi.spyOn(process, "kill").mockImplementation(impl as typeof process.kill)),
    use,
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

effectIt.layer(TestPortDiscoveryLive)("PortDiscovery.killOwnedProcess", (it) => {
  it.effect(
    "refuses a pid that is not registered to a terminal of the thread",
    Effect.fn("PortScannerTest.killRefusesUnowned")(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "thread-other",
        terminalId: "term-1",
        processIds: [4242],
      });
      yield* withKillSpy(
        () => true,
        (spy) =>
          Effect.gen(function* () {
            const exit = yield* scanner
              .killOwnedProcess({ threadId: "thread-1", pid: 4242 })
              .pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              expect(error).toBeInstanceOf(DiscoveredServerKillError);
              expect((error as DiscoveredServerKillError).reason).toBe("not-owned");
            }
            expect(spy).not.toHaveBeenCalled();
          }),
      );
    }),
  );

  it.effect(
    "SIGTERMs a pid registered to the thread's terminal",
    Effect.fn("PortScannerTest.killSignalsOwned")(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "thread-1",
        terminalId: "term-1",
        processIds: [5151],
      });
      yield* withKillSpy(
        () => true,
        (spy) =>
          Effect.gen(function* () {
            yield* scanner.killOwnedProcess({ threadId: "thread-1", pid: 5151 });
            expect(spy).toHaveBeenCalledWith(5151, "SIGTERM");
          }),
      );
    }),
  );

  it.effect(
    "treats an already-exited process as success",
    Effect.fn("PortScannerTest.killToleratesEsrch")(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "thread-1",
        terminalId: "term-2",
        processIds: [6161],
      });
      yield* withKillSpy(
        () => {
          const error = new Error("kill ESRCH") as Error & { code: string };
          error.code = "ESRCH";
          throw error;
        },
        () => scanner.killOwnedProcess({ threadId: "thread-1", pid: 6161 }),
      );
    }),
  );

  it.effect(
    "fails with signal-failed when the signal is refused",
    Effect.fn("PortScannerTest.killReportsSignalFailure")(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.registerTerminalProcesses({
        threadId: "thread-1",
        terminalId: "term-3",
        processIds: [7171],
      });
      yield* withKillSpy(
        () => {
          const error = new Error("kill EPERM") as Error & { code: string };
          error.code = "EPERM";
          throw error;
        },
        () =>
          Effect.gen(function* () {
            const exit = yield* scanner
              .killOwnedProcess({ threadId: "thread-1", pid: 7171 })
              .pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const error = Cause.squash(exit.cause);
              expect(error).toBeInstanceOf(DiscoveredServerKillError);
              expect((error as DiscoveredServerKillError).reason).toBe("signal-failed");
            }
          }),
      );
    }),
  );
});

effectIt("parses process tables and resolves agent ownership", () =>
  Effect.sync(() => {
    const windowsTable = PortScanner.parseProcessTable(
      "100|1|node.exe|C:\\nodejs\\node.exe C:\\repo\\pnpm.cjs build\r\n" +
        "200|100|cmd.exe|cmd /d /s /c echo a|b\r\n" +
        "300|200|esbuild.exe|\r\n",
    );
    expect(windowsTable.parents.get(300)).toBe(200);
    expect(windowsTable.names.get(100)).toBe("node.exe");
    expect(windowsTable.commandLines.get(100)).toBe(
      "C:\\nodejs\\node.exe C:\\repo\\pnpm.cjs build",
    );
    // Command lines may contain the separator; empty ones stay absent.
    expect(windowsTable.commandLines.get(200)).toBe("cmd /d /s /c echo a|b");
    expect(windowsTable.commandLines.has(300)).toBe(false);
    const posixTable = PortScanner.parseProcessTable(
      "  100     1 /usr/bin/node /repo/x.js\n  200   100 pnpm\n 300   200 vite build\n",
    );
    expect(posixTable.parents.get(200)).toBe(100);
    expect(posixTable.names.get(100)).toBe("node");
    expect(posixTable.commandLines.get(100)).toBe("/usr/bin/node /repo/x.js");
    // Name-less lines (plain pid/ppid tables) still parse.
    expect(PortScanner.parseProcessTable("100 1\n").parents.get(100)).toBe(1);

    const roots = new Map([[100, "thread-1"]]);
    expect(PortScanner.findAgentOwner(300, posixTable.parents, roots)).toBe("thread-1");
    expect(PortScanner.findAgentOwner(100, posixTable.parents, roots)).toBe("thread-1");
    expect(PortScanner.findAgentOwner(1, posixTable.parents, roots)).toBe(null);
    // Cycle-safe: parent chain loops without hitting a root.
    const cyclic = new Map([
      [10, 20],
      [20, 10],
    ]);
    expect(PortScanner.findAgentOwner(10, cyclic, roots)).toBe(null);

    expect(PortScanner.collectDescendantProcessIds(100, posixTable.parents)).toEqual([200, 300]);
    expect(PortScanner.collectDescendantProcessIds(300, posixTable.parents)).toEqual([]);
  }),
);

const runResult = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: 0 as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
});

/**
 * Linux layer with stubbed lsof (one listener on 127.0.0.1:5173 owned by pid
 * 300) and a stubbed ps parent table (300 → 200 → 100). Registering pid 100
 * as thread-1's session root makes the listener agent-owned.
 */
const AgentAttributionLayer = Layer.mergeAll(
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            input.command === "lsof"
              ? Effect.succeed(runResult("p300\ncnode\nn127.0.0.1:5173\n"))
              : input.command === "ps"
                ? Effect.succeed(runResult("100 1\n200 100\n300 200\n"))
                : Effect.fail(
                    new ProcessRunner.ProcessSpawnError({
                      command: input.command,
                      argumentCount: input.args.length,
                      cwd: input.cwd,
                      cause: PlatformError.systemError({
                        _tag: "NotFound",
                        module: "ChildProcess",
                        method: "spawn",
                        description: "unexpected command in agent attribution test",
                      }),
                    }),
                  ),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        AgentSessionRegistryLive,
      ),
    ),
  ),
  AgentSessionRegistryLive,
);

effectIt.layer(AgentAttributionLayer)("PortDiscovery agent ownership", (it) => {
  it.effect(
    "attributes a listener to the thread whose session tree spawned it",
    Effect.fn("PortScannerTest.agentAttribution")(function* () {
      const registry = yield* AgentSessionRegistryModule.AgentSessionRegistry;
      const scanner = yield* PortScanner.PortDiscovery;
      yield* registry.register({ threadId: "thread-1", pid: 100 });
      const snapshot = yield* scanner.scan();
      const found = snapshot.servers.find((server) => server.port === 5173);
      expect(found?.agent?.threadId).toBe("thread-1");
      expect(found?.terminal).toBe(null);
      // Every live descendant of the session root is reported, ports or not.
      expect(snapshot.processes.map((entry) => entry.pid)).toEqual([200, 300]);
      expect(snapshot.processes.every((entry) => entry.owner === "agent")).toBe(true);
      expect(snapshot.processes.every((entry) => entry.threadId === "thread-1")).toBe(true);
      yield* registry.unregister({ threadId: "thread-1" });
      const after = yield* scanner.scan();
      expect(after.servers.find((server) => server.port === 5173)?.agent).toBe(null);
      expect(after.processes).toEqual([]);
    }),
  );

  it.effect(
    "kills a live descendant of the thread's session root but refuses other threads",
    Effect.fn("PortScannerTest.agentKill")(function* () {
      const registry = yield* AgentSessionRegistryModule.AgentSessionRegistry;
      const scanner = yield* PortScanner.PortDiscovery;
      yield* registry.register({ threadId: "thread-1", pid: 100 });
      yield* withKillSpy(
        () => true,
        (spy) =>
          Effect.gen(function* () {
            const refused = yield* scanner
              .killOwnedProcess({ threadId: "thread-2", pid: 300 })
              .pipe(Effect.exit);
            expect(Exit.isFailure(refused)).toBe(true);
            expect(spy).not.toHaveBeenCalled();

            yield* scanner.killOwnedProcess({ threadId: "thread-1", pid: 300 });
            expect(spy).toHaveBeenCalledWith(300, "SIGTERM");
          }),
      );
      yield* registry.unregister({ threadId: "thread-1" });
    }),
  );

  it.effect(
    "killThreadAgentTree SIGTERMs every descendant but never the session root",
    Effect.fn("PortScannerTest.agentTreeKill")(function* () {
      const registry = yield* AgentSessionRegistryModule.AgentSessionRegistry;
      const scanner = yield* PortScanner.PortDiscovery;
      yield* registry.register({ threadId: "thread-1", pid: 100 });
      yield* withKillSpy(
        () => true,
        (spy) =>
          Effect.gen(function* () {
            yield* scanner.killThreadAgentTree("thread-1");
            const calls = spy.mock.calls as ReadonlyArray<readonly [number, string]>;
            const termed = calls.filter((call) => call[1] === "SIGTERM").map((call) => call[0]);
            expect(termed).toEqual([200, 300]);
          }),
      );
      yield* registry.unregister({ threadId: "thread-1" });
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
