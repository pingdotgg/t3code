import { sanitizeLockKey, withLock } from "@/Auth/Lock.ts";
import { rootDir } from "@/Auth/Profile.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { assert, describe, expect, it, layer } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

describe("sanitizeLockKey", () => {
  it("leaves conventional keys untouched", () => {
    expect(sanitizeLockKey("default-Cloudflare")).toBe("default-Cloudflare");
    expect(sanitizeLockKey("my_profile.v2-AWS")).toBe("my_profile.v2-AWS");
  });

  it("neutralises unexpanded shell placeholders", () => {
    // Seen verbatim in production: EINVAL mkdir
    // '...\${ALCHEMY_PROFILE:-default}-Cloudflare.lock.lock' on Windows,
    // where `:`/`$`/`{`/`}` are invalid in file names.
    const sanitized = sanitizeLockKey("${ALCHEMY_PROFILE:-default}-Cloudflare");
    expect(sanitized).toBe("__ALCHEMY_PROFILE_-default_-Cloudflare");
    expect(sanitized).not.toMatch(/[<>:"/\\|?*${}]/);
  });

  it("replaces path separators so keys cannot escape the lock dir", () => {
    expect(sanitizeLockKey("../../etc/passwd")).toBe(".._.._etc_passwd");
  });
});

// Scenarios adapted from proper-lockfile's suite
// (https://github.com/moxystudio/node-proper-lockfile/tree/master/test) to
// the Effect lock: withLock is scoped acquire+release, the lockfile is a
// directory with an owner marker, staleness is 30s, the heartbeat is 10s.
layer(NodeServices.layer, { excludeTestServices: true })("withLock", (it) => {
  const lockPathOf = Effect.fn(function* (key: string) {
    const path = yield* Path.Path;
    return path.join(rootDir, "lock", `${sanitizeLockKey(key)}.lock`);
  });

  /** Create a foreign lock as another process would have left it. */
  const plantForeignLock = Effect.fn(function* (
    lockPath: string,
    options?: { readonly ageMillis?: number },
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(lockPath, { recursive: true });
    yield* fs.writeFileString(path.join(lockPath, "owner"), "foreign-owner");
    if (options?.ageMillis !== undefined) {
      const stamp = new Date(
        (yield* Clock.currentTimeMillis) - options.ageMillis,
      );
      yield* fs.utimes(lockPath, stamp, stamp);
    }
  });

  const removeLock = Effect.fn(function* (lockPath: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(lockPath, { recursive: true, force: true });
  });

  it.effect(
    "acquires and releases a lock whose key contains characters invalid in file names",
    () =>
      Effect.gen(function* () {
        // Regression for the production EINVAL: this key is unusable as a
        // raw Windows file name without sanitisation.
        const result = yield* withLock(
          "${ALCHEMY_PROFILE:-default}-LockTest",
          Effect.succeed("ran"),
        );
        expect(result).toBe("ran");
      }),
  );

  it.effect(
    "creates the lock directory while held and removes it on release",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const key = "lock-test-lifecycle";
        const lockPath = yield* lockPathOf(key);
        const seen = yield* withLock(
          key,
          Effect.all({
            lock: fs.exists(lockPath),
            owner: fs
              .readFileString(`${lockPath}/owner`)
              .pipe(Effect.map((owner) => owner.length > 0)),
          }),
        );
        expect(seen).toEqual({ lock: true, owner: true });
        expect(yield* fs.exists(lockPath)).toBe(false);
      }),
  );

  it.effect("serialises same-key critical sections in-process", () =>
    Effect.gen(function* () {
      const order: number[] = [];
      const critical = (i: number) =>
        withLock(
          "lock-test-serialise",
          Effect.gen(function* () {
            order.push(i);
            yield* Effect.sleep("50 millis");
            order.push(i);
          }),
        );
      yield* Effect.all([critical(1), critical(2)], {
        concurrency: "unbounded",
      });
      // Each critical section's two entries must be adjacent — no
      // interleaving between holders.
      expect(order.slice(0, 2)).toEqual([order[0], order[0]]);
      expect(order.slice(2)).toEqual([order[2], order[2]]);
    }),
  );

  it.effect("allows different-key critical sections to overlap", () =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const first = yield* withLock(
        "lock-test-independent-a",
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(firstEntered);
      const secondRan = yield* withLock(
        "lock-test-independent-b",
        Effect.succeed(true),
      );
      expect(secondRan).toBe(true);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.await(first);
    }),
  );

  it.effect(
    "excludes another process and recovers its lock after a crash",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const key = `lock-test-process-${crypto.randomUUID()}`;
        const lockPath = yield* lockPathOf(key);
        const child = spawn(
          process.execPath,
          ["test/Auth/fixtures/lock-holder.ts", key],
          {
            cwd: resolve(import.meta.dir, "../.."),
            stdio: ["ignore", "pipe", "inherit"],
          },
        );

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }),
        );

        yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve, reject) => {
              child.once("error", reject);
              child.once("exit", (code) =>
                reject(new Error(`lock holder exited before ready: ${code}`)),
              );
              child.stdout.once("data", (chunk) => {
                if (chunk.toString().includes("ready")) resolve();
              });
            }),
        );

        const blocked = yield* withLock(key, Effect.void, {
          timeout: "250 millis",
        }).pipe(Effect.exit);
        assert(Exit.isFailure(blocked));
        expect(String(blocked.cause)).toContain("Timed out waiting");

        child.kill("SIGKILL");
        yield* Effect.tryPromise(
          () =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null) resolve();
              else child.once("exit", () => resolve());
            }),
        );
        expect(yield* fs.exists(lockPath)).toBe(true);

        const stale = new Date((yield* Clock.currentTimeMillis) - 60_000);
        yield* fs.utimes(lockPath, stale, stale);
        expect(
          yield* withLock(key, Effect.succeed("recovered"), {
            timeout: "2 seconds",
          }),
        ).toBe("recovered");
        expect(yield* fs.exists(lockPath)).toBe(false);
      }).pipe(Effect.scoped),
    { timeout: 10_000 },
  );

  it.effect("releases the lock when the critical section fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = "lock-test-release-on-failure";
      const lockPath = yield* lockPathOf(key);
      const exit = yield* withLock(key, Effect.fail("boom")).pipe(Effect.exit);
      assert(Exit.isFailure(exit));
      expect(String(exit.cause)).toContain("boom");
      expect(yield* fs.exists(lockPath)).toBe(false);
    }),
  );

  it.effect("releases the lock when the holder is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = "lock-test-release-on-interrupt";
      const lockPath = yield* lockPathOf(key);
      const fiber = yield* withLock(key, Effect.never).pipe(Effect.forkScoped);
      yield* fs.exists(lockPath).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("25 millis"),
          until: (exists) => exists,
          times: 100,
        }),
      );
      yield* Fiber.interrupt(fiber);
      expect(yield* fs.exists(lockPath)).toBe(false);
    }),
  );

  it.effect("dies with a timeout while a live foreign lock is held", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = "lock-test-foreign-holder";
      const lockPath = yield* lockPathOf(key);
      yield* plantForeignLock(lockPath);

      const exit = yield* withLock(key, Effect.void, {
        timeout: "500 millis",
      }).pipe(Effect.exit);
      assert(Exit.isFailure(exit));
      expect(String(exit.cause)).toMatch(/Timed out waiting/);
      // A fresh (non-stale) foreign lock must survive our failed attempt.
      expect(yield* fs.readFileString(`${lockPath}/owner`)).toBe(
        "foreign-owner",
      );
      yield* removeLock(lockPath);
    }),
  );

  it.effect("reaps and acquires over a stale lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = "lock-test-stale";
      const lockPath = yield* lockPathOf(key);
      // A holder that crashed 60s ago: owner file present, mtime past the
      // 30s stale threshold, nobody refreshing.
      yield* plantForeignLock(lockPath, { ageMillis: 60_000 });

      const result = yield* withLock(key, Effect.succeed("recovered"), {
        timeout: "5 seconds",
      });
      expect(result).toBe("recovered");
      expect(yield* fs.exists(lockPath)).toBe(false);
    }),
  );

  it.effect("retries until a foreign lock is released", () =>
    Effect.gen(function* () {
      const key = "lock-test-wait-for-release";
      const lockPath = yield* lockPathOf(key);
      yield* plantForeignLock(lockPath);
      yield* removeLock(lockPath).pipe(
        Effect.delay("300 millis"),
        Effect.forkScoped,
      );
      const result = yield* withLock(key, Effect.succeed("ran"), {
        timeout: "5 seconds",
      });
      expect(result).toBe("ran");
    }),
  );

  it.effect("does not remove a lock it no longer owns on release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = "lock-test-compromised-release";
      const lockPath = yield* lockPathOf(key);
      const release = yield* Deferred.make<void>();
      const fiber = yield* withLock(key, Deferred.await(release)).pipe(
        Effect.forkScoped,
      );
      yield* fs.exists(lockPath).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("25 millis"),
          until: (exists) => exists,
          times: 100,
        }),
      );
      // Another process reaped our lock as stale and took it over.
      yield* fs.writeFileString(`${lockPath}/owner`, "foreign-owner");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(fiber);
      // Release must leave the usurper's lock in place.
      expect(yield* fs.readFileString(`${lockPath}/owner`)).toBe(
        "foreign-owner",
      );
      yield* removeLock(lockPath);
    }),
  );

  it.effect.skipIf(process.env.FAST)(
    "refreshes the lock mtime while held",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const key = "lock-test-heartbeat";
        const lockPath = yield* lockPathOf(key);
        const release = yield* Deferred.make<void>();
        const fiber = yield* withLock(key, Deferred.await(release)).pipe(
          Effect.forkScoped,
        );
        yield* fs.exists(lockPath).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("25 millis"),
            until: (exists) => exists,
            times: 100,
          }),
        );
        // Age the lock past the heartbeat interval; the next refresh must
        // bump the mtime back to the present so it never appears stale.
        const before = new Date((yield* Clock.currentTimeMillis) - 25_000);
        yield* fs.utimes(lockPath, before, before);
        const refreshed = yield* fs.stat(lockPath).pipe(
          Effect.map((info) =>
            Option.exists(
              info.mtime,
              (mtime) => mtime.getTime() > before.getTime() + 20_000,
            ),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (bumped) => bumped,
            times: 25,
          }),
        );
        expect(refreshed).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(fiber);
      }),
    { timeout: 30_000 },
  );
  /**
   * A locked operation that never completes used to be entirely invisible:
   * the deploy sat there with no output at any log level (#1231). The stall
   * notice is the backstop that makes a hang self-describing, so it has to
   * name the operation and it must stay quiet for flows that legitimately
   * block on the user.
   */
  const captureConsole = () => {
    const messages: Array<string> = [];
    return {
      messages,
      provide: <A, E, R>(self: Effect.Effect<A, E, R>) =>
        Console.consoleWith((base) =>
          Effect.provideService(self, Console.Console, {
            ...base,
            error: (...args: ReadonlyArray<any>) => {
              messages.push(args.join(" "));
            },
          }),
        ),
    };
  };

  it.effect("names the stalled operation on the console", () =>
    Effect.gen(function* () {
      const console = captureConsole();
      yield* console.provide(
        withLock("stall-notice-key", Effect.sleep("250 millis"), {
          label: "AWS.read (profile 'probe')",
          stallInterval: "50 millis",
        }),
      );
      expect(console.messages.length).toBeGreaterThan(0);
      expect(console.messages[0]).toContain("AWS.read (profile 'probe')");
      expect(console.messages[0]).toContain("stall-notice-key.lock");
      yield* removeLock(yield* lockPathOf("stall-notice-key"));
    }),
  );

  it.effect("stays silent when the watchdog is disabled", () =>
    Effect.gen(function* () {
      const console = captureConsole();
      yield* console.provide(
        withLock("stall-quiet-key", Effect.sleep("250 millis"), {
          watchdog: false,
          stallInterval: "50 millis",
        }),
      );
      expect(console.messages).toEqual([]);
      yield* removeLock(yield* lockPathOf("stall-quiet-key"));
    }),
  );
});
