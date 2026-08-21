import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EARLIER_VISIT = "2025-12-30T00:00:00.000Z";
const LATER_VISIT = "2025-12-31T00:00:00.000Z";

function makeReadModel(input: {
  readonly lastVisitedAt?: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
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
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastVisitedAt: input.lastVisitedAt ?? null,
        deletedAt: null,
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

it.layer(NodeServices.layer)("visited thread decider", (it) => {
  it.effect("stamps a first visit without churning updatedAt", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-visit"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: LATER_VISIT,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.visited");
      if (events[0]?.type === "thread.visited") {
        expect(events[0].payload.lastVisitedAt).toBe(LATER_VISIT);
        // A visit is passive acknowledgement: ordering must not move.
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("advances a newer visit past an older one", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-visit-advance"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: LATER_VISIT,
        },
        readModel: makeReadModel({ lastVisitedAt: EARLIER_VISIT }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.visited") {
        expect(events[0].payload.lastVisitedAt).toBe(LATER_VISIT);
      }
    }),
  );

  it.effect("keeps the existing stamp when a raced older visit arrives", () =>
    Effect.gen(function* () {
      // Monotonic: a stale visit from a lagging device re-emits the current
      // value instead of moving the acknowledgement backwards.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-visit-stale"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: EARLIER_VISIT,
        },
        readModel: makeReadModel({ lastVisitedAt: LATER_VISIT }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.visited") {
        expect(events[0].payload.lastVisitedAt).toBe(LATER_VISIT);
        expect(events[0].payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("accepts a visit on an archived thread", () =>
    Effect.gen(function* () {
      // Archived threads stay openable; acknowledging one must not fail.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-visit-archived"),
          threadId: ThreadId.make("thread-1"),
          visitedAt: LATER_VISIT,
        },
        readModel: makeReadModel({ archivedAt: NOW }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.visited");
    }),
  );

  it.effect("rejects a visit for an unknown thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.visit",
          commandId: CommandId.make("cmd-visit-unknown"),
          threadId: ThreadId.make("thread-unknown"),
          visitedAt: LATER_VISIT,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
