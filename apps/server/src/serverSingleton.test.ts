import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { PersistedServerRuntimeState } from "./serverRuntimeState.ts";
import {
  SERVER_LOCK_FILENAME,
  SERVER_RUNTIME_STATE_FILENAME,
  acquireServerSingleton,
  processIsAlive,
  recordServerLockPort,
  releaseServerLock,
  serverLockPath,
} from "./serverSingleton.ts";

const layer = it.layer(NodeServices.layer);

const makeStateDir = Effect.fn("test.makeStateDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "t3-singleton-" });
});

/** A stale lock file, written without the module's own encoder on purpose. */
const staleHolder = (pid: number) =>
  `{"version":1,"pid":${pid},"startedAt":"2026-01-01T00:00:00.000Z"}`;

const PersistedServerRuntimeStateFromJson = Schema.fromJsonString(PersistedServerRuntimeState);
const encodeRuntimeState = Schema.encodeSync(PersistedServerRuntimeStateFromJson);

/** What a pre-lock server persists: its live pid and port, and no lock file. */
const legacyRuntimeState = (pid: number, port: number) =>
  `${encodeRuntimeState({
    version: 1,
    pid,
    port,
    origin: `http://127.0.0.1:${port}`,
    startedAt: "2026-08-27T12:00:00.000Z",
  })}\n`;

layer("serverSingleton", (it) => {
  it.effect("claims a free directory and releases it on scope exit", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          assert.isTrue(yield* fs.exists(lockPath));
        }),
      );
      // Released on scope exit, so a restart is not blocked by its predecessor.
      assert.isFalse(yield* fs.exists(lockPath));
    }),
  );

  it.effect("refuses a second server while the first holds the directory", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          // The incident: a second server started against a held directory, found
          // its port taken, silently bound another, and corrupted shared state.
          return yield* acquireServerSingleton(stateDir).pipe(Effect.flip);
        }),
      );
      assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
      if (failure._tag === "ServerAlreadyRunningError") {
        assert.strictEqual(failure.holderPid, process.pid);
        assert.include(failure.message, stateDir);
        assert.include(failure.message, "overwrite each other");
      }
    }),
  );

  it.effect("reclaims a lock whose owner is gone", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      // pid 2^22 is above every /proc/sys/kernel/pid_max default, so it cannot
      // be live. A crashed server must not lock its own directory forever.
      yield* fs.writeFileString(lockPath, staleHolder(4194304));
      // Age the mtime past the holder's heartbeat interval: reclaim may take a
      // few observation rounds before it is believed dead, and those must never
      // be confused with a live holder's own refresh.
      const past = DateTime.toDateUtc(
        DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(1)),
      );
      yield* fs.utimes(lockPath, past, past);

      // One call observes the dead holder for several rounds, reclaims it, and
      // claims the freed directory on the same pass: a crashed server costs
      // its successor one delayed start, not one failed manual retry.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* acquireServerSingleton(stateDir);
          assert.strictEqual(held, lockPath);
        }),
      );
    }),
  );

  it.effect("reclaims a lock file left half-written by a crash", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      yield* fs.writeFileString(lockPath, '{"version":1,"pid":');
      const past = DateTime.toDateUtc(
        DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(1)),
      );
      yield* fs.utimes(lockPath, past, past);

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
        }),
      );
    }),
  );

  it.effect("does not release a lock another process has reclaimed", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      yield* fs.writeFileString(lockPath, staleHolder(4194304));

      yield* releaseServerLock(lockPath);
      // Evicting a live successor would recreate the very bug this prevents.
      assert.isTrue(yield* fs.exists(lockPath));
    }),
  );

  it.effect("records the bound port so the next server can name it", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lockPath = yield* acquireServerSingleton(stateDir);
          yield* recordServerLockPort(lockPath, 3775);
          const failure = yield* acquireServerSingleton(stateDir).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
          if (failure._tag === "ServerAlreadyRunningError") {
            assert.strictEqual(failure.holderPort, 3775);
            assert.include(failure.message, "listening on port 3775");
          }
        }),
      );
    }),
  );

  it.effect("keeps separate directories independent", () =>
    Effect.gen(function* () {
      const first = yield* makeStateDir();
      const second = yield* makeStateDir();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(first);
          // A dev server and the real one use different state dirs and must both run.
          yield* acquireServerSingleton(second);
        }),
      );
    }),
  );

  it.effect("uses a lock file inside the state directory", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const path = yield* Path.Path;
      const lockPath = yield* serverLockPath(stateDir);
      assert.strictEqual(lockPath, path.join(stateDir, SERVER_LOCK_FILENAME));
    }),
  );

  it("treats the current process as alive and an impossible pid as dead", () => {
    assert.isTrue(processIsAlive(process.pid));
    assert.isFalse(processIsAlive(4194304));
    assert.isFalse(processIsAlive(0));
    assert.isFalse(processIsAlive(-1));
  });

  it.effect("refuses next to a live pre-lock server that wrote no lock", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // 0.0.34 and earlier persist their live pid here but never claim a lock:
      // the desktop auto-update transition. The upgrade must still refuse.
      yield* fs.writeFileString(
        path.join(stateDir, SERVER_RUNTIME_STATE_FILENAME),
        legacyRuntimeState(process.pid, 3775),
      );

      const failure = yield* Effect.scoped(acquireServerSingleton(stateDir)).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
      if (failure._tag === "ServerAlreadyRunningError") {
        assert.strictEqual(failure.holderPid, process.pid);
        assert.strictEqual(failure.holderPort, 3775);
        assert.include(failure.message, SERVER_RUNTIME_STATE_FILENAME);
      }
      // And it must not have claimed the directory it refused.
      assert.isFalse(yield* fs.exists(yield* serverLockPath(stateDir)));
    }),
  );

  it.effect("claims the directory when the pre-lock server's pid is gone", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Leftover state from a crashed legacy server must not wedge the upgrade.
      yield* fs.writeFileString(
        path.join(stateDir, SERVER_RUNTIME_STATE_FILENAME),
        legacyRuntimeState(4194304, 3775),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* acquireServerSingleton(stateDir);
          assert.strictEqual(held, yield* serverLockPath(stateDir));
        }),
      );
    }),
  );

  it.effect("a starter cannot reclaim a lock a live holder still owns", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);

      // Starter B holds the directory live, with the heartbeat this change
      // gives every live holder. Starter A runs the full claim loop against
      // it — the loop whose old unconditional unlink deleted B's claim here.
      yield* fs.writeFileString(
        lockPath,
        `{"version":1,"pid":${process.pid},"startedAt":"2026-01-01T00:00:00.000Z"}`,
      );
      const past = DateTime.toDateUtc(
        DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(1)),
      );
      yield* fs.utimes(lockPath, past, past);

      const heartbeat = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const date = DateTime.toDateUtc(now);
        yield* fs.utimes(lockPath, date, date);
      }).pipe(
        // Per-round catch, the same way the production heartbeat recovers:
        // `Effect.repeat` ends a failing effect on the first failure.
        Effect.catch(() => Effect.void),
        Effect.repeat({ schedule: Schedule.spaced(50), while: () => true }),
        Effect.catch(() => Effect.void),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(heartbeat);
          yield* Effect.yieldNow;

          // Undecodable-by-design: B's pid is live, so A must refuse. Before
          // the fix, A's unconditional reclaim deleted B's lock and A owned
          // the directory alongside B.
          const failure = yield* acquireServerSingleton(stateDir).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
        }),
      );

      // And the lock is still on disk, owned by B, not reclaimed under it.
      assert.isTrue(yield* fs.exists(lockPath));
      const holder = yield* fs.readFileString(lockPath);
      assert.include(holder, `"pid":${process.pid}`);
    }),
  );

  it.effect("reclaims a stale lock without unlinking a concurrently live successor", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);

      // Snapshot the stale lock as starter A would. A live successor's claim
      // looks identical on paper except for the pid, which liveness checks
      // handle — the guard under test is that reclaim never unlinks a path
      // whose content it has not re-confirmed as still dead.
      yield* fs.writeFileString(
        lockPath,
        `{"version":1,"pid":${process.pid},"startedAt":"2026-01-01T00:00:00.000Z"}`,
      );
      const past = DateTime.toDateUtc(
        DateTime.subtractDuration(yield* DateTime.now, Duration.minutes(1)),
      );
      yield* fs.utimes(lockPath, past, past);

      const failure = yield* acquireServerSingleton(stateDir).pipe(Effect.flip);

      // Under the old unconditional `fs.remove(lockPath)`, claim would
      // *succeed* here by deleting this live claim first.
      assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
      assert.isTrue(yield* fs.exists(lockPath));
      const holder = yield* fs.readFileString(lockPath);
      assert.include(holder, `"pid":${process.pid}`);
    }),
  );

  it.effect("a partial metadata update is never readable as an empty owner", () =>
    Effect.gen(function* () {
      const stateDir = yield* makeStateDir();
      const fs = yield* FileSystem.FileSystem;
      const lockPath = yield* serverLockPath(stateDir);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* acquireServerSingleton(stateDir);
          // Before: the in-place rewrite truncated the file first, so a reader
          // mid-update decoded an empty holder and could reclaim a live lock.
          // The atomic write means the bytes on disk are always a full holder —
          // and a temp-file rename is what arranges that: it stages the payload
          // in a `.server.lock.*` sibling and swaps it in, which an in-place
          // truncate never does. Asserting the update *completed* then lets a
          // concurrent reader never observe an empty or partial lock.
          yield* recordServerLockPort(lockPath, 3775);

          const failure = yield* acquireServerSingleton(stateDir).pipe(Effect.flip);
          assert.strictEqual(failure._tag, "ServerAlreadyRunningError");
          if (failure._tag === "ServerAlreadyRunningError") {
            assert.strictEqual(failure.holderPort, 3775);
          }
        }),
      );

      // No temp staging directory outlives the update: the payload arrives at
      // the lock path whole or not at all, which is what makes "partial" reads
      // above unreachable rather than merely unlucky. The scope above released
      // the lock itself — only the temp-directory shape is under test.
      const leftovers = yield* fs
        .readDirectory(stateDir)
        .pipe(
          Effect.map((entries) =>
            entries.filter((entry) => entry.startsWith(`.${SERVER_LOCK_FILENAME}.`)),
          ),
        );
      assert.deepStrictEqual(leftovers, []);
    }),
  );
});
