import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import { threadDetailToShell } from "./threadDetailShell";

function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "id" | "kind" | "summary" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "info",
    payload: {},
    turnId: null,
    ...input,
  };
}

function makePlan(
  input: Partial<OrchestrationProposedPlan> & Pick<OrchestrationProposedPlan, "id">,
): OrchestrationProposedPlan {
  return {
    turnId: null,
    planMarkdown: "# Plan\n\nDo the thing.",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(input: Partial<OrchestrationThread>): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    executorModelSelection: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    parentThreadId: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    autoReviewPhase: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    settledOverride: null,
    settledAt: null,
    ...input,
  };
}

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

describe("threadDetailToShell", () => {
  it("reports no pending items for a quiet thread", () => {
    const shell = threadDetailToShell(ENVIRONMENT_ID, makeThread({}));

    expect(shell.hasPendingApprovals).toBe(false);
    expect(shell.hasPendingUserInput).toBe(false);
    expect(shell.hasActionableProposedPlan).toBe(false);
  });

  it("derives hasPendingApprovals from unresolved approval activities", () => {
    const shell = threadDetailToShell(
      ENVIRONMENT_ID,
      makeThread({
        activities: [
          makeActivity({
            id: EventId.make("activity-1"),
            kind: "approval.requested",
            summary: "Approval requested",
            createdAt: "2026-04-01T00:00:01.000Z",
            payload: { requestId: "request-1", requestKind: "command" },
          }),
        ],
      }),
    );

    expect(shell.hasPendingApprovals).toBe(true);
  });

  it("clears hasPendingApprovals once the approval resolves", () => {
    const shell = threadDetailToShell(
      ENVIRONMENT_ID,
      makeThread({
        activities: [
          makeActivity({
            id: EventId.make("activity-1"),
            kind: "approval.requested",
            summary: "Approval requested",
            createdAt: "2026-04-01T00:00:01.000Z",
            payload: { requestId: "request-1", requestKind: "command" },
          }),
          makeActivity({
            id: EventId.make("activity-2"),
            kind: "approval.resolved",
            summary: "Approval resolved",
            createdAt: "2026-04-01T00:00:02.000Z",
            payload: { requestId: "request-1" },
          }),
        ],
      }),
    );

    expect(shell.hasPendingApprovals).toBe(false);
  });

  it("derives hasPendingUserInput from unresolved user-input activities", () => {
    const shell = threadDetailToShell(
      ENVIRONMENT_ID,
      makeThread({
        activities: [
          makeActivity({
            id: EventId.make("activity-1"),
            kind: "user-input.requested",
            summary: "User input requested",
            createdAt: "2026-04-01T00:00:01.000Z",
            payload: {
              requestId: "request-1",
              questions: [
                {
                  id: "question-1",
                  header: "Scope",
                  question: "Which scope?",
                  options: [{ label: "All", description: "Everything" }],
                },
              ],
            },
          }),
        ],
      }),
    );

    expect(shell.hasPendingUserInput).toBe(true);
  });

  it("derives hasActionableProposedPlan from the thread's proposed plans", () => {
    const pendingShell = threadDetailToShell(
      ENVIRONMENT_ID,
      makeThread({
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-04-01T00:00:00.000Z",
          startedAt: "2026-04-01T00:00:01.000Z",
          completedAt: "2026-04-01T00:00:02.000Z",
          assistantMessageId: null,
        },
        proposedPlans: [makePlan({ id: "plan-1", turnId: TurnId.make("turn-1") })],
      }),
    );
    expect(pendingShell.hasActionableProposedPlan).toBe(true);

    const implementedShell = threadDetailToShell(
      ENVIRONMENT_ID,
      makeThread({
        proposedPlans: [makePlan({ id: "plan-1", implementedAt: "2026-04-02T00:00:00.000Z" })],
      }),
    );
    expect(implementedShell.hasActionableProposedPlan).toBe(false);
  });

  it("derives latestUserMessageAt from the newest user message", () => {
    const shell = threadDetailToShell(
      ENVIRONMENT_ID,
      makeThread({
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "user",
            text: "first",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T00:00:01.000Z",
            updatedAt: "2026-04-01T00:00:01.000Z",
          },
          {
            id: MessageId.make("message-2"),
            role: "assistant",
            text: "reply",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T00:00:03.000Z",
            updatedAt: "2026-04-01T00:00:03.000Z",
          },
          {
            id: MessageId.make("message-3"),
            role: "user",
            text: "second",
            turnId: null,
            streaming: false,
            createdAt: "2026-04-01T00:00:02.000Z",
            updatedAt: "2026-04-01T00:00:02.000Z",
          },
        ],
      }),
    );

    expect(shell.latestUserMessageAt).toBe("2026-04-01T00:00:02.000Z");
  });
});
