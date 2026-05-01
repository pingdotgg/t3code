import { type OrchestrationThread, ProjectId, ThreadId } from "@forma/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { waitForThreadDetailSnapshot } from "./threadSnapshots.ts";

it.effect("waits for thread detail snapshots that arrive after an initial miss", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const threadId = ThreadId.make("thread-delayed");
    const thread: OrchestrationThread = {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Delayed Thread",
      modelSelection: {
        provider: "codex" as const,
        model: "gpt-5-codex",
      },
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z",
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      turnQueue: {
        items: [],
        status: "idle" as const,
        pauseReason: null,
      },
      deletedAt: null,
    };

    const snapshot = yield* waitForThreadDetailSnapshot({
      threadId,
      getThreadDetailById: () =>
        Effect.sync(() => {
          attempts += 1;
          return attempts >= 2 ? Option.some(thread) : Option.none();
        }),
      getSnapshotSequence: () => Effect.succeed(7),
      pollIntervalMs: 0,
    });

    assert.equal(attempts, 2);
    assert.deepEqual(snapshot, {
      snapshotSequence: 7,
      thread,
    });
  }),
);
