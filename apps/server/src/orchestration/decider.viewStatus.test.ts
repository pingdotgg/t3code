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

import { decideOrchestrationCommand } from "./decider.ts";

const COMPLETED_AT = "1970-01-01T00:00:00.000Z";

function makeReadModel(completedAt: string | null = COMPLETED_AT): OrchestrationReadModel {
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
          requestedAt: COMPLETED_AT,
          startedAt: COMPLETED_AT,
          completedAt,
          assistantMessageId: null,
        },
        createdAt: COMPLETED_AT,
        updatedAt: COMPLETED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastViewedAt: null,
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

it.layer(NodeServices.layer)("thread view-status decider", (it) => {
  it.effect("uses server-owned timestamps when a thread is viewed", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-viewed",
          commandId: CommandId.make("cmd-viewed"),
          threadId: ThreadId.make("thread-1"),
          viewedAt: COMPLETED_AT,
          expectedLastViewedAt: null,
          supersededViewedAt: null,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.view-status-updated");
      if (events[0]?.type === "thread.view-status-updated") {
        expect(events[0].payload.lastViewedAt).toBe(COMPLETED_AT);
        expect(Number.isFinite(Date.parse(events[0].payload.lastViewedAt))).toBe(true);
      }
    }),
  );

  it.effect("marks unread immediately before the latest server completion", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-unread",
          commandId: CommandId.make("cmd-unread"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.view-status-updated");
      if (events[0]?.type === "thread.view-status-updated") {
        expect(events[0].payload.lastViewedAt).toBe("1969-12-31T23:59:59.999Z");
      }
    }),
  );

  it.effect("accepts a server-owned boundary ahead of the decider clock", () =>
    Effect.gen(function* () {
      const viewedAt = "1970-01-01T00:00:00.001Z";
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-viewed",
          commandId: CommandId.make("cmd-viewed-clock-skew"),
          threadId: ThreadId.make("thread-1"),
          viewedAt,
          expectedLastViewedAt: null,
          supersededViewedAt: null,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.view-status-updated");
      if (events[0]?.type === "thread.view-status-updated") {
        expect(events[0].payload.lastViewedAt).toBe(viewedAt);
      }
    }),
  );

  it.effect("does not move viewed state backwards", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const previousViewedAt = "1970-01-01T00:00:10.000Z";
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-viewed",
          commandId: CommandId.make("cmd-viewed-stale"),
          threadId: ThreadId.make("thread-1"),
          viewedAt: "1970-01-01T00:00:05.000Z",
          expectedLastViewedAt: previousViewedAt,
          supersededViewedAt: null,
        },
        readModel: {
          ...readModel,
          threads: [{ ...readModel.threads[0]!, lastViewedAt: previousViewedAt }],
        },
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.view-status-updated");
      if (events[0]?.type === "thread.view-status-updated") {
        expect(events[0].payload.lastViewedAt).toBe(previousViewedAt);
      }
    }),
  );

  it.effect("does not let a queued view undo a newer unread action", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const unreadEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-unread",
          commandId: CommandId.make("cmd-unread-before-stale-view"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel,
      });
      const unreadEvents = Array.isArray(unreadEvent) ? unreadEvent : [unreadEvent];
      expect(unreadEvents[0]?.type).toBe("thread.view-status-updated");
      if (unreadEvents[0]?.type !== "thread.view-status-updated") return;

      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-viewed",
          commandId: CommandId.make("cmd-viewed-queued-before-unread"),
          threadId: ThreadId.make("thread-1"),
          viewedAt: COMPLETED_AT,
          expectedLastViewedAt: null,
          supersededViewedAt: null,
        },
        readModel: {
          ...readModel,
          threads: [
            {
              ...readModel.threads[0]!,
              lastViewedAt: unreadEvents[0].payload.lastViewedAt,
            },
          ],
        },
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("accepts a view that follows its queued predecessor", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const predecessorViewedAt = "1970-01-01T00:00:05.000Z";
      const viewedAt = "1970-01-01T00:00:10.000Z";
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-viewed",
          commandId: CommandId.make("cmd-viewed-after-predecessor"),
          threadId: ThreadId.make("thread-1"),
          viewedAt,
          expectedLastViewedAt: null,
          supersededViewedAt: predecessorViewedAt,
        },
        readModel: {
          ...readModel,
          threads: [{ ...readModel.threads[0]!, lastViewedAt: predecessorViewedAt }],
        },
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.view-status-updated");
      if (events[0]?.type === "thread.view-status-updated") {
        expect(events[0].payload.lastViewedAt).toBe(viewedAt);
      }
    }),
  );

  it.effect("rejects mark-unread before any turn completes", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.mark-unread",
          commandId: CommandId.make("cmd-unread-empty"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
