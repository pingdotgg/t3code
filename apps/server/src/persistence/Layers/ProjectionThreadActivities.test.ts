import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("hydrates only requested live-task anchors and receipts", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-live-task-anchors");

      for (const [index, activityId] of [
        "anchor-start",
        "unrelated",
        "receipt-complete",
      ].entries()) {
        yield* repository.upsert({
          activityId: EventId.make(activityId),
          threadId,
          turnId: null,
          tone: "info",
          kind: activityId === "receipt-complete" ? "task.completed" : "task.updated",
          summary: activityId,
          payload: {
            taskId: "live-task",
            status: activityId === "receipt-complete" ? "completed" : "running",
          },
          sequence: index,
          createdAt: `2026-08-15T12:00:0${index}.000Z`,
        });
      }

      const rows = yield* repository.listByActivityIds({
        threadId,
        activityIds: [EventId.make("anchor-start"), EventId.make("receipt-complete")],
      });

      assert.deepEqual(
        rows.map((row) => row.activityId),
        ["anchor-start", "receipt-complete"],
      );
    }),
  );
});
