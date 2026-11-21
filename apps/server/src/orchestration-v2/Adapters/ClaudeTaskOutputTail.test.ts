import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { claudeTaskOutputRoot, tailClaudeTaskOutput } from "./ClaudeTaskOutputTail.ts";

const SESSION_ID = "0c91bb28-9e89-4889-bd22-3de9880233d3";
const TASK_ID = "bk6xreeye";

const makeTaskFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
  const tasks = path.join(root, "-private-tmp-project", SESSION_ID, "tasks");
  return { root, tasks, file: path.join(tasks, `${TASK_ID}.output`) };
});

// TestClock cannot interleave with real filesystem I/O; tests that wait on a poll use the live clock.
describe("tailClaudeTaskOutput", () => {
  it.live("follows a file that appears after the task starts, across split characters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);

        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        // Split the two-byte é across writes.
        const encoded = new TextEncoder().encode("café 1\n");
        yield* fileSystem.writeFile(file, encoded.subarray(0, 4));
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFile(file, encoded);
        assert.equal(yield* Queue.take(chunks), "é 1\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drops a split character when the file is truncated and rewritten", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        // End the first read inside the two-byte é.
        yield* fileSystem.writeFile(file, new TextEncoder().encode("café").subarray(0, 4));
        const chunks = yield* Queue.unbounded<string>();
        const stop = yield* Deferred.make<void>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFileString(file, "ok\n");
        yield* Deferred.succeed(stop, undefined);
        assert.equal(yield* Queue.take(chunks), "ok\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("skips ahead when the command writes faster than it is read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "start\n");
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "start\n");

        // The skip lands on the second byte of a two-byte é.
        yield* fileSystem.writeFileString(file, `start\n${"é\n".repeat(1_000_000)}end.\n`);
        const flooded = yield* Queue.take(chunks);
        assert.isAtMost(flooded.length, 256 * 1024 + 1);
        assert.equal(flooded.slice(0, 3), "\n\né");
        assert.isTrue(flooded.endsWith("é\nend.\n"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads what was written last when the tool result stops it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { root, tasks, file } = yield* makeTaskFile;
      yield* fileSystem.makeDirectory(tasks, { recursive: true });
      yield* fileSystem.writeFileString(file, "one\n");
      const chunks: Array<string> = [];
      const stop = yield* Deferred.make<void>();
      const first = yield* Deferred.make<void>();
      const fiber = yield* tailClaudeTaskOutput({
        root,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        stop,
        onChunk: (chunk) =>
          Effect.sync(() => chunks.push(chunk)).pipe(
            Effect.andThen(Deferred.succeed(first, undefined)),
          ),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(first);
      yield* fileSystem.writeFileString(file, "one\ntwo\n");
      yield* Deferred.succeed(stop, undefined);
      yield* Fiber.join(fiber);
      assert.deepEqual(chunks, ["one\n", "two\n"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("checks the cwd project slug before scanning root and reuses cached project dirs", () =>
    Effect.gen(function* () {
      const baseFs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* baseFs.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
      for (let i = 0; i < 20; i += 1) {
        yield* baseFs.makeDirectory(path.join(root, `unrelated-dir-${i}`), { recursive: true });
        yield* baseFs.writeFileString(path.join(root, `unrelated-file-${i}.log`), "x");
      }
      const cwd = path.resolve("/private/tmp/project");
      const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const tasks = path.join(root, slug, SESSION_ID, "tasks");
      const file = path.join(tasks, `${TASK_ID}.output`);
      yield* baseFs.makeDirectory(tasks, { recursive: true });
      yield* baseFs.writeFileString(file, "from-cwd\n");

      let readDirCount = 0;
      let existsCount = 0;
      const countingFs: FileSystem.FileSystem = {
        ...baseFs,
        readDirectory: (target, options) => {
          if (target === root) readDirCount += 1;
          return baseFs.readDirectory(target, options);
        },
        exists: (target) => {
          existsCount += 1;
          return baseFs.exists(target);
        },
      };

      const cache = new Map<string, string>();
      const chunks: Array<string> = [];
      const stop = yield* Deferred.make<void>();
      const first = yield* Deferred.make<void>();
      const fiber = yield* tailClaudeTaskOutput({
        root,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        cwd,
        projectCache: cache,
        stop,
        onChunk: (chunk) =>
          Effect.sync(() => chunks.push(chunk)).pipe(
            Effect.andThen(Deferred.succeed(first, undefined)),
          ),
      }).pipe(Effect.provideService(FileSystem.FileSystem, countingFs), Effect.forkScoped);
      yield* Deferred.await(first);
      yield* Deferred.succeed(stop, undefined);
      yield* Fiber.join(fiber);

      assert.deepEqual(chunks, ["from-cwd\n"]);
      assert.equal(readDirCount, 0);
      assert.equal(existsCount, 1);
      assert.equal(cache.get(SESSION_ID), slug);

      // Missing output file when session dir already exists under cwd slug should not scan root.
      readDirCount = 0;
      existsCount = 0;
      const lateTaskId = "blatetask";
      const lateFile = path.join(tasks, `${lateTaskId}.output`);
      const lateChunks: Array<string> = [];
      const lateStop = yield* Deferred.make<void>();
      const lateFirst = yield* Deferred.make<void>();
      const lateFiber = yield* tailClaudeTaskOutput({
        root,
        sessionId: SESSION_ID,
        taskId: lateTaskId,
        cwd,
        projectCache: cache,
        stop: lateStop,
        onChunk: (chunk) =>
          Effect.sync(() => lateChunks.push(chunk)).pipe(
            Effect.andThen(Deferred.succeed(lateFirst, undefined)),
          ),
      }).pipe(Effect.provideService(FileSystem.FileSystem, countingFs), Effect.forkScoped);
      yield* TestClock.adjust("250 millis");
      yield* baseFs.writeFileString(lateFile, "late\n");
      yield* TestClock.adjust("250 millis");
      yield* Deferred.await(lateFirst);
      yield* Deferred.succeed(lateStop, undefined);
      yield* Fiber.join(lateFiber);
      assert.deepEqual(lateChunks, ["late\n"]);
      assert.equal(readDirCount, 0);

      // Fallback scan for a non-matching project dir caches it for subsequent tasks in the session.
      const otherSession = "1d92cc39-9e89-4889-bd22-3de9880233d4";
      const otherTasks = path.join(root, "custom-slug", otherSession, "tasks");
      yield* baseFs.makeDirectory(otherTasks, { recursive: true });
      yield* baseFs.writeFileString(path.join(otherTasks, "btask1.output"), "one\n");
      yield* baseFs.writeFileString(path.join(otherTasks, "btask2.output"), "two\n");

      const firstFallbackChunks: Array<string> = [];
      const stop1 = yield* Deferred.make<void>();
      const got1 = yield* Deferred.make<void>();
      const fiber1 = yield* tailClaudeTaskOutput({
        root,
        sessionId: otherSession,
        taskId: "btask1",
        projectCache: cache,
        stop: stop1,
        onChunk: (chunk) =>
          Effect.sync(() => firstFallbackChunks.push(chunk)).pipe(
            Effect.andThen(Deferred.succeed(got1, undefined)),
          ),
      }).pipe(Effect.provideService(FileSystem.FileSystem, countingFs), Effect.forkScoped);
      yield* Deferred.await(got1);
      yield* Deferred.succeed(stop1, undefined);
      yield* Fiber.join(fiber1);
      assert.deepEqual(firstFallbackChunks, ["one\n"]);
      assert.equal(cache.get(otherSession), "custom-slug");

      readDirCount = 0;
      existsCount = 0;
      const secondFallbackChunks: Array<string> = [];
      const stop2 = yield* Deferred.make<void>();
      const got2 = yield* Deferred.make<void>();
      const fiber2 = yield* tailClaudeTaskOutput({
        root,
        sessionId: otherSession,
        taskId: "btask2",
        projectCache: cache,
        stop: stop2,
        onChunk: (chunk) =>
          Effect.sync(() => secondFallbackChunks.push(chunk)).pipe(
            Effect.andThen(Deferred.succeed(got2, undefined)),
          ),
      }).pipe(Effect.provideService(FileSystem.FileSystem, countingFs), Effect.forkScoped);
      yield* Deferred.await(got2);
      yield* Deferred.succeed(stop2, undefined);
      yield* Fiber.join(fiber2);
      assert.deepEqual(secondFallbackChunks, ["two\n"]);
      assert.equal(readDirCount, 0);
      assert.equal(existsCount, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("aborts root directory scan immediately when stop completes during locate", () =>
    Effect.gen(function* () {
      const baseFs = yield* FileSystem.FileSystem;
      const root = yield* baseFs.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
      const stop = yield* Deferred.make<void>();
      let existsCount = 0;
      const fakeFs: FileSystem.FileSystem = {
        ...baseFs,
        readDirectory: (target, options) =>
          target === root
            ? Effect.succeed(Array.from({ length: 20 }, (_, index) => `project-${index}`))
            : baseFs.readDirectory(target, options),
        exists: () =>
          Effect.suspend(() => {
            existsCount += 1;
            if (existsCount === 2) {
              return Deferred.succeed(stop, undefined).pipe(Effect.as(false));
            }
            return Effect.succeed(false);
          }),
      };

      yield* tailClaudeTaskOutput({
        root,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        stop,
        onChunk: () => Effect.void,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fakeFs));

      assert.equal(existsCount, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("claudeTaskOutputRoot", () => {
  it.effect.skipIf(process.getuid === undefined)(
    "uses the temp dir Claude Code resolves from its environment on each platform",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const user = `claude-${process.getuid?.()}`;
        const root = (
          environment: Record<string, string>,
          platform: NodeJS.Platform,
          cwd: string | null = null,
        ) => claudeTaskOutputRoot(environment, path, cwd, platform);
        assert.equal(root({ TMPDIR: "/var/folders/x/T/" }, "linux"), `/var/folders/x/T/${user}`);
        assert.equal(root({ TMP: "/tmp/user/1000" }, "linux"), `/tmp/user/1000/${user}`);
        assert.equal(root({}, "linux"), `/tmp/${user}`);
        assert.equal(root({ TMPDIR: "/var/folders/x/T/" }, "darwin"), `/tmp/${user}`);
        assert.equal(
          root({ CLAUDE_CODE_TMPDIR: "/srv/claude", TMPDIR: "/var/folders/x/T/" }, "linux"),
          `/srv/claude/${user}`,
        );
        assert.equal(
          root({ CLAUDE_CODE_TMPDIR: "/srv/claude", TMPDIR: "/var/folders/x/T/" }, "darwin"),
          `/srv/claude/${user}`,
        );
        assert.equal(
          root({ TMPDIR: "tmp" }, "linux", "/work/project"),
          `/work/project/tmp/${user}`,
        );
        assert.equal(
          root({ CLAUDE_CODE_TMPDIR: "../claude" }, "darwin", "/work/project"),
          `/work/claude/${user}`,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
