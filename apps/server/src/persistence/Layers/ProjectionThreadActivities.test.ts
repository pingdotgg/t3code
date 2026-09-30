import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("checks activity kind by concrete turn", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-turn-kind");
      const turnId = TurnId.make("turn-aborted");

      yield* repository.upsert({
        activityId: EventId.make("activity-turn-aborted"),
        threadId,
        turnId,
        tone: "info",
        kind: "insights.turn.aborted",
        summary: "Turn aborted",
        payload: {},
        createdAt: "2026-09-12T00:00:00.000Z",
      });

      assert.isTrue(
        yield* repository.hasKindForTurn({
          threadId,
          turnId,
          kind: "insights.turn.aborted",
        }),
      );
      assert.isFalse(
        yield* repository.hasKindForTurn({
          threadId,
          turnId,
          kind: "insights.turn.completed",
        }),
      );
    }),
  );

  it.effect("lists only user-input lifecycle activities in chronological order", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-user-input-lifecycle");

      const seed = (suffix: string, kind: string, createdAt: string, payload: unknown) =>
        repository.upsert({
          activityId: EventId.make(`activity-user-input-${suffix}`),
          threadId,
          turnId: null,
          tone: "approval",
          kind,
          summary: suffix,
          payload,
          createdAt,
        });

      yield* seed("requested", "user-input.requested", "2026-03-02T00:00:01.000Z", {
        requestId: "user-input-1",
      });
      yield* seed("unrelated", "approval.requested", "2026-03-02T00:00:02.000Z", {
        requestKind: "command",
      });
      yield* seed(
        "failed-stale",
        "provider.user-input.respond.failed",
        "2026-03-02T00:00:03.000Z",
        { requestId: "user-input-stale", detail: "stale pending user-input request" },
      );
      yield* seed("resolved", "user-input.resolved", "2026-03-02T00:00:04.000Z", {
        requestId: "user-input-1",
      });

      const rows = yield* repository.listUserInputLifecycleByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => row.kind),
        ["user-input.requested", "provider.user-input.respond.failed", "user-input.resolved"],
      );
      assert.deepStrictEqual(rows[0]?.payload, { requestId: "user-input-1" });
      for (const row of rows) {
        assert.notProperty(row, "summary");
        assert.notProperty(row, "tone");
      }
    }),
  );

  it.effect("rehydrates the latest large payload after an activity is updated", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-updated-tool-payload");
      const activityId = EventId.make("activity-updated-tool-payload");
      const createdAt = "2026-09-12T00:00:00.000Z";
      const upsert = (marker: string) =>
        repository.upsert({
          activityId,
          threadId,
          turnId: null,
          tone: "tool",
          kind: "tool.completed",
          summary: marker,
          payload: { data: { content: marker.repeat(20_000) } },
          createdAt,
        });

      yield* upsert("first");
      yield* upsert("second");

      const stored = yield* repository.getById({ threadId, activityId });
      assert.deepStrictEqual(stored.pipe(Option.getOrThrow).payload, {
        data: { content: "second".repeat(20_000) },
      });
    }),
  );

  it.effect("lists turn ids and deletes only the listed turns", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-trim-activities");
      const retainedTurnId = TurnId.make("turn-trim-activities-kept");
      const trimmedTurnId = TurnId.make("turn-trim-activities-trimmed");

      const seed = (suffix: string, turnId: TurnId | null) =>
        repository.upsert({
          activityId: EventId.make(`activity-trim-${suffix}`),
          threadId,
          turnId,
          tone: "info",
          kind: "assistant.message",
          summary: suffix,
          payload: { marker: suffix },
          createdAt: `2026-09-12T00:00:0${suffix === "turnless" ? 1 : suffix === "kept" ? 2 : 3}.000Z`,
        });

      yield* seed("turnless", null);
      yield* seed("kept", retainedTurnId);
      yield* seed("trimmed", trimmedTurnId);

      assert.deepStrictEqual(yield* repository.listTurnIdsByThreadId({ threadId }), [
        retainedTurnId,
        trimmedTurnId,
      ]);

      yield* repository.deleteByTurnIds({ threadId, turnIds: [] });
      assert.strictEqual((yield* repository.listByThreadId({ threadId })).length, 3);

      yield* repository.deleteByTurnIds({ threadId, turnIds: [trimmedTurnId] });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        rows.map((row) => row.activityId),
        ["activity-trim-turnless", "activity-trim-kept"],
      );
      assert.deepStrictEqual(rows[0]?.payload, { marker: "turnless" });
    }),
  );
});
