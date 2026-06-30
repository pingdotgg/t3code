import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { TurnProjectionPort, TurnStateReader } from "../Services/TurnStateReader.ts";
import { TurnProjectionPortLive, TurnStateReaderLive } from "./TurnStateReader.ts";

const stub = (state: string) =>
  Layer.succeed(TurnProjectionPort, {
    getLatestTurnState: () =>
      Effect.succeed({ state, completed: state === "completed" || state === "error" }),
  });

const mk = (state: string) =>
  it.layer(
    TurnStateReaderLive.pipe(
      Layer.provideMerge(stub(state)),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  );

mk("completed")("TurnStateReader completed", (it) => {
  it.effect("maps completed", () =>
    Effect.gen(function* () {
      const reader = yield* TurnStateReader;
      const result = yield* reader.read("thread-1" as never);
      assert.equal(result._tag, "completed");
    }),
  );
});

mk("error")("TurnStateReader error", (it) => {
  it.effect("maps error to failed", () =>
    Effect.gen(function* () {
      const reader = yield* TurnStateReader;
      const result = yield* reader.read("thread-1" as never);
      assert.equal(result._tag, "failed");
    }),
  );
});

mk("running")("TurnStateReader running", (it) => {
  it.effect("maps running", () =>
    Effect.gen(function* () {
      const reader = yield* TurnStateReader;
      const result = yield* reader.read("thread-1" as never);
      assert.equal(result._tag, "running");
    }),
  );
});

const liveProjectionLayer = it.layer(
  TurnStateReaderLive.pipe(
    Layer.provideMerge(TurnProjectionPortLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

liveProjectionLayer("TurnStateReader live projection", (it) => {
  it.effect("maps running completed and error through the live turn projection", () =>
    Effect.gen(function* () {
      const turns = yield* ProjectionTurnRepository;
      const reader = yield* TurnStateReader;
      const upsert = (threadId: string, turnId: string, state: "running" | "completed" | "error") =>
        turns.upsertByTurnId({
          threadId: threadId as never,
          turnId: turnId as never,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state,
          requestedAt: "2026-06-07T00:00:00.000Z" as never,
          startedAt: "2026-06-07T00:00:00.000Z" as never,
          completedAt: state === "running" ? null : ("2026-06-07T00:00:01.000Z" as never),
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });

      yield* upsert("thread-live-running", "turn-live-running", "running");
      yield* upsert("thread-live-completed", "turn-live-completed", "completed");
      yield* upsert("thread-live-error", "turn-live-error", "error");

      assert.equal((yield* reader.read("thread-live-running" as never))._tag, "running");
      assert.equal((yield* reader.read("thread-live-completed" as never))._tag, "completed");
      const failed = yield* reader.read("thread-live-error" as never);
      assert.equal(failed._tag, "failed");
      if (failed._tag === "failed") {
        assert.equal(failed.error, "error");
      }
    }),
  );
});
