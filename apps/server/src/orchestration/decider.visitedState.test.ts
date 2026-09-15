import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { decideOrchestrationCommand } from "./decider.ts";

const COMPLETED_AT = "2026-01-01T00:01:00.000Z";
const VIEWED_THROUGH = "2026-01-01T00:00:45.000Z";

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: COMPLETED_AT,
          assistantMessageId: null,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: COMPLETED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        pullRequests: [],
        lastVisitedAt: "2026-01-01T00:00:30.000Z",
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: COMPLETED_AT,
  };
}

it.layer(NodeServices.layer)("thread visited-state decider", (it) => {
  it.effect("stamps a visit at the supplied watermark", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-02T00:00:00.000Z"));
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-view"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: VIEWED_THROUGH,
        },
        readModel: makeReadModel(),
      });
      const viewed = Array.isArray(event) ? event[0] : event;

      expect(viewed?.type).toBe("thread.meta-updated");
      if (viewed?.type === "thread.meta-updated") {
        expect(viewed.payload.lastVisitedAt).toBe(VIEWED_THROUGH);
        expect(viewed.payload.updatedAt).toBe(COMPLETED_AT);
      }
    }),
  );

  it.effect("caps future visit watermarks at the server clock", () =>
    Effect.gen(function* () {
      const now = "2026-01-02T00:00:00.000Z";
      yield* TestClock.setTime(Date.parse(now));
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-view-future"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: "2026-01-03T00:00:00.000Z",
        },
        readModel: makeReadModel(),
      });
      const viewed = Array.isArray(event) ? event[0] : event;

      expect(viewed?.type).toBe("thread.meta-updated");
      if (viewed?.type === "thread.meta-updated") {
        expect(viewed.payload.lastVisitedAt).toBe(now);
      }
    }),
  );

  it.effect("stores accepted visit watermarks in canonical ISO format", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-02T00:00:00.000Z"));
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-view-noncanonical"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: "2026-01-01T00:00:45Z",
        },
        readModel: makeReadModel(),
      });
      const viewed = Array.isArray(event) ? event[0] : event;

      expect(viewed?.type).toBe("thread.meta-updated");
      if (viewed?.type === "thread.meta-updated") {
        expect(viewed.payload.lastVisitedAt).toBe("2026-01-01T00:00:45.000Z");
      }
    }),
  );

  it.effect("does not move the visited watermark backward", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-02T00:00:00.000Z"));
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-view-stale"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: "2026-01-01T00:00:15.000Z",
        },
        readModel: makeReadModel(),
      });
      const viewed = Array.isArray(event) ? event[0] : event;

      expect(viewed?.type).toBe("thread.meta-updated");
      if (viewed?.type === "thread.meta-updated") {
        expect(viewed.payload.lastVisitedAt).toBe("2026-01-01T00:00:30.000Z");
      }
    }),
  );

  it.effect("rejects an invalid visit time instead of marking the thread read", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-view-invalid"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: "not-a-timestamp",
        },
        readModel: makeReadModel(),
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.visit",
      });
    }),
  );

  it.effect("marks unread just before the latest completion", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-unread",
          commandId: CommandId.make("cmd-mark-unread"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(),
      });
      const markedUnread = Array.isArray(event) ? event[0] : event;

      expect(markedUnread?.type).toBe("thread.meta-updated");
      if (markedUnread?.type === "thread.meta-updated") {
        expect(markedUnread.payload.lastVisitedAt).toBe("2026-01-01T00:00:59.999Z");
        expect(markedUnread.payload.updatedAt).toBe(COMPLETED_AT);
      }
    }),
  );

  it.effect("preserves the existing watermark while the latest turn is running", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const thread = readModel.threads[0]!;
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-unread",
          commandId: CommandId.make("cmd-mark-unread-running"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: {
          ...readModel,
          threads: [
            {
              ...thread,
              latestTurn: { ...thread.latestTurn!, state: "running", completedAt: null },
            },
          ],
        },
      });
      const markedUnread = Array.isArray(event) ? event[0] : event;

      expect(markedUnread?.type).toBe("thread.meta-updated");
      if (markedUnread?.type === "thread.meta-updated") {
        expect(markedUnread.payload.lastVisitedAt).toBe(thread.lastVisitedAt);
      }
    }),
  );
});
