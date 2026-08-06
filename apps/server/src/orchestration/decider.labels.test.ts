import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadLabel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(label: ThreadLabel | null): OrchestrationReadModel {
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
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        label,
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

it.layer(NodeServices.layer)("thread label decider", (it) => {
  it.effect("sets and clears labels through thread metadata", () =>
    Effect.gen(function* () {
      const setEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-label-set"),
          threadId: ThreadId.make("thread-1"),
          label: "bug",
        },
        readModel: makeReadModel(null),
      });
      const setEvents = Array.isArray(setEvent) ? setEvent : [setEvent];
      expect(setEvents).toHaveLength(1);
      expect(setEvents[0]?.type).toBe("thread.meta-updated");
      if (setEvents[0]?.type !== "thread.meta-updated") return;
      expect(setEvents[0].payload.label).toBe("bug");

      const clearEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-label-clear"),
          threadId: ThreadId.make("thread-1"),
          label: null,
        },
        readModel: makeReadModel("bug"),
      });
      const clearEvents = Array.isArray(clearEvent) ? clearEvent : [clearEvent];
      expect(clearEvents[0]?.type).toBe("thread.meta-updated");
      if (clearEvents[0]?.type === "thread.meta-updated") {
        expect(clearEvents[0].payload.label).toBeNull();
      }
    }),
  );

  it.effect("drops a stale compare-and-set label update", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-stale-label-set"),
          threadId: ThreadId.make("thread-1"),
          label: "feature",
          expectedLabel: null,
        },
        readModel: makeReadModel("bug"),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type !== "thread.meta-updated") return;
      expect(events[0].payload.label).toBeUndefined();
    }),
  );
});
