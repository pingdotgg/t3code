import { it, assert } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { CheckpointRepository } from "../Services/Checkpoints.ts";
import { CheckpointRepositoryLive } from "./Checkpoints.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

function makeCheckpointRepositoryLayer() {
  return CheckpointRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory));
}

it.effect("CheckpointRepositoryLive upserts, lists, reads, and prunes checkpoint metadata", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const repository = yield* CheckpointRepository;

      yield* repository.upsertCheckpoint({
        providerSessionId: "sess-1",
        threadId: "thread-1",
        checkpointId: "root",
        checkpointRef: "refs/t3/checkpoints/thread-1/turn/0",
        turnCount: 0,
        messageCount: 0,
        label: "Start of conversation",
        createdAt: new Date().toISOString(),
      });

      yield* repository.upsertCheckpoint({
        providerSessionId: "sess-1",
        threadId: "thread-1",
        checkpointId: "turn-1",
        checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
        turnCount: 1,
        messageCount: 2,
        label: "Turn 1",
        preview: "hello",
        createdAt: new Date().toISOString(),
      });

      yield* repository.upsertCheckpoint({
        providerSessionId: "sess-1",
        threadId: "thread-1",
        checkpointId: "turn-2",
        checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
        turnCount: 2,
        messageCount: 4,
        label: "Turn 2",
        preview: "done",
        createdAt: new Date().toISOString(),
      });

      const checkpoints = yield* repository.listCheckpoints({ providerSessionId: "sess-1" });
      assert.equal(checkpoints.length, 3);
      assert.equal(checkpoints[0]?.id, "root");
      assert.equal(checkpoints[0]?.isCurrent, false);
      assert.equal(checkpoints[2]?.id, "turn-2");
      assert.equal(checkpoints[2]?.isCurrent, true);

      const one = yield* repository.getCheckpoint({ providerSessionId: "sess-1", turnCount: 1 });
      assert.equal(Option.isSome(one), true);
      if (Option.isSome(one)) {
        assert.equal(one.value.id, "turn-1");
        assert.equal(one.value.isCurrent, false);
        assert.equal(one.value.checkpointRef, "refs/t3/checkpoints/thread-1/turn/1");
      }

      yield* repository.deleteAfterTurn({
        providerSessionId: "sess-1",
        maxTurnCount: 1,
      });

      const pruned = yield* repository.listCheckpoints({ providerSessionId: "sess-1" });
      assert.equal(pruned.length, 2);
      assert.equal(pruned[1]?.turnCount, 1);
      assert.equal(pruned[1]?.isCurrent, true);

      yield* repository.deleteAllForSession({ providerSessionId: "sess-1" });
      const empty = yield* repository.listCheckpoints({ providerSessionId: "sess-1" });
      assert.equal(empty.length, 0);
    }).pipe(Effect.provide(makeCheckpointRepositoryLayer()));
  }),
);
