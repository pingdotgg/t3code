// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Process fixtures exercise captured children and native watchdog deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "@effect/vitest";
import type { CodeModeCall } from "@t3tools/contracts";
import { CodeModeProcess, spawnCodeModeHost } from "./CodeModeProcess.ts";

const base = { code: "return 1", tools: ["test"], invoke: async () => null };
const input = () => ({
  ...base,
  calls: [] as Array<CodeModeCall>,
  logs: [] as Array<string>,
  signal: new AbortController().signal,
});

it("shares one process across five scripts and reuses threads with fresh guest heaps", async () => {
  let spawns = 0;
  const pool = new CodeModeProcess(() => {
    spawns++;
    return spawnCodeModeHost();
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hosts: Array<{ pid: number; threadId: number }> = [];
  let calls = 0;
  try {
    const evaluations = Array.from({ length: 5 }, (_, n) =>
      pool.execute({
        ...input(),
        code: `globalThis.previous = ${n}; return await t3.test({n:${n}});`,
        onStarted: (host) => hosts.push(host),
        invoke: async (_name, args) => {
          if (++calls === 5) started.resolve();
          await release.promise;
          return args;
        },
      }),
    );
    await started.promise;
    expect(spawns).toBe(1);
    expect(new Set(hosts.map((host) => host.pid)).size).toBe(1);
    expect(new Set(hosts.map((host) => host.threadId)).size).toBe(5);
    expect(hosts[0]?.pid).not.toBe(process.pid);
    expect(await pool.stats()).toMatchObject({ pid: hosts[0]?.pid, workers: 5 });
    release.resolve();
    expect(await Promise.all(evaluations)).toEqual(Array.from({ length: 5 }, (_, n) => ({ n })));
    const reused: Array<number> = [];
    for (let n = 0; n < 3; n++) {
      expect(
        await pool.execute({
          ...input(),
          code: "return typeof previous;",
          onStarted: (host) => reused.push(host.threadId),
        }),
      ).toBe("undefined");
    }
    expect(new Set(reused).size).toBe(1);
    expect(hosts.map((host) => host.threadId)).toContain(reused[0]);
    expect(spawns).toBe(1);
  } finally {
    release.resolve();
    await pool.dispose();
  }
  expect(() => process.kill(hosts[0]!.pid, 0)).toThrow();
});

it("terminates a CPU-bound evaluation without interrupting a sibling or the server", async () => {
  const pool = new CodeModeProcess();
  const controller = new AbortController();
  const spinning = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let finished = false;
  let pid = 0;
  try {
    const sibling = pool.execute({
      ...input(),
      code: "return await t3.test({});",
      invoke: async () => {
        started.resolve();
        await release.promise;
        return "sibling survived";
      },
    });
    await started.promise;
    const execution = pool.execute({
      ...input(),
      signal: controller.signal,
      code: "console.log('spinning'); while(true) {}",
      onReady: (value) => {
        pid = value;
      },
      onLog: () => spinning.resolve(),
    });
    void execution.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await spinning.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    controller.abort();
    await expect(execution).rejects.toThrow("cancelled");
    expect(await pool.stats()).toMatchObject({ pid, workers: 2 });
    release.resolve();
    expect(await sibling).toBe("sibling survived");
    expect(await pool.execute(input())).toBe(1);
  } finally {
    release.resolve();
    controller.abort();
    await pool.dispose();
  }
});

it("bounds the worker pool to eight active evaluations", async () => {
  const pool = new CodeModeProcess();
  const started = Promise.withResolvers<void>();
  let count = 0;
  const evaluations = Array.from({ length: 8 }, () =>
    pool.execute({
      ...input(),
      code: "await new Promise(()=>{});",
      onStarted: () => {
        if (++count === 8) started.resolve();
      },
    }),
  );
  const results = Promise.allSettled(evaluations);
  try {
    await started.promise;
    expect(() => pool.execute(input())).toThrow("capacity");
    expect(await pool.stats()).toMatchObject({ workers: 8 });
  } finally {
    await pool.dispose();
    await results;
  }
});

it("disposes each native heap while retaining the same host and reusable thread", async () => {
  const pool = new CodeModeProcess();
  const threads = new Set<number>();
  const pids = new Set<number>();
  try {
    for (let n = 0; n < 101; n++) {
      expect(
        await pool.execute({
          ...input(),
          code: "globalThis.previous = 1; return 1;",
          onStarted: (host) => {
            threads.add(host.threadId);
            pids.add(host.pid);
          },
        }),
      ).toBe(1);
    }
    expect(threads.size).toBe(1);
    expect(pids.size).toBe(1);
    expect(await pool.stats()).toMatchObject({ workers: 1 });
    expect(await pool.execute({ ...input(), code: "return typeof previous;" })).toBe("undefined");
  } finally {
    await pool.dispose();
  }
});

it("retains accepted results after a host crash and starts a replacement without replay", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-host-crash-"));
  const path = NodePath.join(directory, "host.mjs");
  await NodeFSP.writeFile(
    path,
    `
    import {createInterface} from 'node:readline';
    process.stdout.write(JSON.stringify({type:'ready',pid:process.pid})+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.type==='start') {
        process.stdout.write(JSON.stringify({type:'started',executionId:m.executionId,threadId:1})+'\\n');
        process.stdout.write(JSON.stringify({type:'call',executionId:m.executionId,id:0,tool:'test',args:{}})+'\\n');
      } else if(m.type==='reply') process.exit(23);
    });
  `,
  );
  let spawns = 0,
    invoked = 0;
  const pool = new CodeModeProcess(() =>
    ++spawns === 1
      ? NodeChildProcess.spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] })
      : spawnCodeModeHost(),
  );
  const calls: Array<CodeModeCall> = [];
  let persisted = false;
  try {
    await expect(
      pool.execute({
        ...input(),
        calls,
        invoke: async () => {
          invoked++;
          return { accepted: true };
        },
        checkpoint: async () => {
          if (calls[0]?.status === "completed") persisted = true;
        },
      }),
    ).rejects.toThrow("unexpectedly");
    expect(persisted).toBe(true);
    expect(calls[0]).toMatchObject({ status: "completed", result: { accepted: true } });
    expect(await pool.execute({ ...input(), code: "return 3" })).toBe(3);
    expect(spawns).toBe(2);
    expect(invoked).toBe(1);
  } finally {
    await pool.dispose();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("kills a host that never acknowledges evaluation cancellation", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-code-host-hang-"));
  const path = NodePath.join(directory, "host.mjs");
  await NodeFSP.writeFile(
    path,
    "process.stdout.write(JSON.stringify({type:'ready',pid:process.pid})+'\\n'); process.stdin.resume();",
  );
  const ready = Promise.withResolvers<number>();
  const controller = new AbortController();
  const pool = new CodeModeProcess(() =>
    NodeChildProcess.spawn(process.execPath, [path], { stdio: ["pipe", "pipe", "pipe"] }),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const execution = pool.execute({
      ...input(),
      signal: controller.signal,
      onReady: (pid) => ready.resolve(pid),
    });
    const pid = await ready.promise;
    // Let the server enqueue start, then cancel. No sleeps or host-response polling.
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(execution).rejects.toThrow("cancelled");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await pool.dispose();
    vi.useRealTimers();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
