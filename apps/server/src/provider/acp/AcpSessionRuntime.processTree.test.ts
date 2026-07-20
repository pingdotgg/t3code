// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import {
  capturePosixOwnershipLedger,
  isSafeCgroupPath,
  makeLinuxCgroupController,
  makePosixProcessTreeController,
  observePosixOwnershipLedger,
  observePosixOwnershipLedgerContinuously,
  parseCgroup2Mount,
  parseCgroup2Mounts,
  parseUnifiedCgroupPath,
  posixProcessIsZombie,
  resolveLinuxCgroupTargetCommand,
  signalLinuxCgroupRootTerm,
  sweepStaleLinuxCgroupSiblings,
  terminateLinuxCgroupLease,
  terminatePosixOwnedProcessTree,
  wrapCommandForLinuxCgroup,
  type AcpOwnedPosixProcess,
  type AcpLinuxCgroupLease,
  type AcpPosixOwnershipRoot,
  type AcpPosixProcessIdentity,
  type AcpPosixProcessTreeController,
} from "./AcpSessionRuntime.ts";

const threadSpawnHelperSource = NodeURL.fileURLToPath(
  new URL("../../../scripts/acp-thread-spawn-helper.c", import.meta.url),
);

const identity = (
  pid: number,
  ppid: number,
  pgid: number,
  sid: number,
  startTime = String(pid),
  state = "S",
): AcpPosixProcessIdentity => ({
  executable: `/proc/${pid}/exe`,
  pgid,
  pid,
  ppid,
  sid,
  startTime,
  state,
});

