import { CheckpointRef, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionCheckpointRefsRepository } from "../Services/ProjectionCheckpointRefs.ts";
import { ProjectionCheckpointRefsRepositoryLive } from "./ProjectionCheckpointRefs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionCheckpointRefsRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const turnCount = (n: number) => NonNegativeInt.make(n);

layer("ProjectionCheckpointRefsRepository", (it) => {
  it.effect("stores and lists per-root refs for a checkpoint, ordered by repo root", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionCheckpointRefsRepository;
      const threadId = ThreadId.make("thread-refs-1");

      yield* repository.replaceForCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(1),
        refs: [
          { repoRoot: "/work/frontend", checkpointRef: CheckpointRef.make("refs/t3/c/1") },
          { repoRoot: "/work/backend", checkpointRef: CheckpointRef.make("refs/t3/c/1") },
        ],
      });

      const rows = yield* repository.listByCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(1),
      });
      assert.deepEqual(
        rows.map((row) => row.repoRoot),
        ["/work/backend", "/work/frontend"],
      );
      assert.equal(rows.length, 2);
    }),
  );

  it.effect("replaceForCheckpoint replaces the prior set (no stale rows)", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionCheckpointRefsRepository;
      const threadId = ThreadId.make("thread-refs-2");

      yield* repository.replaceForCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(2),
        refs: [
          { repoRoot: "/work/a", checkpointRef: CheckpointRef.make("refs/t3/c/2") },
          { repoRoot: "/work/b", checkpointRef: CheckpointRef.make("refs/t3/c/2") },
        ],
      });
      yield* repository.replaceForCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(2),
        refs: [{ repoRoot: "/work/a", checkpointRef: CheckpointRef.make("refs/t3/c/2b") }],
      });

      const rows = yield* repository.listByCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(2),
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.repoRoot, "/work/a");
      assert.equal(rows[0]?.checkpointRef, "refs/t3/c/2b");
    }),
  );

  it.effect("isolates checkpoints by turn count and deletes by thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionCheckpointRefsRepository;
      const threadId = ThreadId.make("thread-refs-3");

      yield* repository.replaceForCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(1),
        refs: [{ repoRoot: "/work/a", checkpointRef: CheckpointRef.make("refs/t3/c/1") }],
      });
      yield* repository.replaceForCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(2),
        refs: [{ repoRoot: "/work/a", checkpointRef: CheckpointRef.make("refs/t3/c/2") }],
      });

      const turn1 = yield* repository.listByCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(1),
      });
      assert.equal(turn1.length, 1);
      assert.equal(turn1[0]?.checkpointRef, "refs/t3/c/1");

      yield* repository.deleteByThreadId({ threadId });
      const afterDelete = yield* repository.listByCheckpoint({
        threadId,
        checkpointTurnCount: turnCount(1),
      });
      assert.equal(afterDelete.length, 0);
    }),
  );
});
