import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { occupiedSceneryThreadKeys } from "./scenery-occupancy";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-01T00:00:00.000Z";

function makeThread(input: {
  readonly id?: string;
  readonly environmentId?: string;
  readonly archivedAt?: string | null;
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: string | null;
  readonly activityAt?: string | null;
}): EnvironmentThreadShell {
  const threadId = ThreadId.make(input.id ?? "thread-1");
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    id: threadId,
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
    latestTurn:
      input.activityAt === null || input.activityAt === undefined
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: input.activityAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: input.archivedAt ?? null,
    settledOverride: input.settledOverride ?? null,
    settledAt:
      input.settledAt !== undefined
        ? input.settledAt
        : input.settledOverride === "settled"
          ? NOW
          : null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    autoReviewPhase: null,
  };
}

describe("occupiedSceneryThreadKeys", () => {
  it("includes open unsettled threads and queued pending tasks", () => {
    const keys = occupiedSceneryThreadKeys({
      threads: [
        makeThread({ id: "thread-active", activityAt: FRESH }),
        makeThread({ id: "thread-stale-settled", activityAt: STALE }),
        makeThread({ id: "thread-explicitly-settled", settledOverride: "settled" }),
        makeThread({ id: "thread-archived", archivedAt: FRESH, activityAt: FRESH }),
      ],
      pendingTasks: [
        {
          message: {
            environmentId: EnvironmentId.make("environment-1"),
            threadId: ThreadId.make("thread-queued"),
          },
        },
      ],
      now: NOW,
    });

    expect(keys).toEqual(new Set(["environment-1:thread-active", "environment-1:thread-queued"]));
  });

  it("an explicit active override keeps a stale thread occupying its scene", () => {
    const keys = occupiedSceneryThreadKeys({
      threads: [makeThread({ id: "thread-pinned", settledOverride: "active", activityAt: STALE })],
      now: NOW,
    });
    expect(keys).toEqual(new Set(["environment-1:thread-pinned"]));
  });

  it("scopes keys by environment", () => {
    const keys = occupiedSceneryThreadKeys({
      threads: [
        makeThread({ id: "thread-1", environmentId: "env-a", activityAt: FRESH }),
        makeThread({ id: "thread-1", environmentId: "env-b", activityAt: FRESH }),
      ],
      now: NOW,
    });
    expect(keys).toEqual(new Set(["env-a:thread-1", "env-b:thread-1"]));
  });
});
