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
        viewedAt: "2026-01-01T00:00:30.000Z",
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

it.layer(NodeServices.layer)("thread view-state decider", (it) => {
  it.effect("stamps a view at the acknowledged boundary", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-01-02T00:00:00.000Z"));
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.view",
          commandId: CommandId.make("cmd-view"),
          threadId: ThreadId.make("thread-1"),
          viewedThrough: VIEWED_THROUGH,
        },
        readModel: makeReadModel(),
      });
      const viewed = Array.isArray(event) ? event[0] : event;

      expect(viewed?.type).toBe("thread.viewed");
      if (viewed?.type === "thread.viewed") {
        expect(viewed.payload.viewedAt).toBe(VIEWED_THROUGH);
      }
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

      expect(markedUnread?.type).toBe("thread.marked-unread");
      if (markedUnread?.type === "thread.marked-unread") {
        expect(markedUnread.payload.viewedAt).toBe("2026-01-01T00:00:59.999Z");
      }
    }),
  );
});
