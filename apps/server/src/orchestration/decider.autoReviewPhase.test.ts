import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch: a fresh
// phase set stamps occurredAt as 1970-01-01T00:00:00.000Z, never NOW.
const TEST_CLOCK_NOW = "1970-01-01T00:00:00.000Z";

function makeReadModel(
  autoReviewPhase: OrchestrationThread["autoReviewPhase"],
  archivedAt: string | null = null,
): OrchestrationReadModel {
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
        executorModelSelection: null,
        executorMaxSubAgents: 3,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        autoReviewPhase,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("auto-review phase decider", (it) => {
  it.effect("sets the phase and stamps updatedAt with the command time", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-review-phase.set",
          commandId: CommandId.make("cmd-auto-review-set"),
          threadId: ThreadId.make("thread-1"),
          phase: "reviewing",
          createdAt: NOW,
        },
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.auto-review-phase-set");
      if (events[0]?.type === "thread.auto-review-phase-set") {
        expect(events[0].payload.phase).toBe("reviewing");
        expect(events[0].payload.updatedAt).toBe(TEST_CLOCK_NOW);
      }
    }),
  );

  it.effect("re-emits an unchanged phase with the existing updatedAt", () =>
    Effect.gen(function* () {
      // The engine rejects zero-event commands, so setting the phase the
      // thread already has re-emits the event as a projected no-op — keeping
      // the existing updatedAt rather than churning ordering (mirrors
      // thread.settle idempotency).
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-review-phase.set",
          commandId: CommandId.make("cmd-auto-review-noop"),
          threadId: ThreadId.make("thread-1"),
          phase: "readyToMerge",
          createdAt: NOW,
        },
        readModel: makeReadModel("readyToMerge"),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.auto-review-phase-set");
      if (events[0]?.type === "thread.auto-review-phase-set") {
        expect(events[0].payload.phase).toBe("readyToMerge");
        expect(events[0].payload.updatedAt).toBe(NOW);
      }

      // Clearing an already-null phase is also a no-op re-emission.
      const cleared = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-review-phase.set",
          commandId: CommandId.make("cmd-auto-review-clear-noop"),
          threadId: ThreadId.make("thread-1"),
          phase: null,
          createdAt: NOW,
        },
        readModel: makeReadModel(null),
      });
      const clearedEvents = Array.isArray(cleared) ? cleared : [cleared];
      expect(clearedEvents[0]?.type).toBe("thread.auto-review-phase-set");
      if (clearedEvents[0]?.type === "thread.auto-review-phase-set") {
        expect(clearedEvents[0].payload.phase).toBe(null);
        expect(clearedEvents[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("rejects phase sets on archived threads", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-review-phase.set",
          commandId: CommandId.make("cmd-auto-review-archived"),
          threadId: ThreadId.make("thread-1"),
          phase: "fixing",
          createdAt: NOW,
        },
        readModel: makeReadModel(null, NOW),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
