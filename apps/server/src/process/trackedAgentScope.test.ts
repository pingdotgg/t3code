// @effect-diagnostics nodeBuiltinImport:off -- the agents and their escaped jobs are real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  make,
  parsePosixProcessRows,
  parseWindowsProcessRows,
  trackedProcesses,
} from "./trackedAgentScope.ts";

describe("process table", () => {
  it("reads ps and Windows rows as start times", () => {
    expect(
      parsePosixProcessRows(
        "  412     1 Mon Nov  9 03:46:26 2026\nbad\n 7 412 Tue Nov 10 10:00:00 2026\n",
      ),
    ).toEqual([
      { pid: 412, ppid: 1, started: Date.parse("2026-11-09T03:46:26Z") },
      { pid: 7, ppid: 412, started: Date.parse("2026-11-10T10:00:00Z") },
    ]);
    expect(parseWindowsProcessRows("412|4|134076419860000000\r\nnoise\r\n")).toEqual([
      { pid: 412, ppid: 4, started: Date.parse("2025-11-15T00:59:46Z") },
    ]);
  });

  it("follows descendants through dead parents but not through reused pids", () => {
    const rows = [
      { pid: 10, ppid: 1, started: 100 },
      // The job's shell is gone; its own child is still recorded.
      { pid: 30, ppid: 1, started: 300 },
      { pid: 31, ppid: 30, started: 310 },
      // Windows keeps a dead parent's pid, which a newer process may reuse.
      { pid: 40, ppid: 10, started: 50 },
      { pid: 20, ppid: 10, started: 200 },
      // A recorded pid now running something else.
      { pid: 50, ppid: 1, started: 999 },
    ];
    expect(
      trackedProcesses(
        rows,
        new Map([
          [10, 100],
          [30, 300],
          [50, 500],
        ]),
      ),
    ).toEqual(
      new Map([
        [10, 100],
        [30, 300],
        [31, 310],
        [20, 200],
      ]),
    );
  });
});

const tempRoot = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-tracked-scope-"));

/**
 * An agent whose tool shell starts a job in its own group. The job holds fd 3
 * and the shell fd 4, socket pipes to this test, so each exit arrives as EOF.
 */
const startAgent = (root: string, label: string, pids: Array<number>) => {
  const dir = NodePath.join(root, label);
  const file = (name: string) => NodePath.join(dir, name);
  NodeFS.mkdirSync(dir);
  NodeFS.writeFileSync(
    file("agent.sh"),
    '"$(dirname "$0")/shell.sh" &\nexec 3>&- 4>&-\nexec sleep 600\n',
  );
  NodeFS.writeFileSync(
    file("shell.sh"),
    [
      "#!/bin/sh",
      `perl -e 'setpgrp(0, 0); exec @ARGV' "$(dirname "$0")/job.sh" 4>&- &`,
      "exec 3>&-",
      "read -r _ <&4",
    ].join("\n"),
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(file("job.sh"), "#!/bin/sh\necho $$ >&3\nexec sleep 600\n", {
    mode: 0o755,
  });
  const agent = NodeChildProcess.spawn("/bin/sh", [file("agent.sh")], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  pids.push(agent.pid!);
  const [job, shell] = [agent.stdio[3], agent.stdio[4]] as Array<NodeNet.Socket>;
  const ended = (pipe: NodeNet.Socket) =>
    new Promise<void>((resolve) => pipe.once("end", () => resolve()));
  const jobPid = new Promise<number>((resolve) =>
    job!.setEncoding("utf8").once("data", (line: string) => resolve(Number(line.trim()))),
  );
  void jobPid.then((pid) => pids.push(pid));
  const jobStopped = ended(job!);
  const shellExited = ended(shell!.resume());
  return {
    pid: agent.pid!,
    exited: new Promise<void>((resolve) => agent.once("exit", () => resolve())),
    jobStopped,
    jobPid: () => Effect.promise(() => jobPid),
    /** Waits for the job, then lets its shell exit so the job is orphaned. */
    escape: (recordWhileShellRuns: Effect.Effect<void>) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => jobPid);
        job!.resume();
        yield* recordWhileShellRuns;
        shell!.write("\n");
        yield* Effect.promise(() => shellExited);
      }),
  };
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Tracks the fixture's processes and kills what is left even when the test fails. */
const fixture = Effect.acquireRelease(
  Effect.sync(() => ({ root: tempRoot(), pids: [] as Array<number> })),
  ({ root, pids }) =>
    Effect.sync(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      NodeFS.rmSync(root, { recursive: true, force: true });
    }),
);

