import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { foldOperatorThreads } from "./operatorRuntime.ts";

function operatorThread(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoning_effort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/operator-test",
    worktreePath: "/worktrees/operator-test",
    latestTurn: null,
    createdAt: "2026-08-12T10:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("foldOperatorThreads", () => {
  it("maps only durable sidebar tasks owned by the coordinator", () => {
    const coordinatorId = ThreadId.make("coordinator");
    const running = operatorThread("frontend", {
      title: "Build frontend",
      operatorParentThreadId: coordinatorId,
      latestTurn: {
        turnId: TurnId.make("turn-frontend"),
        state: "running",
        requestedAt: "2026-08-12T10:00:01.000Z",
        startedAt: "2026-08-12T10:00:02.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        threadId: ThreadId.make("frontend"),
        status: "running",
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-frontend"),
        lastError: null,
        updatedAt: "2026-08-12T10:00:02.000Z",
      },
    });
    const waiting = operatorThread("backend", {
      title: "Build backend",
      operatorParentThreadId: coordinatorId,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claude"),
        model: "opus-5",
        options: [{ id: "effort", value: "max" }],
      },
      hasPendingUserInput: true,
    });
    const unrelated = operatorThread("unrelated", {
      operatorParentThreadId: ThreadId.make("another-coordinator"),
    });

    const tasks = foldOperatorThreads([running, waiting, unrelated], coordinatorId);

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      id: ThreadId.make("frontend"),
      title: "Build frontend",
      providerInstanceId: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      status: "running",
      startedAt: "2026-08-12T10:00:02.000Z",
    });
    expect(tasks[1]).toMatchObject({
      id: ThreadId.make("backend"),
      title: "Build backend",
      providerInstanceId: "claude",
      model: "opus-5",
      effort: "max",
      status: "waiting",
      progress: "Needs attention",
    });
  });
});
