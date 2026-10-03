import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import { tailClaudeTaskOutput } from "./ClaudeTaskOutputTail.ts";

const SESSION_ID = "0c91bb28-9e89-4889-bd22-3de9880233d3";
const TASK_ID = "bk6xreeye";

// Claude Code's layout: <root>/<project>/<session_id>/tasks/<task_id>.output.
const makeTaskFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
  const tasks = path.join(root, "-private-tmp-project", SESSION_ID, "tasks");
  return { root, tasks, file: path.join(tasks, `${TASK_ID}.output`) };
});

// Live clock and a real file: this proves the tail follows the writer, which
// TestClock cannot interleave with filesystem IO.
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
        // "é" is two bytes; the first write ends between them.
        const encoded = new TextEncoder().encode("café 1\n");
        yield* fileSystem.writeFile(file, encoded.subarray(0, 4));
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFile(file, encoded);
        assert.equal(yield* Queue.take(chunks), "é 1\n");
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

        yield* fileSystem.writeFileString(file, `start\n${"y\n".repeat(1_000_000)}end\n`);
        const flooded = yield* Queue.take(chunks);
        assert.isAtMost(flooded.length, 256 * 1024 + 1);
        assert.isTrue(flooded.startsWith("\n"));
        assert.isTrue(flooded.endsWith("y\nend\n"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads what was written last when the tool result stops it", () =>
    Effect.scoped(
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
        // Written right before the command exits, then the result arrives.
        yield* fileSystem.writeFileString(file, "one\ntwo\n");
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        assert.deepEqual(chunks, ["one\n", "two\n"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.live("ends when stopped even if Claude Code never wrote the file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root } = yield* makeTaskFile;
        const stop = yield* Deferred.make<void>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: () => Effect.die("no file, no output"),
        }).pipe(Effect.forkScoped);
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
