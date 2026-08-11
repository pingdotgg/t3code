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
const THREAD_UPDATED_AT = "2026-01-01T00:00:05.000Z";

function makeReadModel(input: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("aether"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: input.branch,
        worktreePath: input.worktreePath,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: THREAD_UPDATED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
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

const attachCommand = {
  type: "thread.worktree.attach-managed",
  commandId: CommandId.make("cmd-attach-managed"),
  threadId: ThreadId.make("thread-1"),
  branch: "t3code/1234abcd",
  worktreePath: "/tmp/worktrees/thread-1",
  expectedBranch: null,
  expectedWorktreePath: null,
} as const;

it.layer(NodeServices.layer)("thread.worktree.attach-managed decider", (it) => {
  it.effect("marks the worktree managed when the thread is still where the bootstrap left it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: attachCommand,
        readModel: makeReadModel({ branch: null, worktreePath: null }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.worktreePath).toBe("/tmp/worktrees/thread-1");
        expect(events[0].payload.branch).toBe("t3code/1234abcd");
        expect(events[0].payload.worktreeManaged).toBe(true);
      }
    }),
  );

  it.effect("no-ops when the user repointed the thread while the worktree was being created", () =>
    Effect.gen(function* () {
      // The stale attach must neither revert the newer selection nor mark the
      // user's own worktree driver-owned — that marker is what makes drivers
      // drop their clean-tree guards.
      const event = yield* decideOrchestrationCommand({
        command: attachCommand,
        readModel: makeReadModel({
          branch: "feature/user-pick",
          worktreePath: "/tmp/user-worktrees/feature-user-pick",
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.worktreePath).toBeUndefined();
        expect(events[0].payload.branch).toBeUndefined();
        expect(events[0].payload.worktreeManaged).toBeUndefined();
        // A projected no-op: the thread's own updatedAt is carried forward.
        expect(events[0].payload.updatedAt).toBe(THREAD_UPDATED_AT);
      }
    }),
  );

  it.effect("no-ops when only the branch moved under the bootstrap", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: attachCommand,
        readModel: makeReadModel({ branch: "feature/renamed", worktreePath: null }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.worktreeManaged).toBeUndefined();
        expect(events[0].payload.updatedAt).toBe(THREAD_UPDATED_AT);
      }
    }),
  );
});
