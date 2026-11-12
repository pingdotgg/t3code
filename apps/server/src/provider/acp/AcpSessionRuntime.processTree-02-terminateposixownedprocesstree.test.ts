// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const identity = (
  pid: number,
  ppid: number,
  pgid: number,
  sid: number,
  startTime = String(pid),
  state = "S",
): AcpSessionRuntime.AcpPosixProcessIdentity => ({
  executable: `/proc/${pid}/exe`,
  pgid,
  pid,
  ppid,
  sid,
  startTime,
  state,
});

function makeController(input: {
  readonly processes: ReadonlyArray<AcpSessionRuntime.AcpPosixProcessIdentity>;
  readonly onProcess?: (
    processes: Map<number, AcpSessionRuntime.AcpPosixProcessIdentity>,
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
}) {
  const processes = new Map(input.processes.map((process) => [process.pid, process]));
  const signals: Array<string> = [];
  const controller: AcpSessionRuntime.AcpPosixProcessTreeController = {
    childPidsOf: (pid) =>
      [...processes.values()]
        .filter((process) => process.ppid === pid)
        .map((process) => process.pid),
    childrenOf: (pid) => [...processes.values()].filter((process) => process.ppid === pid),
    identity: (pid) => processes.get(pid),
    snapshot: () => [...processes.values()],
    signalProcess: (pid, signal) => {
      signals.push(`process:${pid}:${signal}`);
      if (input.onProcess) return input.onProcess(processes, pid, signal);
      processes.delete(pid);
    },
  };
  return { controller, processes, signals };
}

const server = () => identity(process.pid, 1, process.pid, process.pid, "server");



describe("terminatePosixOwnedProcessTree", () => {
  it("admits a live child after a free PID was previously reserved by a dead entry", () => {
    const staleChild: AcpSessionRuntime.AcpOwnedPosixProcess = {
      ...identity(200, 100, 200, 200, "stale-child"),
      parentExecutable: `/proc/100/exe`,
      parentStartTime: "100",
    };
    const liveChild = identity(200, 100, 200, 200, "live-child");
    const root = identity(100, process.pid, 100, 100);
    const ownedRoot: AcpSessionRuntime.AcpOwnedPosixProcess = {
      ...root,
      parentExecutable: `/proc/${process.pid}/exe`,
      parentStartTime: "server",
    };
    const ledger = new Map<string, AcpSessionRuntime.AcpOwnedPosixProcess>([
      [`100:${root.startTime}`, ownedRoot],
      [`200:${staleChild.startTime}`, staleChild],
    ]);
    const controller = makeController({
      processes: [server(), root],
    }).controller;

    AcpSessionRuntime.capturePosixOwnershipLedger({
      controller,
      ledger,
      rootPid: 100,
      table: [root],
    });
    expect([...ledger.values()].some((entry) => entry.pid === 200)).toBe(false);

    AcpSessionRuntime.capturePosixOwnershipLedger({
      controller: makeController({ processes: [server(), root, liveChild] }).controller,
      ledger,
      rootPid: 100,
      table: [root, liveChild],
    });

    const admitted = [...ledger.values()].find((entry) => entry.pid === 200);
    expect(admitted?.startTime).toBe("live-child");
  });
  it.live("signals children forked under a still-live parent during the same pass", () =>
    Effect.gen(function* () {
      let forked = false;
      const fixture = makeController({
        processes: [
          server(),
          identity(100, process.pid, 100, 100),
          identity(110, 100, 110, 110),
          identity(111, 110, 111, 111),
        ],
        onProcess: (processes, pid) => {
          if (pid === 111 && !forked) {
            forked = true;
            processes.set(112, identity(112, 110, 112, 112));
          }
          processes.delete(pid);
        },
      });

      yield* AcpSessionRuntime.terminatePosixOwnedProcessTree({
        controller: fixture.controller,
        grace: 0,
        rootPid: 100,
      });

      expect(forked).toBe(true);
      expect(fixture.processes.has(112)).toBe(false);
      expect(fixture.signals.some((entry) => entry.startsWith("process:112:"))).toBe(true);
    }),
  );
  it.live("detects an owned child first observed in the final survivor snapshot", () =>
    Effect.gen(function* () {
      const lateChild = identity(111, 110, 111, 111);
      const fixture = makeController({
        processes: [server(), identity(100, process.pid, 100, 100), identity(110, 100, 110, 110)],
        onProcess: (processes, pid) => {
          if (pid !== 110) processes.delete(pid);
        },
      });
      let snapshotCalls = 0;
      const controller: AcpSessionRuntime.AcpPosixProcessTreeController = {
        ...fixture.controller,
        snapshot: () => {
          snapshotCalls += 1;
          if (snapshotCalls === 6) fixture.processes.set(lateChild.pid, lateChild);
          return fixture.controller.snapshot();
        },
      };

      const error = yield* Effect.flip(
        AcpSessionRuntime.terminatePosixOwnedProcessTree({
          controller,
          discoveryPasses: 2,
          grace: 0,
          rootPid: 100,
        }),
      );

      expect(snapshotCalls).toBe(6);
      expect(error.detail).toContain("110, 111");
    }),
  );
  it.live("retains the ledger across root exit and an explicit failure for finalizer retry", () =>
    Effect.gen(function* () {
      let ignoreSignals = true;
      const ledger = new Map<string, AcpSessionRuntime.AcpOwnedPosixProcess>();
      const frontier = new Map<number, AcpSessionRuntime.AcpOwnedPosixProcess>();
      const childQueues = new Map<number, Array<number>>();
      const root: AcpSessionRuntime.AcpPosixOwnershipRoot = { value: undefined };
      const fixture = makeController({
        processes: [
          server(),
          identity(100, process.pid, 100, 100),
          identity(110, 100, 110, 110),
          identity(111, 110, 110, 110),
        ],
        onProcess: (processes, pid) => {
          if (ignoreSignals && pid === 100) processes.delete(100);
          if (!ignoreSignals) processes.delete(pid);
        },
      });
      AcpSessionRuntime.observePosixOwnershipLedger({
        childQueues,
        controller: fixture.controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      });

      const explicit = yield* Effect.exit(
        AcpSessionRuntime.terminatePosixOwnedProcessTree({
          controller: fixture.controller,
          grace: 0,
          ledger,
          rootPid: 100,
        }),
      );
      expect(Exit.isFailure(explicit)).toBe(true);
      expect(fixture.processes.has(100)).toBe(false);
      expect(fixture.processes.has(111)).toBe(true);

      fixture.processes.set(112, identity(112, 110, 112, 112));
      AcpSessionRuntime.observePosixOwnershipLedger({
        childQueues,
        controller: fixture.controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      });
      ignoreSignals = false;
      yield* AcpSessionRuntime.terminatePosixOwnedProcessTree({
        controller: fixture.controller,
        grace: 0,
        ledger,
        rootPid: 100,
      });
      expect(fixture.processes.has(110)).toBe(false);
      expect(fixture.processes.has(111)).toBe(false);
      expect(fixture.processes.has(112)).toBe(false);
    }),
  );
  it("fails closed where a stable POSIX identity provider is unavailable", () => {
    try {
      AcpSessionRuntime.makePosixProcessTreeController("darwin");
      throw new Error("Expected Darwin process ownership to fail closed");
    } catch (error) {
      expect(error).toMatchObject({
        detail: "Detached ACP descendant ownership is unsupported on darwin",
      });
    }
  });
});

