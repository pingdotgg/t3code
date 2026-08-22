// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeTimers from "node:timers";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  makeSpawnedProcessReaper,
  SIDECAR_SOURCE,
  type SpawnedProcessReaperEntry,
  SpawnedProcessReaperError,
  type SpawnedProcessReaperSidecar,
  type SpawnedProcessReaperSpawner,
  windowsTaskkillArgs,
} from "./SpawnedProcessReaper.ts";

const dummySource = "setInterval(() => {}, 1000);";

// oxlint-disable-next-line t3code/no-global-process-runtime -- These tests must skip POSIX-only process-group assertions on Windows.
const isWindows = process.platform === "win32";

function spawnDummy(): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(process.execPath, ["-e", dummySource], {
    detached: true,
    stdio: "ignore",
  });
}

function spawnSidecar(): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(process.execPath, ["-e", SIDECAR_SOURCE], {
    detached: true,
    windowsHide: isWindows,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

const shortLivedParentSource = `
"use strict";
const { spawn } = require("node:child_process");
const sidecar = spawn(process.execPath, ["-e", process.env.SIDECAR_SOURCE], {
  detached: true,
  stdio: ["pipe", "ignore", "ignore"],
});
sidecar.unref();
process.stdout.write(String(sidecar.pid) + "\\n");
sidecar.stdin.end(process.env.TRACK_MESSAGE, () => setTimeout(() => process.exit(0), 250));
`;

function spawnSidecarFromShortLivedParent(track: string): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(process.execPath, ["-e", shortLivedParentSource], {
    env: { ...process.env, SIDECAR_SOURCE, TRACK_MESSAGE: track },
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readSpawnedPid(parent: NodeChildProcess.ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const stdout = parent.stdout;
    if (stdout === null) {
      reject(new Error("Short-lived sidecar parent did not expose stdout"));
      return;
    }
    let output = "";
    stdout.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
      const pid = Number(output.trim());
      if (Number.isFinite(pid)) resolve(pid);
    });
    parent.once("error", reject);
  });
}

function waitForMs(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    // @effect-diagnostics-next-line globalTimers:off
    NodeTimers.setTimeout(resolve, timeoutMs);
  });
}