const services = Layer.mergeAll(
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-tracked-scope-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("tracked agent scope", () => {
  it.live("stops only the exited session's escaped jobs", () =>
    Effect.gen(function* () {
      const { root, pids } = yield* fixture;
      const { scope, refresh } = yield* make;
      const launch = (label: string, threadId: string) =>
        Effect.gen(function* () {
          const { unit } = yield* scope.wrap({ command: "sh", args: [], name: "t", threadId });
          const agent = startAgent(root, label, pids);
          yield* scope.adopt(unit!, agent.pid);
          return { ...agent, unit: unit! };
        });
      const first = yield* launch("first", "a");
      const sibling = yield* launch("sibling", "b");
      yield* scope.clear("a");
      const newer = yield* launch("newer", "a");
      for (const agent of [first, sibling, newer]) yield* agent.escape(refresh);

      process.kill(first.pid, "SIGKILL");
      yield* Effect.promise(() => first.exited);
      yield* scope.stop(first.unit);
      yield* Effect.promise(() => first.jobStopped);
      for (const agent of [sibling, newer]) {
        assert.isTrue(isRunning(agent.pid));
        assert.isTrue(isRunning(yield* agent.jobPid()));
      }
    }).pipe(Effect.provide(services)),
  );

  it.live("force stop kills the thread's newest session without a systemd unit", () =>
    Effect.gen(function* () {
      const { root, pids } = yield* fixture;
      const { scope, refresh } = yield* make;
      const launch = (label: string, threadId: string) =>
        Effect.gen(function* () {
          const { unit } = yield* scope.wrap({ command: "sh", args: [], name: "t", threadId });
          const agent = startAgent(root, label, pids);
          yield* scope.adopt(unit!, agent.pid);
          return agent;
        });
      const agent = yield* launch("agent", "a");
      const sibling = yield* launch("sibling", "b");
      for (const each of [agent, sibling]) yield* each.escape(refresh);

      assert.isTrue(yield* scope.kill("a"));
      yield* Effect.promise(() => Promise.all([agent.exited, agent.jobStopped]));
      assert.isTrue(isRunning(sibling.pid));
      assert.isTrue(isRunning(yield* sibling.jobPid()));
      assert.isFalse(yield* scope.kill("unknown"));
    }).pipe(Effect.provide(services)),
  );

  it.live("a restarted server stops what a dead one tracked and spares a live one's", () =>
    Effect.gen(function* () {
      const { root, pids } = yield* fixture;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const records = NodePath.join(stateDir, "agent-processes");
      // The first server stops without cleaning up, as a crashed one would.
      const orphaned = yield* Effect.scoped(
        Effect.gen(function* () {
          const { scope, refresh } = yield* make;
          const { unit } = yield* scope.wrap({ command: "sh", args: [], name: "t", threadId: "a" });
          const agent = startAgent(root, "orphaned", pids);
          yield* scope.adopt(unit!, agent.pid);
          yield* agent.escape(refresh);
          return agent;
        }),
      );
      const [record] = NodeFS.readdirSync(records);
      const deadServer = NodeChildProcess.spawnSync("true").pid;
      const recorded = NodeFS.readFileSync(NodePath.join(records, record!), "utf8").split("\n");
      NodeFS.writeFileSync(
        NodePath.join(records, record!),
        [`${deadServer}\t0`, ...recorded.slice(1)].join("\n"),
      );

      // Another server still running on this state keeps its agents.
      const startedOf = (pid: number) =>
        parsePosixProcessRows(
          NodeChildProcess.execFileSync("ps", ["-o", "pid=,ppid=,lstart=", "-p", `${pid}`], {
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          }).toString(),
        )[0]!.started;
      const liveServer = NodeChildProcess.spawn("sleep", ["600"], { stdio: "ignore" });
      const liveAgent = NodeChildProcess.spawn("sleep", ["600"], { stdio: "ignore" });
      pids.push(liveServer.pid!, liveAgent.pid!);
      const liveRecord = NodePath.join(records, "f".repeat(32));
      NodeFS.writeFileSync(
        liveRecord,
        `${liveServer.pid}\t${startedOf(liveServer.pid!)}\n` +
          `${liveAgent.pid}\t${startedOf(liveAgent.pid!)}\n`,
      );

      yield* (yield* make).ready;
      yield* Effect.promise(() => orphaned.jobStopped);
      assert.isTrue(isRunning(liveAgent.pid!));
      expect(NodeFS.readdirSync(records)).toEqual(["f".repeat(32)]);
    }).pipe(Effect.provide(services)),
  );
});