function makeController(input: {
  readonly processes: ReadonlyArray<AcpPosixProcessIdentity>;
  readonly onProcess?: (
    processes: Map<number, AcpPosixProcessIdentity>,
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
}) {
  const processes = new Map(input.processes.map((process) => [process.pid, process]));
  const signals: Array<string> = [];
  const controller: AcpPosixProcessTreeController = {
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("terminatePosixOwnedProcessTree", () => {
  it("parses unified cgroup paths and escaped cgroup2 mountinfo", () => {
    expect(parseUnifiedCgroupPath("0::/user.slice/app.scope\n")).toBe("/user.slice/app.scope");
    expect(parseUnifiedCgroupPath("0::/one\n0::/two\n")).toBeUndefined();
    expect(isSafeCgroupPath("/user.slice/app.scope")).toBe(true);
    expect(isSafeCgroupPath("/user.slice/../escape")).toBe(false);
    expect(isSafeCgroupPath("/user.slice/app.scope (deleted)")).toBe(false);
    expect(
      parseCgroup2Mount(
        "42 31 0:37 /user.slice /sys/fs/cgroup/user\\040mount rw - cgroup2 cgroup2 rw\n",
      ),
    ).toEqual({ mountPoint: "/sys/fs/cgroup/user mount", root: "/user.slice" });
    expect(parseCgroup2Mount("42 31 0:37 / /sys/fs/cgroup rw - tmpfs tmpfs rw\n")).toBeUndefined();
    expect(
      parseCgroup2Mounts(
        "41 31 0:36 /other /sys/fs/cgroup/other rw - cgroup2 cgroup2 rw\n" +
          "42 31 0:37 /user.slice /sys/fs/cgroup/user rw - cgroup2 cgroup2 rw\n",
      ),
    ).toHaveLength(2);
  });

  it.live("sweeps empty t3-acp sibling leases owned by dead pids only", () =>
    Effect.gen(function* () {
      const scratchRoot = NodePath.join(process.cwd(), "tmp");
      NodeFS.mkdirSync(scratchRoot, { recursive: true });
      const parent = NodeFS.mkdtempSync(NodePath.join(scratchRoot, "acp-cgroup-stale-siblings-"));
      // Temp dirs are not cgroupfs: rmdir fails when control files exist, so the
      // test injects populated/remove while still exercising the real selection
      // and path-safety logic against a real parent directory tree.
      const populatedByPath = new Map<string, "0" | "1">();
      const writeSibling = (name: string, populated: "0" | "1" | null) => {
        const path = NodePath.join(parent, name);
        NodeFS.mkdirSync(path);
        if (populated !== null) populatedByPath.set(path, populated);
        return path;
      };
      const deadPid = 2_147_483_646;
      // Synthetic live foreign pid (not this process, still reported alive by the probe).
      const liveForeignPid = 2_147_483_645;
      const staleEmpty = writeSibling(`t3-acp-${deadPid}-aaaa`, "0");
      const currentPidSibling = writeSibling(`t3-acp-${process.pid}-bbbb`, "0");
      const liveForeignSibling = writeSibling(`t3-acp-${liveForeignPid}-cccc`, "0");
      const stalePopulated = writeSibling(`t3-acp-${deadPid}-dddd`, "1");
      const unrelated = writeSibling("other-lease", "0");
      const isProcessAlive = (pid: number) => pid === process.pid || pid === liveForeignPid;
      try {
        sweepStaleLinuxCgroupSiblings(parent, {
          isProcessAlive,
          readPopulated: (path) => populatedByPath.get(path),
          remove: (path) => {
            populatedByPath.delete(path);
            NodeFS.rmdirSync(path);
          },
        });
        expect(NodeFS.existsSync(staleEmpty)).toBe(false);
        expect(NodeFS.existsSync(currentPidSibling)).toBe(true);
        expect(NodeFS.existsSync(liveForeignSibling)).toBe(true);
        expect(NodeFS.existsSync(stalePopulated)).toBe(true);
        expect(NodeFS.existsSync(unrelated)).toBe(true);
        // Missing populated state must not remove a sibling.
        writeSibling(`t3-acp-${deadPid}-eeee`, null);
        sweepStaleLinuxCgroupSiblings(parent, {
          isProcessAlive,
          readPopulated: (path) => populatedByPath.get(path),
          remove: (path) => {
            populatedByPath.delete(path);
            NodeFS.rmdirSync(path);
          },
        });
        expect(NodeFS.existsSync(NodePath.join(parent, `t3-acp-${deadPid}-eeee`))).toBe(true);
        expect(NodeFS.existsSync(currentPidSibling)).toBe(true);
      } finally {
        NodeFS.rmSync(parent, { recursive: true, force: true });
      }
    }),
  );

  it.live("preserves exact argv and strips wrapper-only environment before exec", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const lease = makeLinuxCgroupController().create();
      if (lease === undefined) return;
      const scratchRoot = NodePath.join(process.cwd(), "tmp");
      NodeFS.mkdirSync(scratchRoot, { recursive: true });
      const scratch = NodeFS.mkdtempSync(NodePath.join(scratchRoot, "acp-cgroup-wrapper-"));
      const linkedNode = NodePath.join(scratch, "T3 Code AppImage 'quoted'");
      const bareGrok = NodePath.join(scratch, "grok");
      const relativeBin = NodePath.join(scratch, "relative-bin");
      const directoryBin = NodePath.join(scratch, "directory-bin");
      const validBin = NodePath.join(scratch, "valid-bin");
      const outputPath = NodePath.join(scratch, "argv.json");
      NodeFS.mkdirSync(relativeBin);
      NodeFS.mkdirSync(NodePath.join(directoryBin, "grok"), { recursive: true });
      NodeFS.mkdirSync(validBin);
      NodeFS.symlinkSync(process.execPath, linkedNode);
      NodeFS.symlinkSync(process.execPath, bareGrok);
      NodeFS.symlinkSync(process.execPath, NodePath.join(relativeBin, "grok"));
      NodeFS.symlinkSync(process.execPath, NodePath.join(validBin, "grok"));
      expect(resolveLinuxCgroupTargetCommand("grok", scratch, { PATH: scratch })).toBe(bareGrok);
      expect(resolveLinuxCgroupTargetCommand("grok", scratch, { PATH: "" })).toBe(bareGrok);
      // Undefined PATH uses Node's default search path (/usr/bin:/bin), not cwd alone
      // (bareGrok lives only in cwd / PATH=scratch).
      expect(resolveLinuxCgroupTargetCommand("grok", scratch, { PATH: undefined })).toBeUndefined();
      expect(resolveLinuxCgroupTargetCommand("node", scratch, { PATH: undefined })).toBeDefined();
      expect(resolveLinuxCgroupTargetCommand("grok", scratch, { PATH: "relative-bin" })).toBe(
        NodePath.join(relativeBin, "grok"),
      );
      expect(
        resolveLinuxCgroupTargetCommand("grok", scratch, {
          PATH: `directory-bin${NodePath.delimiter}valid-bin`,
        }),
      ).toBe(NodePath.join(validBin, "grok"));
      const target = [
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.argv[1], JSON.stringify({",
        "  args: process.argv.slice(2),",
        "  electron: process.env.ELECTRON_RUN_AS_NODE,",
        "  wrapper: process.env.T3_ACP_CGROUP_WRAPPER,",
        "}));",
      ].join("\n");
      const wrapped = wrapCommandForLinuxCgroup(lease, linkedNode, [
        "-e",
        target,
        outputPath,
        "space value",
        "single'quote",
        'double"quote',
      ]);
      try {
        const result = NodeChildProcess.spawnSync(wrapped.command, wrapped.args, {
          encoding: "utf8",
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            T3_ACP_CGROUP_WRAPPER: "1",
          },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(NodeFS.readFileSync(outputPath, "utf8")).toBe(
          '{"args":["space value","single\'quote","double\\"quote"]}',
        );
      } finally {
        yield* terminateLinuxCgroupLease(lease).pipe(Effect.ignore);
        NodeFS.rmSync(scratch, { recursive: true, force: true });
      }
    }),
  );

  it.live("kills a post-TERM detached double fork without touching an unrelated sentinel", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const controller = makeLinuxCgroupController();
      const lease = controller.create();
      if (lease === undefined) return;
      expect(parseUnifiedCgroupPath(NodeFS.readFileSync("/proc/self/cgroup", "utf8"))).not.toBe(
        lease.relativePath,
      );
      const scratchRoot = NodePath.join(process.cwd(), "tmp");
      NodeFS.mkdirSync(scratchRoot, { recursive: true });
      const scratch = NodeFS.mkdtempSync(NodePath.join(scratchRoot, "acp-cgroup-kill-"));
      const readyPath = NodePath.join(scratch, "ready");
      const childPath = NodePath.join(scratch, "child");
      const childProgram = "setInterval(() => {}, 1000);";
      const launcherProgram = [
        'const fs = require("node:fs");',
        'const cp = require("node:child_process");',
        "const child = cp.spawn(process.execPath, ['-e', process.argv[2]], { detached: true, stdio: 'ignore' });",
        "fs.writeFileSync(process.argv[1], String(child.pid));",
        "child.unref();",
      ].join("\n");
      const providerProgram = [
        'const fs = require("node:fs");',
        'const cp = require("node:child_process");',
        "fs.writeFileSync(process.argv[1], String(process.pid));",
        "process.on('SIGTERM', () => {",
        "  const launcher = cp.spawn(process.execPath, ['-e', process.argv[3], process.argv[2], process.argv[4]], { detached: true, stdio: 'ignore' });",
        "  launcher.unref();",
        "  process.exit(0);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const wrapped = wrapCommandForLinuxCgroup(lease, process.execPath, [
        "-e",
        providerProgram,
        readyPath,
        childPath,
        launcherProgram,
        childProgram,
      ]);
      const provider = NodeChildProcess.spawn(wrapped.command, wrapped.args, {
        detached: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3_ACP_CGROUP_WRAPPER: "1" },
        stdio: "ignore",
      });
      provider.unref();
      const sentinel = NodeChildProcess.spawn(process.execPath, ["-e", childProgram], {
        detached: true,
        stdio: "ignore",
      });
      sentinel.unref();
      let detachedChildPid: number | undefined;
      try {
        yield* Effect.gen(function* () {
          while (!NodeFS.existsSync(readyPath)) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("2 seconds"));
        process.kill(provider.pid!, "SIGTERM");
        detachedChildPid = yield* Effect.gen(function* () {
          while (true) {
            try {
              const pid = Number(NodeFS.readFileSync(childPath, "utf8"));
              if (Number.isSafeInteger(pid) && pid > 1) return pid;
            } catch {
              // The TERM-time launcher has not published its child yet.
            }
            yield* Effect.sleep("10 millis");
          }
        }).pipe(Effect.timeout("2 seconds"));
        expect(processExists(detachedChildPid)).toBe(true);
        yield* terminateLinuxCgroupLease(lease);
        expect(processExists(sentinel.pid!)).toBe(true);
        yield* Effect.gen(function* () {
          while (processExists(detachedChildPid!)) yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("2 seconds"));
        expect(NodeFS.existsSync(lease.path)).toBe(false);

        const replacement = controller.create();
        expect(replacement?.path).not.toBe(lease.path);
        if (replacement !== undefined) {
          NodeFS.mkdirSync(NodePath.join(replacement.path, "nested"));
          yield* terminateLinuxCgroupLease(replacement);
          expect(NodeFS.existsSync(replacement.path)).toBe(false);
        }
      } finally {
        yield* terminateLinuxCgroupLease(lease).pipe(Effect.ignore);
        try {
          process.kill(-provider.pid!, "SIGKILL");
        } catch {
          // The contained provider already exited.
        }
        try {
          process.kill(-sentinel.pid!, "SIGKILL");
        } catch {
          // The unrelated sentinel already exited.
        }
        if (detachedChildPid !== undefined && processExists(detachedChildPid)) {
          try {
            process.kill(detachedChildPid, "SIGKILL");
          } catch {
            // The detached child already exited.
          }
        }
        NodeFS.rmSync(scratch, { recursive: true, force: true });
      }
    }),
  );

  it.live("re-kills repopulated cgroups and verifies root removal after retryable errors", () =>
    Effect.gen(function* () {
      let exists = true;
      let killCalls = 0;
      let populated = false;
      let removeCalls = 0;
      const lease: AcpLinuxCgroupLease = {
        contains: () => false,
        exists: () => exists,
        path: "/test/t3-acp-repopulation",
        relativePath: "/test/t3-acp-repopulation",
        kill: () => {
          killCalls += 1;
          populated = false;
        },
        populated: () => populated,
        remove: () => {
          removeCalls += 1;
          if (removeCalls === 1) {
            populated = true;
            const error = new Error("repopulated") as NodeJS.ErrnoException;
            error.code = "EBUSY";
            throw error;
          }
          if (removeCalls === 2) {
            const error = new Error("nested path vanished") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          exists = false;
        },
      };

      yield* terminateLinuxCgroupLease(lease);
      expect(killCalls).toBeGreaterThanOrEqual(3);
      expect(removeCalls).toBe(3);
      expect(exists).toBe(false);
      yield* terminateLinuxCgroupLease(lease);
      expect(removeCalls).toBe(3);
    }),
  );

  it("sends TERM only to the exact captured root while it remains in the child cgroup", () => {
    const fixture = makeController({
      processes: [server(), identity(100, process.pid, 100, 100, "owned")],
    });
    const ownedRoot: AcpOwnedPosixProcess = {
      ...identity(100, process.pid, 100, 100, "owned"),
      parentExecutable: server().executable,
      parentStartTime: server().startTime,
    };
    const root: AcpPosixOwnershipRoot = { captureAttempted: true, value: ownedRoot };
    const lease: AcpLinuxCgroupLease = {
      contains: () => true,
      exists: () => true,
      path: "/test/t3-acp-root",
      relativePath: "/test/t3-acp-root",
      kill: () => undefined,
      populated: () => true,
      remove: () => undefined,
    };
    signalLinuxCgroupRootTerm({ controller: fixture.controller, lease, root });
    expect(fixture.signals).toEqual(["process:100:SIGTERM"]);

    const reused = makeController({
      processes: [server(), identity(100, process.pid, 100, 100, "reused")],
    });
    signalLinuxCgroupRootTerm({ controller: reused.controller, lease, root });
    expect(reused.signals).toEqual([]);

    const migrated = makeController({
      processes: [server(), identity(100, process.pid, 100, 100, "owned")],
    });
    signalLinuxCgroupRootTerm({
      controller: migrated.controller,
      lease: { ...lease, contains: () => false },
      root,
    });
    expect(migrated.signals).toEqual([]);
  });

  it.live("finds a child forked by a non-leader pthread", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "linux") return;
      const scratchRoot = NodePath.join(process.cwd(), "tmp");
      NodeFS.mkdirSync(scratchRoot, { recursive: true });
      const scratch = NodeFS.mkdtempSync(NodePath.join(scratchRoot, "acp-pthread-spawn-"));
      const binary = NodePath.join(scratch, "helper");
      const pidPath = NodePath.join(scratch, "pids");
      expect(NodeFS.statSync(threadSpawnHelperSource).isFile()).toBe(true);
      const compile = NodeChildProcess.spawnSync(
        "cc",
        ["-pthread", threadSpawnHelperSource, "-o", binary],
        {
          encoding: "utf8",
        },
      );
      if ((compile.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        NodeFS.rmSync(scratch, { recursive: true, force: true });
        return;
      }
      expect(compile.status, compile.stderr).toBe(0);
      const helper = NodeChildProcess.spawn(binary, [pidPath], { detached: true, stdio: "ignore" });
      helper.unref();
      try {
        const published = yield* Effect.gen(function* () {
          while (true) {
            try {
              const ids = NodeFS.readFileSync(pidPath, "utf8").trim().split(/\s+/).map(Number);
              if (ids.length === 2 && ids.every(Number.isSafeInteger)) return ids;
            } catch {
              // The worker has not published its TID and child yet.
            }
            yield* Effect.sleep("10 millis");
          }
        }).pipe(Effect.timeout("2 seconds"));
        const [workerTid, childPid] = published;
        expect(workerTid).not.toBe(helper.pid);
        expect(makePosixProcessTreeController("linux").childrenOf(helper.pid!)).toContainEqual(
          expect.objectContaining({ pid: childPid, ppid: helper.pid }),
        );
      } finally {
        try {
          process.kill(-helper.pid!, "SIGKILL");
        } catch {
          // The isolated fixture already exited.
        }
        NodeFS.rmSync(scratch, { recursive: true, force: true });
      }
    }),
  );

  it.live("keeps ownership across a fork-before-exec executable transition", () =>
    Effect.gen(function* () {
      const beforeExec = { ...identity(110, 100, 110, 110), executable: "/provider/fork" };
      const fixture = makeController({
        processes: [server(), identity(100, process.pid, 100, 100), beforeExec],
      });
      const frontier = new Map<number, AcpOwnedPosixProcess>();
      const childQueues = new Map<number, Array<number>>();
      const ledger = new Map<string, AcpOwnedPosixProcess>();
      const root: AcpPosixOwnershipRoot = { value: undefined };
      observePosixOwnershipLedger({
        childQueues,
        controller: fixture.controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      });
      fixture.processes.set(110, { ...beforeExec, executable: "/usr/bin/bash" });
      observePosixOwnershipLedger({
        childQueues,
        controller: fixture.controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      });

      expect([...ledger.values()].find((process) => process.pid === 110)?.executable).toBe(
        "/usr/bin/bash",
      );
      yield* terminatePosixOwnedProcessTree({
        controller: fixture.controller,
        grace: 0,
        ledger,
        rootPid: 100,
      });
      expect(fixture.signals).toContain("process:110:SIGTERM");
      expect(fixture.processes.has(110)).toBe(false);
    }),
  );

  it("never adopts a replacement PID after initial root capture failed", () => {
    const fixture = makeController({ processes: [server()] });
    const frontier = new Map<number, AcpOwnedPosixProcess>();
    const childQueues = new Map<number, Array<number>>();
    const ledger = new Map<string, AcpOwnedPosixProcess>();
    const root: AcpPosixOwnershipRoot = { value: undefined };
    const capture = () => {
      try {
        observePosixOwnershipLedger({
          childQueues,
          controller: fixture.controller,
          frontier,
          ledger,
          root,
          rootPid: 100,
        });
        return undefined;
      } catch (error) {
        return error;
      }
    };
    expect(capture()).toMatchObject({
      detail: "ACP process 100 exited before its ownership ledger was captured",
    });
    fixture.processes.set(100, identity(100, process.pid, 100, 100, "reused"));
    expect(capture()).toMatchObject({
      detail: "ACP process 100 exited before its ownership ledger was captured",
    });
    expect(ledger.size).toBe(0);
  });

  it.live("rotates more than 64 live parents without scanning retained tombstones", () =>
    Effect.gen(function* () {
      const parents = Array.from({ length: 130 }, (_, index) =>
        identity(1_000 + index, 100, 1_000 + index, 1_000 + index),
      );
      let childListReads = 0;
      let identityCalls = 0;
      let snapshotCalls = 0;
      const fixture = makeController({
        processes: [server(), identity(100, process.pid, 100, 100)],
      });
      const controller: AcpPosixProcessTreeController = {
        ...fixture.controller,
        childPidsOf: (pid) => {
          childListReads += 1;
          return fixture.controller.childPidsOf(pid);
        },
        identity: (pid) => {
          identityCalls += 1;
          return fixture.controller.identity(pid);
        },
        snapshot: () => {
          snapshotCalls += 1;
          return fixture.controller.snapshot();
        },
      };
      const frontier = new Map<number, AcpOwnedPosixProcess>();
      const childQueues = new Map<number, Array<number>>();
      const ledger = new Map<string, AcpOwnedPosixProcess>();
      const root: AcpPosixOwnershipRoot = { value: undefined };
      for (let index = 0; index < 5_000; index += 1) {
        const tombstone = identity(100_000 + index, 1, 100_000 + index, 100_000 + index);
        ledger.set(`${tombstone.pid}:${tombstone.startTime}`, {
          ...tombstone,
          parentExecutable: undefined,
          parentStartTime: "",
        });
      }
      observePosixOwnershipLedger({
        childQueues,
        controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      });
      for (const parent of parents) {
        fixture.processes.set(parent.pid, parent);
        fixture.processes.set(
          parent.pid + 10_000,
          identity(parent.pid + 10_000, parent.pid, parent.pgid, parent.sid),
        );
      }
      let passes = 0;
      while (
        !parents.every((parent) =>
          [...ledger.values()].some((owned) => owned.pid === parent.pid + 10_000),
        ) &&
        passes < 40
      ) {
        childListReads = 0;
        identityCalls = 0;
        observePosixOwnershipLedger({
          childQueues,
          controller,
          frontier,
          ledger,
          maxProcesses: 64,
          root,
          rootPid: 100,
        });
        expect(identityCalls + childListReads).toBeLessThanOrEqual(64);
        passes += 1;
      }

      const missing = parents.filter(
        (parent) => ![...ledger.values()].some((owned) => owned.pid === parent.pid + 10_000),
      );
      expect(missing, `missing after ${passes} passes`).toEqual([]);
      expect(passes).toBeGreaterThan(2);
      yield* terminatePosixOwnedProcessTree({
        controller,
        grace: 0,
        ledger,
        rootPid: 100,
      });
      expect(snapshotCalls).toBe(10);
      expect(fixture.processes.size).toBe(1);
    }),
  );

  it.live("polls only known descendants and stops with its scope", () =>
    Effect.gen(function* () {
      let childrenCalls = 0;
      let identityCalls = 0;
      let snapshotCalls = 0;
      const fixture = makeController({
        processes: [server(), identity(100, process.pid, 100, 100), identity(110, 100, 110, 110)],
      });
      const controller: AcpPosixProcessTreeController = {
        ...fixture.controller,
        childPidsOf: (pid) => {
          childrenCalls += 1;
          return fixture.controller.childPidsOf(pid);
        },
        identity: (pid) => {
          identityCalls += 1;
          return fixture.controller.identity(pid);
        },
        snapshot: () => {
          snapshotCalls += 1;
          return fixture.controller.snapshot();
        },
      };
      const scope = yield* Scope.make();
      const frontier = new Map<number, AcpOwnedPosixProcess>();
      const childQueues = new Map<number, Array<number>>();
      let ledgerValuesCalls = 0;
      const ledger = new (class extends Map<string, AcpOwnedPosixProcess> {
        override values(): MapIterator<AcpOwnedPosixProcess> {
          ledgerValuesCalls += 1;
          return super.values();
        }
      })();
      const root: AcpPosixOwnershipRoot = { value: undefined };
      for (let index = 0; index < 5_000; index += 1) {
        const tombstone = identity(10_000 + index, 1, 10_000 + index, 10_000 + index);
        ledger.set(`${tombstone.pid}:${tombstone.startTime}`, {
          ...tombstone,
          parentExecutable: undefined,
          parentStartTime: "",
        });
      }
      yield* observePosixOwnershipLedgerContinuously({
        childQueues,
        controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      }).pipe(Effect.forkIn(scope));
      const timerStartedAt = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(0);
      const timerDelay = (yield* Clock.currentTimeMillis) - timerStartedAt;
      yield* Effect.sleep("80 millis");

      expect(timerDelay).toBeLessThan(250);
      expect(ledgerValuesCalls).toBe(0);
      expect(snapshotCalls).toBe(0);
      expect(childrenCalls).toBeGreaterThan(0);
      expect(childrenCalls).toBeLessThanOrEqual(12);
      const callsAtClose = identityCalls + childrenCalls;
      yield* Scope.close(scope, Exit.void);
      yield* Effect.sleep("60 millis");
      expect(identityCalls + childrenCalls).toBe(callsAtClose);
    }),
  );

  it.live("terminates nested owned groups bottom-up and catches a TERM fork race", () =>
    Effect.gen(function* () {
      let forked = false;
      const fixture = makeController({
        processes: [
          server(),
          identity(100, process.pid, 100, 100),
          identity(110, 100, 110, 110),
          identity(115, 110, 115, 110),
          identity(120, 110, 120, 120),
          identity(121, 120, 120, 120),
        ],
        onProcess: (processes, pid, signal) => {
          if (signal === "SIGTERM" && pid === 121 && !forked) {
            forked = true;
            processes.set(122, identity(122, 110, 122, 122));
          }
          processes.delete(pid);
        },
      });

      yield* terminatePosixOwnedProcessTree({
        controller: fixture.controller,
        grace: 0,
        rootPid: 100,
      });

      expect(fixture.processes.has(100)).toBe(false);
      expect(fixture.processes.has(122)).toBe(false);
      expect(fixture.signals.indexOf("process:121:SIGTERM")).toBeLessThan(
        fixture.signals.indexOf("process:120:SIGTERM"),
      );
      expect(fixture.signals.indexOf("process:115:SIGTERM")).toBeLessThan(
        fixture.signals.indexOf("process:110:SIGTERM"),
      );
    }),
  );

  it.live("falls back to exact PIDs for unknown group members and a missing leader", () =>
    Effect.gen(function* () {
      const unrelated = identity(999, 1, 110, 110, "unrelated");
      const fixture = makeController({
        processes: [
          server(),
          identity(100, process.pid, 100, 100),
          identity(110, 100, 110, 110),
          identity(111, 110, 110, 110),
          unrelated,
        ],
        onProcess: (processes, pid) => {
          processes.delete(pid);
          if (pid === 111) processes.delete(110);
        },
      });

      yield* terminatePosixOwnedProcessTree({
        controller: fixture.controller,
        grace: 0,
        rootPid: 100,
      });

      expect(fixture.signals).toContain("process:111:SIGTERM");
      expect(fixture.processes.get(999)).toEqual(unrelated);
    }),
  );

  it.live("re-admits a still-owned child after PID reuse and never signals the T3 session", () =>
    Effect.gen(function* () {
      const reused = identity(110, 100, 110, 110, "reused");
      const fixture = makeController({
        processes: [
          server(),
          identity(100, process.pid, 100, 100),
          identity(110, 100, 110, 110, "owned"),
          identity(120, 100, 120, process.pid),
        ],
        onProcess: (processes, pid) => {
          if (pid === 110) processes.set(110, reused);
          else processes.delete(pid);
        },
      });

      const result = yield* Effect.exit(
        terminatePosixOwnedProcessTree({
          controller: fixture.controller,
          grace: 0,
          rootPid: 100,
        }),
      );

      // PID 110 morphs to a new identity under the owned root and never exits, so
      // teardown fails closed after re-admitting and re-signalling the live child.
      expect(Exit.isFailure(result)).toBe(true);
      expect(fixture.processes.get(110)).toEqual(reused);
      expect(
        fixture.signals.filter((entry) => entry.startsWith("process:110:")).length,
      ).toBeGreaterThan(0);
      expect(fixture.signals.some((entry) => entry.includes(":120:"))).toBe(false);
    }),
  );

  it.live("does not treat zombie residual entries as teardown survivors", () =>
    Effect.gen(function* () {
      expect(posixProcessIsZombie({ ...identity(1, 0, 1, 1), state: "Z" })).toBe(true);
      expect(posixProcessIsZombie({ ...identity(1, 0, 1, 1), state: "S" })).toBe(false);
      const withoutState: AcpPosixProcessIdentity = {
        executable: "/proc/1/exe",
        pgid: 1,
        pid: 1,
        ppid: 0,
        sid: 1,
        startTime: "1",
      };
      expect(posixProcessIsZombie(withoutState)).toBe(false);

      const root = identity(100, process.pid, 100, 100);
      const zombieChild = identity(110, 100, 110, 110, "110", "Z");
      const fixture = makeController({
        processes: [server(), root, zombieChild],
        onProcess: (processes, pid) => {
          // Kill leaves a zombie with the same pid/starttime until reaped.
          const current = processes.get(pid);
          if (current === undefined) return;
          processes.set(pid, { ...current, state: "Z" });
        },
      });
      yield* terminatePosixOwnedProcessTree({
        controller: fixture.controller,
        grace: 0,
        rootPid: 100,
      });
      // Zombies remain visible but must not fail residual teardown.
      expect(fixture.processes.get(100)?.state).toBe("Z");
      expect(fixture.processes.get(110)?.state).toBe("Z");
    }),
  );

  it("admits a live child after a free PID was previously reserved by a dead entry", () => {
    const staleChild: AcpOwnedPosixProcess = {
      ...identity(200, 100, 200, 200, "stale-child"),
      parentExecutable: `/proc/100/exe`,
      parentStartTime: "100",
    };
    const liveChild = identity(200, 100, 200, 200, "live-child");
    const root = identity(100, process.pid, 100, 100);
    const ownedRoot: AcpOwnedPosixProcess = {
      ...root,
      parentExecutable: `/proc/${process.pid}/exe`,
      parentStartTime: "server",
    };
    const ledger = new Map<string, AcpOwnedPosixProcess>([
      [`100:${root.startTime}`, ownedRoot],
      [`200:${staleChild.startTime}`, staleChild],
    ]);
    const controller = makeController({
      processes: [server(), root],
    }).controller;

    // First capture: PID 200 is free, so the dead reservation is dropped.
    capturePosixOwnershipLedger({
      controller,
      ledger,
      rootPid: 100,
      table: [root],
    });
    expect([...ledger.values()].some((entry) => entry.pid === 200)).toBe(false);

    // Second capture: a new process reuses PID 200 under the owned parent.
    capturePosixOwnershipLedger({
      controller: makeController({ processes: [server(), root, liveChild] }).controller,
      ledger,
      rootPid: 100,
      table: [root, liveChild],
    });

    const admitted = [...ledger.values()].find((entry) => entry.pid === 200);
    expect(admitted?.startTime).toBe("live-child");
  });

  it("admits a live child when a stale ledger entry still occupies the reused PID", () => {
    const staleChild: AcpOwnedPosixProcess = {
      ...identity(200, 100, 200, 200, "stale-child"),
      parentExecutable: `/proc/100/exe`,
      parentStartTime: "100",
    };
    const liveChild = identity(200, 100, 200, 200, "live-child");
    const root = identity(100, process.pid, 100, 100);
    const ownedRoot: AcpOwnedPosixProcess = {
      ...root,
      parentExecutable: `/proc/${process.pid}/exe`,
      parentStartTime: "server",
    };
    const ledger = new Map<string, AcpOwnedPosixProcess>([
      [`100:${root.startTime}`, ownedRoot],
      [`200:${staleChild.startTime}`, staleChild],
    ]);

    capturePosixOwnershipLedger({
      controller: makeController({ processes: [server(), root, liveChild] }).controller,
      ledger,
      rootPid: 100,
      table: [root, liveChild],
    });

    expect([...ledger.values()].some((entry) => entry.startTime === "stale-child")).toBe(false);
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
          // Bottom-up: signal 111 first while 110 is still live, then fork 112
          // under 110 so the same pass must enqueue and signal 112.
          if (pid === 111 && !forked) {
            forked = true;
            processes.set(112, identity(112, 110, 112, 112));
          }
          processes.delete(pid);
        },
      });

      yield* terminatePosixOwnedProcessTree({
        controller: fixture.controller,
        grace: 0,
        rootPid: 100,
      });

      expect(forked).toBe(true);
      expect(fixture.processes.has(112)).toBe(false);
      expect(fixture.signals.some((entry) => entry.startsWith("process:112:"))).toBe(true);
    }),
  );

  it.live("retains the ledger across root exit and an explicit failure for finalizer retry", () =>
    Effect.gen(function* () {
      let ignoreSignals = true;
      const ledger = new Map<string, AcpOwnedPosixProcess>();
      const frontier = new Map<number, AcpOwnedPosixProcess>();
      const childQueues = new Map<number, Array<number>>();
      const root: AcpPosixOwnershipRoot = { value: undefined };
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
      observePosixOwnershipLedger({
        childQueues,
        controller: fixture.controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      });

      const explicit = yield* Effect.exit(
        terminatePosixOwnedProcessTree({
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
      observePosixOwnershipLedger({
        childQueues,
        controller: fixture.controller,
        frontier,
        ledger,
        root,
        rootPid: 100,
      });
      ignoreSignals = false;
      yield* terminatePosixOwnedProcessTree({
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
      makePosixProcessTreeController("darwin");
      throw new Error("Expected Darwin process ownership to fail closed");
    } catch (error) {
      expect(error).toMatchObject({
        detail: "Detached ACP descendant ownership is unsupported on darwin",
      });
    }
  });
});