function waitForExit(child: NodeChildProcess.ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // @effect-diagnostics-next-line globalTimers:off
    const timeout = NodeTimers.setTimeout(() => {
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      reject(new Error(`Process ${String(child.pid)} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      NodeTimers.clearTimeout(timeout);
      resolve();
    };
    const onError = (cause: Error) => {
      NodeTimers.clearTimeout(timeout);
      reject(cause);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killForCleanup(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  child.kill("SIGKILL");
  await waitForExit(child, 5_000).catch(() => undefined);
}

async function killPidForCleanup(pid: number | null): Promise<void> {
  if (pid === null || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
    await waitForMs(50);
  }
}

function trackMessage(entry: SpawnedProcessReaperEntry): string {
  return `${JSON.stringify({ op: "track", ...entry })}\n`;
}

function untrackMessage(pid: number): string {
  return `${JSON.stringify({ op: "untrack", pid })}\n`;
}

interface FakeSpawnerOptions {
  readonly exitImmediately?: boolean;
  readonly failSpawns?: ReadonlySet<number>;
  readonly failWriteMessageIndicesForSpawn?: ReadonlyMap<number, ReadonlySet<number>>;
  readonly failWritesForSpawn?: ReadonlySet<number>;
}

function makeFakeSpawner(options: FakeSpawnerOptions = {}) {
  const spawnSignals = Array.from({ length: 16 }, () => Deferred.makeUnsafe<void>());
  let spawnAttempts = 0;
  const sidecars: Array<{
    readonly exit: Deferred.Deferred<number | null>;
    readonly messages: Array<string>;
    readonly messageSignals: Array<Deferred.Deferred<void>>;
    ended: boolean;
    terminated: boolean;
    readonly handle: SpawnedProcessReaperSidecar;
  }> = [];
  const spawner: SpawnedProcessReaperSpawner = {
    spawn: () =>
      Effect.suspend(() => {
        const spawnIndex = spawnAttempts;
        spawnAttempts += 1;
        if (options.failSpawns?.has(spawnIndex)) {
          Deferred.doneUnsafe(spawnSignals[spawnIndex]!, Effect.void);
          return Effect.fail(
            new SpawnedProcessReaperError({
              operation: "spawn",
              cause: `sidecar spawn ${spawnIndex} failed`,
            }),
          );
        }
        return Effect.sync(() => {
          const sidecarIndex = sidecars.length;
          const exit = Deferred.makeUnsafe<number | null>();
          const state = {
            exit,
            messages: [] as Array<string>,
            messageSignals: Array.from({ length: 8 }, () => Deferred.makeUnsafe<void>()),
            ended: false,
            terminated: false,
            handle: undefined as unknown as SpawnedProcessReaperSidecar,
          };
          state.handle = {
            stdin: {
              write: (chunk) => {
                const messageIndex = state.messages.length;
                if (
                  options.failWritesForSpawn?.has(sidecarIndex) ||
                  options.failWriteMessageIndicesForSpawn?.get(sidecarIndex)?.has(messageIndex) ===
                    true
                ) {
                  throw new Error(`sidecar ${sidecarIndex} write failed`);
                }
                state.messages.push(chunk);
                Deferred.doneUnsafe(state.messageSignals[messageIndex]!, Effect.void);
                return true;
              },
              end: () => {
                state.ended = true;
              },
            },
            exitCode: Deferred.await(exit),
            terminate: Effect.sync(() => {
              state.terminated = true;
              Deferred.doneUnsafe(exit, Effect.succeed(null));
            }),
          };
          sidecars.push(state);
          Deferred.doneUnsafe(spawnSignals[spawnIndex]!, Effect.void);
          if (options.exitImmediately) {
            Deferred.doneUnsafe(exit, Effect.succeed(1));
          }
          return state.handle;
        });
      }),
  };
  return {
    get spawnAttempts() {
      return spawnAttempts;
    },
    sidecars,
    spawnSignals,
    spawner,
  };
}

const posixEntry: SpawnedProcessReaperEntry = {
  pid: 100,
  pgid: 100,
  platform: "posix",
};

describe("SpawnedProcessReaper sidecar", () => {
  it("treats parent reparenting as death before PID liveness", () => {
    assert.isTrue(SIDECAR_SOURCE.includes("if (process.ppid !== parentPid) return true;"));
  });

  it("exits nonzero when its stdin errors", () => {
    assert.isTrue(SIDECAR_SOURCE.includes('process.stdin.on("error", () => process.exit(1));'));
  });

  it.skipIf(isWindows)(
    "reaps tracked process trees after the parent dies at stdin EOF",
    async () => {
      const dummy = spawnDummy();
      const parent = spawnSidecarFromShortLivedParent(
        trackMessage({ pid: dummy.pid!, pgid: dummy.pid!, platform: "posix" }).trimEnd(),
      );
      let sidecarPid: number | null = null;
      try {
        sidecarPid = await readSpawnedPid(parent);
        await waitForExit(parent, 5_000);
        await waitForExit(dummy, 5_000);
        assert.isFalse(isProcessAlive(dummy.pid!));
      } finally {
        await killForCleanup(parent);
        await killPidForCleanup(sidecarPid);
        await killForCleanup(dummy);
      }
    },
  );

  it.skipIf(isWindows)("does not reap tracked processes while the parent is alive", async () => {
    const dummy = spawnDummy();
    const sidecar = spawnSidecar();
    try {
      sidecar.stdin!.write(trackMessage({ pid: dummy.pid!, pgid: dummy.pid!, platform: "posix" }));
      sidecar.stdin!.end();
      await waitForMs(2_500);
      assert.isTrue(isProcessAlive(dummy.pid!));
    } finally {
      await killForCleanup(sidecar);
      await killForCleanup(dummy);
    }
  });

  it.skipIf(isWindows)("does not reap an explicitly untracked process", async () => {
    const dummy = spawnDummy();
    const sidecar = spawnSidecar();
    try {
      sidecar.stdin!.write(trackMessage({ pid: dummy.pid!, pgid: dummy.pid!, platform: "posix" }));
      sidecar.stdin!.write(untrackMessage(dummy.pid!));
      sidecar.stdin!.end();
      await waitForMs(2_500);
      assert.isTrue(isProcessAlive(dummy.pid!));
    } finally {
      await killForCleanup(sidecar);
      await killForCleanup(dummy);
    }
  });

  it.skipIf(isWindows)("does not reap tracked processes after shutdown", async () => {
    const dummy = spawnDummy();
    const sidecar = spawnSidecar();
    try {
      sidecar.stdin!.write(trackMessage({ pid: dummy.pid!, pgid: dummy.pid!, platform: "posix" }));
      sidecar.stdin!.write('{"op":"shutdown"}\n');
      sidecar.stdin!.end();
      await waitForExit(sidecar, 2_000);
      assert.isTrue(isProcessAlive(dummy.pid!));
    } finally {
      await killForCleanup(sidecar);
      await killForCleanup(dummy);
    }
  });
});

describe("SpawnedProcessReaper service", () => {
  it.effect("spawns lazily, re-feeds its mirror after sidecar death, and untracks", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
          assert.lengthOf(fake.sidecars, 1);
          assert.deepStrictEqual(fake.sidecars[0]!.messages, [trackMessage(posixEntry)]);

          const secondEntry = { ...posixEntry, pid: 101, pgid: 101 };
          yield* reaper.track(secondEntry);
          yield* Deferred.succeed(fake.sidecars[0]!.exit, 1);
          yield* Deferred.await(fake.spawnSignals[1]!);
          yield* Deferred.await(fake.sidecars[1]!.messageSignals[1]!);

          assert.lengthOf(fake.sidecars, 2);
          assert.deepStrictEqual(fake.sidecars[1]!.messages, [
            trackMessage(posixEntry),
            trackMessage(secondEntry),
          ]);
          yield* reaper.untrack(posixEntry.pid);
          assert.deepStrictEqual(fake.sidecars[1]!.messages.at(-1), untrackMessage(posixEntry.pid));
        }),
      );
    }),
  );

  it.effect("gives up after three rapid sidecar deaths", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({ exitImmediately: true });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
          yield* Deferred.await(fake.spawnSignals[2]!);
          yield* TestClock.adjust("1 millis");
          assert.lengthOf(fake.sidecars, 3);
        }),
      );
    }),
  );

  it.effect("resets the respawn budget after a sidecar outlives the window", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);

          yield* Deferred.succeed(fake.sidecars[0]!.exit, 1);
          yield* Deferred.await(fake.spawnSignals[1]!);
          yield* Deferred.await(fake.sidecars[1]!.messageSignals[0]!);

          yield* Deferred.succeed(fake.sidecars[1]!.exit, 1);
          yield* Deferred.await(fake.spawnSignals[2]!);
          yield* Deferred.await(fake.sidecars[2]!.messageSignals[0]!);

          yield* TestClock.adjust("60 seconds");
          yield* TestClock.adjust("1 millis");
          yield* Deferred.succeed(fake.sidecars[2]!.exit, 1);
          yield* Deferred.await(fake.spawnSignals[3]!);
          yield* Deferred.await(fake.sidecars[3]!.messageSignals[0]!);

          assert.lengthOf(fake.sidecars, 4);
        }),
      );
    }),
  );

  it.effect("replaces a sidecar after a write failure and re-feeds the mirror", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({ failWritesForSpawn: new Set([0]) });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
          assert.lengthOf(fake.sidecars, 2);
          assert.isTrue(fake.sidecars[0]!.terminated);
          assert.deepStrictEqual(fake.sidecars[1]!.messages, [trackMessage(posixEntry)]);
        }),
      );
    }),
  );

  it.effect("terminates a sidecar that retains a failed untrack", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({
        failWriteMessageIndicesForSpawn: new Map([[0, new Set([1])]]),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
          yield* reaper.untrack(posixEntry.pid);

          assert.lengthOf(fake.sidecars, 1);
          assert.isTrue(fake.sidecars[0]!.terminated);
          assert.deepStrictEqual(fake.sidecars[0]!.messages, [trackMessage(posixEntry)]);
        }),
      );
    }),
  );

  it.effect("retries a failed initial spawn while tracked work remains", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({ failSpawns: new Set([0]) });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
          assert.lengthOf(fake.sidecars, 0);

          yield* Effect.yieldNow;
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(fake.spawnSignals[1]!);
          yield* Deferred.await(fake.sidecars[0]!.messageSignals[0]!);

          assert.lengthOf(fake.sidecars, 1);
          assert.deepStrictEqual(fake.sidecars[0]!.messages, [trackMessage(posixEntry)]);
        }),
      );
    }),
  );

  it.effect("keeps spawn retries separate from the sidecar crash budget", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({ failSpawns: new Set([0, 1]) });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);

          yield* TestClock.adjust("100 millis");
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(fake.spawnSignals[2]!);
          yield* Deferred.await(fake.sidecars[0]!.messageSignals[0]!);

          yield* Deferred.succeed(fake.sidecars[0]!.exit, 1);
          yield* Deferred.await(fake.spawnSignals[3]!);
          yield* Deferred.await(fake.sidecars[1]!.messageSignals[0]!);

          assert.lengthOf(fake.sidecars, 2);
          assert.deepStrictEqual(fake.sidecars[1]!.messages, [trackMessage(posixEntry)]);
        }),
      );
    }),
  );

  it.effect("allows a fresh workload after exhausting initial spawn retries", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({ failSpawns: new Set([0, 1, 2]) });
      const freshEntry = { ...posixEntry, pid: 101, pgid: 101 };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);

          yield* TestClock.adjust("100 millis");
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(fake.spawnSignals[2]!);
          yield* reaper.untrack(posixEntry.pid);
          yield* reaper.track(freshEntry);
          yield* Deferred.await(fake.spawnSignals[3]!);
          yield* Deferred.await(fake.sidecars[0]!.messageSignals[0]!);

          assert.deepStrictEqual(fake.sidecars[0]!.messages, [trackMessage(freshEntry)]);
        }),
      );
    }),
  );

  it.effect("retries the tracked workload after the initial spawn cooldown", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({ failSpawns: new Set([0, 1, 2]) });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);

          yield* TestClock.adjust("100 millis");
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(fake.spawnSignals[2]!);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("59 seconds");
          assert.strictEqual(fake.spawnAttempts, 3);
          assert.lengthOf(fake.sidecars, 0);

          yield* TestClock.adjust("1 second");
          yield* Deferred.await(fake.spawnSignals[3]!);
          yield* Deferred.await(fake.sidecars[0]!.messageSignals[0]!);

          assert.deepStrictEqual(fake.sidecars[0]!.messages, [trackMessage(posixEntry)]);
        }),
      );
    }),
  );

  it.effect("sends shutdown and closes stdin during finalization", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
        }),
      );
      assert.deepStrictEqual(fake.sidecars[0]!.messages, [
        trackMessage(posixEntry),
        '{"op":"shutdown"}\n',
      ]);
      assert.isTrue(fake.sidecars[0]!.ended);
    }),
  );

  it.effect("terminates a sidecar when its shutdown write fails", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner({
        failWriteMessageIndicesForSpawn: new Map([[0, new Set([1])]]),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
        }),
      );

      assert.deepStrictEqual(fake.sidecars[0]!.messages, [trackMessage(posixEntry)]);
      assert.isTrue(fake.sidecars[0]!.terminated);
      assert.isFalse(fake.sidecars[0]!.ended);
    }),
  );

  it.effect("re-feeds tracked entries after an unrecoverable sidecar stdin error", () =>
    Effect.gen(function* () {
      const fake = makeFakeSpawner();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reaper = yield* makeSpawnedProcessReaper(fake.spawner);
          yield* reaper.track(posixEntry);
          yield* Deferred.succeed(fake.sidecars[0]!.exit, 1);
          yield* Deferred.await(fake.spawnSignals[1]!);
          yield* Deferred.await(fake.sidecars[1]!.messageSignals[0]!);

          assert.deepStrictEqual(fake.sidecars[1]!.messages, [trackMessage(posixEntry)]);
        }),
      );
    }),
  );

  it.effect("does not propagate sidecar spawn failures", () =>
    Effect.gen(function* () {
      const reaper = yield* makeSpawnedProcessReaper({
        spawn: () =>
          Effect.fail(
            new SpawnedProcessReaperError({ operation: "spawn", cause: "sidecar unavailable" }),
          ),
      });
      yield* reaper.track(posixEntry);
      yield* reaper.untrack(posixEntry.pid);
    }).pipe(Effect.scoped),
  );

  it("reports stable sidecar operation context", () => {
    const error = new SpawnedProcessReaperError({ operation: "write", cause: "broken pipe" });
    assert.strictEqual(error.operation, "write");
    assert.strictEqual(error.message, "Spawned process reaper sidecar write failed.");
  });

  it("builds the Windows process-tree argv without executing taskkill", () => {
    assert.deepStrictEqual(windowsTaskkillArgs(42), ["/PID", "42", "/T", "/F"]);
  });
});
