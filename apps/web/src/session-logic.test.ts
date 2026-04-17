import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@marcode/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveCompletionDividerBeforeEntryId,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  formatTokenCount,
  formatToolUseCount,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
} from "./session-logic";

function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: Record<string, unknown>;
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  const payload = overrides.payload ?? {};
  return {
    id: EventId.make(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.make(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

describe("derivePendingApprovals", () => {
  it("tracks open approvals and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-1",
          requestKind: "command",
          detail: "bun run lint",
        },
      }),
      makeActivity({
        id: "approval-close",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.resolved",
        summary: "Approval resolved",
        tone: "info",
        payload: { requestId: "req-2" },
      }),
      makeActivity({
        id: "approval-closed-request",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "approval.requested",
        summary: "File-change approval requested",
        tone: "approval",
        payload: { requestId: "req-2", requestKind: "file-change" },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-1",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "bun run lint",
      },
    ]);
  });

  it("maps canonical requestType payloads into pending approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-request-type",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-request-type",
          requestType: "command_execution_approval",
          detail: "pwd",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-request-type",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "pwd",
      },
    ]);
  });

  it("clears stale pending approvals when provider reports unknown pending request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-1",
          detail: "Unknown pending permission request: req-stale-1",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("clears stale pending approvals when the backend marks them stale after restart", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-stale-restart",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval requested",
        tone: "approval",
        payload: {
          requestId: "req-stale-restart-1",
          requestKind: "command",
        },
      }),
      makeActivity({
        id: "approval-failed-stale-restart",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        tone: "error",
        payload: {
          requestId: "req-stale-restart-1",
          detail:
            "Stale pending approval request: req-stale-restart-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([]);
  });

  it("returns empty for empty activities", () => {
    expect(derivePendingApprovals([])).toEqual([]);
  });

  it("handles all 3 request kinds simultaneously", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-cmd",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Command approval",
        tone: "approval",
        payload: {
          requestId: "req-cmd",
          requestKind: "command",
          detail: "npm test",
        },
      }),
      makeActivity({
        id: "approval-read",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "approval.requested",
        summary: "File read approval",
        tone: "approval",
        payload: {
          requestId: "req-read",
          requestKind: "file-read",
          detail: "src/index.ts",
        },
      }),
      makeActivity({
        id: "approval-change",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "approval.requested",
        summary: "File change approval",
        tone: "approval",
        payload: {
          requestId: "req-change",
          requestKind: "file-change",
          detail: "src/app.ts",
        },
      }),
    ];

    const result = derivePendingApprovals(activities);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.requestKind)).toEqual(["command", "file-read", "file-change"]);
  });
});

describe("derivePendingUserInputs", () => {
  it("tracks open structured prompts and removes resolved ones", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: true,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-resolved",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "user-input.resolved",
        summary: "User input submitted",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          answers: {
            sandbox_mode: "workspace-write",
          },
        },
      }),
      makeActivity({
        id: "user-input-open-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-2",
          questions: [
            {
              id: "approval",
              header: "Approval",
              question: "Continue?",
              options: [
                {
                  label: "yes",
                  description: "Continue execution",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([
      {
        requestId: "req-user-input-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
            multiSelect: true,
          },
        ],
      },
    ]);
  });

  it("clears stale pending user-input prompts when the provider reports an orphaned request", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "user-input-open-stale",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        payload: {
          requestId: "req-user-input-stale-1",
          questions: [
            {
              id: "sandbox_mode",
              header: "Sandbox",
              question: "Which mode should be used?",
              options: [
                {
                  label: "workspace-write",
                  description: "Allow workspace writes only",
                },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
      makeActivity({
        id: "user-input-failed-stale",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        tone: "error",
        payload: {
          requestId: "req-user-input-stale-1",
          detail:
            "Stale pending user-input request: req-user-input-stale-1. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
        },
      }),
    ];

    expect(derivePendingUserInputs(activities)).toEqual([]);
  });
});

describe("deriveActivePlanState", () => {
  it("returns the latest plan update for the active turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Initial plan",
          plan: [{ step: "Inspect code", status: "pending" }],
        },
      }),
      makeActivity({
        id: "plan-latest",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          explanation: "Refined plan",
          plan: [{ step: "Implement Codex user input", status: "inProgress" }],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
    });
  });

  it("falls back to the most recent plan from a previous turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-from-turn-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [{ step: "Write tests", status: "completed" }],
        },
      }),
    ];

    // Current turn is turn-2, which has no plan activity — should fall back to turn-1's plan
    const result = deriveActivePlanState(activities, TurnId.make("turn-2"));
    expect(result).toEqual({
      createdAt: "2026-02-23T00:00:01.000Z",
      turnId: "turn-1",
      steps: [{ step: "Write tests", status: "completed" }],
    });
  });
});

describe("findLatestProposedPlan", () => {
  it("prefers the latest proposed plan for the active turn", () => {
    expect(
      findLatestProposedPlan(
        [
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Older",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.make("turn-1"),
            planMarkdown: "# Latest",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.make("turn-2"),
            planMarkdown: "# Different turn",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.make("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# First",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.make("turn-2"),
          planMarkdown: "# Latest",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
  });
});

describe("hasActionableProposedPlan", () => {
  it("returns true for an unimplemented proposed plan", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:01.000Z",
      }),
    ).toBe(true);
  });

  it("returns false for a proposed plan already implemented elsewhere", () => {
    expect(
      hasActionableProposedPlan({
        id: "plan-1",
        turnId: TurnId.make("turn-1"),
        planMarkdown: "# Plan",
        implementedAt: "2026-02-23T00:00:02.000Z",
        implementationThreadId: ThreadId.make("thread-implement"),
        createdAt: "2026-02-23T00:00:00.000Z",
        updatedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe(false);
  });
});

describe("findSidebarProposedPlan", () => {
  it("prefers the running turn source proposed plan when available on the same thread", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Source plan",
                implementedAt: "2026-02-23T00:00:03.000Z",
                implementationThreadId: ThreadId.make("thread-2"),
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
            ],
          },
          {
            id: ThreadId.make("thread-2"),
            proposedPlans: [
              {
                id: "plan-2",
                turnId: TurnId.make("turn-other"),
                planMarkdown: "# Latest elsewhere",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:04.000Z",
                updatedAt: "2026-02-23T00:00:05.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: false,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({
      id: "plan-1",
      turnId: "turn-plan",
      planMarkdown: "# Source plan",
      implementedAt: "2026-02-23T00:00:03.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the latest proposed plan once the turn is settled", () => {
    expect(
      findSidebarProposedPlan({
        threads: [
          {
            id: ThreadId.make("thread-1"),
            proposedPlans: [
              {
                id: "plan-1",
                turnId: TurnId.make("turn-plan"),
                planMarkdown: "# Older",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:01.000Z",
                updatedAt: "2026-02-23T00:00:02.000Z",
              },
              {
                id: "plan-2",
                turnId: TurnId.make("turn-latest"),
                planMarkdown: "# Latest",
                implementedAt: null,
                implementationThreadId: null,
                createdAt: "2026-02-23T00:00:03.000Z",
                updatedAt: "2026-02-23T00:00:04.000Z",
              },
            ],
          },
        ],
        latestTurn: {
          turnId: TurnId.make("turn-implementation"),
          sourceProposedPlan: {
            threadId: ThreadId.make("thread-1"),
            planId: "plan-1",
          },
        },
        latestTurnSettled: true,
        threadId: ThreadId.make("thread-1"),
      })?.planMarkdown,
    ).toBe("# Latest");
  });
});

describe("deriveWorkLogEntries", () => {
  it("omits tool started entries and keeps completed entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "tool-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Tool call",
        kind: "tool.started",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("groups task lifecycle entries into a single agent group entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
        payload: { taskId: "t1", detail: "Explore codebase" },
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
        payload: {
          taskId: "t1",
          detail: "Exploring",
          usage: { total_tokens: 12000, tool_uses: 5 },
        },
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
        payload: {
          taskId: "t1",
          status: "completed",
          usage: { total_tokens: 15000, tool_uses: 8 },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentGroup).toBeDefined();
    expect(entries[0]!.agentGroup!.tasks).toHaveLength(1);
    expect(entries[0]!.agentGroup!.tasks[0]!.taskId).toBe("t1");
    expect(entries[0]!.agentGroup!.tasks[0]!.description).toBe("Explore codebase");
    expect(entries[0]!.agentGroup!.tasks[0]!.status).toBe("completed");
    expect(entries[0]!.agentGroup!.tasks[0]!.toolUses).toBe(8);
    expect(entries[0]!.agentGroup!.tasks[0]!.totalTokens).toBe(15000);
    expect(entries[0]!.label).toBe("1 agent finished");
  });

  it("groups multiple tasks into a single agent group entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Explore CSS" },
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Explore sidebar" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.completed",
        tone: "info",
        payload: {
          taskId: "t1",
          status: "completed",
          usage: { total_tokens: 77900, tool_uses: 35 },
        },
      }),
      makeActivity({
        id: "t2-complete",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "task.completed",
        tone: "info",
        payload: {
          taskId: "t2",
          status: "completed",
          usage: { total_tokens: 54700, tool_uses: 19 },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentGroup!.tasks).toHaveLength(2);
    expect(entries[0]!.label).toBe("2 parallel agents finished");
    expect(entries[0]!.agentGroup!.tasks[0]!.taskId).toBe("t1");
    expect(entries[0]!.agentGroup!.tasks[1]!.taskId).toBe("t2");
  });

  it("shows running status when task has no completed event", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Running analysis" },
      }),
      makeActivity({
        id: "t1-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        tone: "info",
        payload: { taskId: "t1", detail: "Analyzing", usage: { total_tokens: 3000, tool_uses: 2 } },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, { isSessionRunning: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentGroup!.tasks[0]!.status).toBe("running");
    expect(entries[0]!.label).toBe("1 agent running");
  });

  it("shows failed status and error tone in agent group", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Run tests" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        tone: "error",
        payload: { taskId: "t1", status: "failed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.tone).toBe("error");
    expect(entries[0]!.agentGroup!.tasks[0]!.status).toBe("failed");
    expect(entries[0]!.label).toBe("1 agent finished (1 failed)");
  });

  it("handles missing usage data gracefully", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Quick check" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]!.agentGroup!.tasks[0]!.toolUses).toBeNull();
    expect(entries[0]!.agentGroup!.tasks[0]!.totalTokens).toBeNull();
  });

  it("preserves non-task work entries alongside agent group", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1",
        createdAt: "2026-02-23T00:00:00.500Z",
        kind: "tool.completed",
        summary: "File edit",
        tone: "tool",
      }),
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Explore" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
      makeActivity({
        id: "tool-2",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Command run",
        tone: "tool",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    const ids = entries.map((e) => e.id);
    expect(ids[0]).toBe("tool-1");
    expect(entries[1]!.agentGroup).toBeDefined();
    expect(ids[2]).toBe("tool-2");
  });

  it("splits sequential subagents separated by non-task activities into separate groups", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "First agent" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed", usage: { total_tokens: 5000, tool_uses: 3 } },
      }),
      makeActivity({
        id: "tool-between",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Read file",
        tone: "tool",
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Second agent" },
      }),
      makeActivity({
        id: "t2-complete",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t2", status: "completed", usage: { total_tokens: 8000, tool_uses: 5 } },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(3);

    expect(entries[0]!.agentGroup).toBeDefined();
    expect(entries[0]!.agentGroup!.tasks).toHaveLength(1);
    expect(entries[0]!.agentGroup!.tasks[0]!.taskId).toBe("t1");
    expect(entries[0]!.label).toBe("1 agent finished");

    expect(entries[1]!.id).toBe("tool-between");

    expect(entries[2]!.agentGroup).toBeDefined();
    expect(entries[2]!.agentGroup!.tasks).toHaveLength(1);
    expect(entries[2]!.agentGroup!.tasks[0]!.taskId).toBe("t2");
    expect(entries[2]!.label).toBe("1 agent finished");
  });

  it("keeps parallel subagents in one group even when completions are split by non-task activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Parallel A" },
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Parallel B" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
      makeActivity({
        id: "tool-after",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "tool.completed",
        summary: "Read result",
        tone: "tool",
      }),
      makeActivity({
        id: "t2-complete",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t2", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(2);

    expect(entries[0]!.agentGroup).toBeDefined();
    expect(entries[0]!.agentGroup!.tasks).toHaveLength(2);
    expect(entries[0]!.agentGroup!.tasks[0]!.taskId).toBe("t1");
    expect(entries[0]!.agentGroup!.tasks[1]!.taskId).toBe("t2");
    expect(entries[0]!.agentGroup!.tasks[0]!.status).toBe("completed");
    expect(entries[0]!.agentGroup!.tasks[1]!.status).toBe("completed");
    expect(entries[0]!.label).toBe("2 parallel agents finished");

    expect(entries[1]!.id).toBe("tool-after");
  });

  it("separates sequential subagents even when task.completed sorts after next task.started", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Solo agent" },
      }),
      makeActivity({
        id: "t1-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        tone: "info",
        payload: { taskId: "t1", detail: "Working..." },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Parallel A" },
      }),
      makeActivity({
        id: "t3-start",
        createdAt: "2026-02-23T00:00:03.500Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t3", detail: "Parallel B" },
      }),
      makeActivity({
        id: "t2-complete",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t2", status: "completed" },
      }),
      makeActivity({
        id: "t3-complete",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t3", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    const groups = entries.filter((e) => e.agentGroup);
    expect(groups).toHaveLength(2);

    expect(groups[0]!.agentGroup!.tasks).toHaveLength(1);
    expect(groups[0]!.agentGroup!.tasks[0]!.taskId).toBe("t1");

    expect(groups[1]!.agentGroup!.tasks).toHaveLength(2);
    expect(groups[1]!.agentGroup!.tasks[0]!.taskId).toBe("t2");
    expect(groups[1]!.agentGroup!.tasks[1]!.taskId).toBe("t3");
  });

  it("keeps parallel subagents grouped even when progress events interleave with started events", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Agent 1" },
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:01.200Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Agent 2" },
      }),
      makeActivity({
        id: "t1-progress",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "task.progress",
        tone: "info",
        payload: { taskId: "t1", detail: "Working..." },
      }),
      makeActivity({
        id: "t3-start",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t3", detail: "Agent 3" },
      }),
      makeActivity({
        id: "t2-progress",
        createdAt: "2026-02-23T00:00:01.800Z",
        kind: "task.progress",
        tone: "info",
        payload: { taskId: "t2", detail: "Working..." },
      }),
      makeActivity({
        id: "t4-start",
        createdAt: "2026-02-23T00:00:01.800Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t4", detail: "Agent 4" },
      }),
      makeActivity({
        id: "t3-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        tone: "info",
        payload: { taskId: "t3", detail: "Working..." },
      }),
      makeActivity({
        id: "t5-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t5", detail: "Agent 5" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:30.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
      makeActivity({
        id: "t2-complete",
        createdAt: "2026-02-23T00:00:31.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t2", status: "completed" },
      }),
      makeActivity({
        id: "t3-complete",
        createdAt: "2026-02-23T00:00:32.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t3", status: "completed" },
      }),
      makeActivity({
        id: "t4-complete",
        createdAt: "2026-02-23T00:00:33.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t4", status: "completed" },
      }),
      makeActivity({
        id: "t5-complete",
        createdAt: "2026-02-23T00:00:34.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t5", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    const groups = entries.filter((e) => e.agentGroup);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.agentGroup!.tasks).toHaveLength(5);
  });

  it("shows mixed label when some tasks are running and some completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "First task" },
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Second task" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined, { isSessionRunning: true });
    expect(entries[0]!.label).toBe("2 parallel agents (1 running)");
  });

  it("handles task.progress without preceding task.started", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        tone: "info",
        payload: {
          taskId: "t1",
          detail: "Checking files",
          usage: { total_tokens: 5000, tool_uses: 3 },
        },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentGroup!.tasks[0]!.description).toBe("Checking files");
    expect(entries[0]!.agentGroup!.tasks[0]!.status).toBe("completed");
  });

  it("handles stopped task status", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Long task" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "stopped" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]!.agentGroup!.tasks[0]!.status).toBe("stopped");
  });

  it("extracts agentType from task.started payload", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Explore files", agentType: "Explore" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]!.agentGroup!.tasks[0]!.agentType).toBe("Explore");
  });

  it("sets agentType to null when not present in payload", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Quick check" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries[0]!.agentGroup!.tasks[0]!.agentType).toBeNull();
  });

  it("omits collab_agent_tool_call entries from work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "subagent-tool",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        payload: { itemType: "collab_agent_tool_call" },
      }),
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Run analysis" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
      makeActivity({
        id: "regular-tool",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.completed",
        summary: "Read file",
        tone: "tool",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain("subagent-tool");
    expect(ids).toContain("regular-tool");
    expect(entries.find((e) => e.agentGroup)).toBeDefined();
  });

  it("filters by turn id when provided", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "turn-1", turnId: "turn-1", summary: "Tool call", kind: "tool.started" }),
      makeActivity({
        id: "turn-2",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({ id: "no-turn", summary: "Checkpoint captured", tone: "info" }),
    ];

    const entries = deriveWorkLogEntries(activities, TurnId.make("turn-2"));
    expect(entries.map((entry) => entry.id)).toEqual(["turn-2"]);
  });

  it("omits checkpoint captured info entries", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "checkpoint",
        createdAt: "2026-02-23T00:00:01.000Z",
        summary: "Checkpoint captured",
        tone: "info",
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        summary: "Ran command",
        tone: "tool",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits ExitPlanMode lifecycle entries once the plan card is shown", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "exit-plan-updated",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          detail: 'ExitPlanMode: {"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
        },
      }),
      makeActivity({
        id: "exit-plan-completed",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          detail: "ExitPlanMode: {}",
        },
      }),
      makeActivity({
        id: "real-work-log",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail: "Bash: bun test",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["real-work-log"]);
  });

  it("orders work log by activity sequence when present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "second",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 2,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "first",
        createdAt: "2026-02-23T00:00:04.000Z",
        sequence: 1,
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("extracts command text for command tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["bun", "run", "lint"],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
  });

  it("unwraps PowerShell command wrappers for displayed command text", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bun run lint");
    expect(entry?.rawCommand).toBe(
      "\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -Command 'bun run lint'",
    );
  });

  it("unwraps PowerShell command wrappers from argv-style command payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-wrapper-argv",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "rg -n foo ."],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("rg -n foo .");
    expect(entry?.rawCommand).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n foo ."',
    );
  });

  it("extracts command text from command detail when structured command metadata is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-windows-detail-fallback",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          detail:
            '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command \'rg -n -F "new Date()" .\' <exited with exit code 0>',
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe('rg -n -F "new Date()" .');
    expect(entry?.rawCommand).toBe(
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -Command 'rg -n -F "new Date()" .'`,
    );
  });

  it("does not unwrap shell commands when no wrapper flag is present", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-shell-script",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: {
            item: {
              command: "bash script.sh",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("keeps compact Codex tool metadata used for icons and labels", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-with-metadata",
        kind: "tool.completed",
        summary: "bash",
        payload: {
          itemType: "command_execution",
          title: "bash",
          status: "completed",
          detail: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
          data: {
            item: {
              command: ["bun", "run", "dev"],
              result: {
                content: '{ "dev": "vite dev --port 3000" } <exited with exit code 0>',
                exitCode: 0,
              },
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      command: "bun run dev",
      detail: '{ "dev": "vite dev --port 3000" }',
      itemType: "command_execution",
      toolTitle: "bash",
    });
  });

  it("extracts changed file paths for file-change tool activities", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "file-tool",
        kind: "tool.completed",
        summary: "File change",
        payload: {
          itemType: "file_change",
          data: {
            item: {
              changes: [
                { path: "apps/web/src/components/ChatView.tsx" },
                { filename: "apps/web/src/session-logic.ts" },
              ],
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.changedFiles).toEqual([
      "apps/web/src/components/ChatView.tsx",
      "apps/web/src/session-logic.ts",
    ]);
  });

  it("drops duplicated tool detail when it only repeats the title", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-file-generic",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry?.toolTitle).toBe("Read File");
    expect(entry?.detail).toBeUndefined();
  });

  it("uses grep raw output summaries instead of repeating the generic tool label", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "grep-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "grep-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "grep",
        payload: {
          itemType: "web_search",
          title: "grep",
          detail: "grep",
          data: {
            toolCallId: "tool-grep-1",
            kind: "search",
            rawOutput: {
              totalFiles: 19,
              truncated: false,
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "grep-complete",
      toolTitle: "grep",
      detail: "19 files",
      itemType: "web_search",
    });
  });

  it("uses completed read-file output previews and still collapses the same tool call", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-1",
            kind: "read",
            rawOutput: {
              content:
                'import * as Effect from "effect/Effect"\nimport * as Layer from "effect/Layer"\n',
            },
          },
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-complete",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("does not use command stdout as the detail when Cursor omits the command input", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "cursor-command-complete",
        createdAt: "2026-04-16T22:40:42.221Z",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: "toolu_vrtx_01WypXgRM8PPygBtrVAZwzy5",
            kind: "execute",
            rawInput: {},
            rawOutput: {
              exitCode: 0,
              stdout: "total 960\napps\npackages\n",
              stderr: "",
            },
          },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities, undefined);
    expect(entry).toMatchObject({
      id: "cursor-command-complete",
      label: "Ran command",
      itemType: "command_execution",
      toolTitle: "Ran command",
    });
    expect(entry?.detail).toBeUndefined();
    expect(entry?.command).toBeUndefined();
  });

  it("collapses legacy completed tool rows that are missing tool metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "legacy-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
          data: {
            toolCallId: "tool-read-legacy",
            kind: "read",
            rawInput: {},
          },
        },
      }),
      makeActivity({
        id: "legacy-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Read File",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Read File",
          detail: "Read File",
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "legacy-read-complete",
      toolTitle: "Read File",
      itemType: "dynamic_tool_call",
    });
    expect(entries[0]?.detail).toBeUndefined();
  });

  it("collapses repeated lifecycle updates for the same tool call into one entry", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-update-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-update-2",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
          data: {
            item: {
              command: ["sed", "-n", "1,40p", "/tmp/app.ts"],
            },
          },
        },
      }),
      makeActivity({
        id: "tool-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call completed",
      detail: 'Read: {"file_path":"/tmp/app.ts"}',
      command: "sed -n 1,40p /tmp/app.ts",
      itemType: "dynamic_tool_call",
      toolTitle: "Tool call",
    });
  });

  it("keeps separate tool entries when an identical call starts after the prior one completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-1-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-1-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-update",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "tool-2-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.completed",
        summary: "Tool call completed",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries.map((entry) => entry.id)).toEqual(["tool-1-complete", "tool-2-complete"]);
  });

  it("collapses same-timestamp lifecycle rows even when completed sorts before updated by id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "z-update-earlier",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "a-complete-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
      makeActivity({
        id: "z-update-same-timestamp",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Tool call",
        payload: {
          itemType: "dynamic_tool_call",
          title: "Tool call",
          detail: 'Read: {"file_path":"/tmp/app.ts"}',
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });

  it("splits a later task into a new group when earlier parallel tasks have completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "Explore A" },
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Explore B" },
      }),
      makeActivity({
        id: "t3-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t3", detail: "Explore C" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
      makeActivity({
        id: "t2-complete",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t2", status: "completed" },
      }),
      makeActivity({
        id: "t3-complete",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t3", status: "completed" },
      }),
      makeActivity({
        id: "t4-start",
        createdAt: "2026-02-23T00:00:10.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t4", detail: "Plan implementation" },
      }),
      makeActivity({
        id: "t4-complete",
        createdAt: "2026-02-23T00:00:15.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t4", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(2);

    expect(entries[0]!.agentGroup!.tasks).toHaveLength(3);
    expect(entries[0]!.agentGroup!.tasks.map((t) => t.taskId)).toEqual(["t1", "t2", "t3"]);

    expect(entries[1]!.agentGroup!.tasks).toHaveLength(1);
    expect(entries[1]!.agentGroup!.tasks[0]!.taskId).toBe("t4");
  });

  it("splits sequential single-task launches into separate groups", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "t1-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t1", detail: "First agent" },
      }),
      makeActivity({
        id: "t1-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t1", status: "completed" },
      }),
      makeActivity({
        id: "t2-start",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.started",
        tone: "info",
        payload: { taskId: "t2", detail: "Second agent" },
      }),
      makeActivity({
        id: "t2-complete",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "task.completed",
        tone: "info",
        payload: { taskId: "t2", status: "completed" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries).toHaveLength(2);

    expect(entries[0]!.agentGroup!.tasks).toHaveLength(1);
    expect(entries[0]!.agentGroup!.tasks[0]!.taskId).toBe("t1");

    expect(entries[1]!.agentGroup!.tasks).toHaveLength(1);
    expect(entries[1]!.agentGroup!.tasks[0]!.taskId).toBe("t2");
  });
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.make("turn-1"),
          planMarkdown: "# Ship it",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:02.000Z",
        },
      ],
      [
        {
          id: "work-1",
          createdAt: "2026-02-23T00:00:03.000Z",
          label: "Ran tests",
          tone: "tool",
        },
      ],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
        implementedAt: null,
        implementationThreadId: null,
      },
    });
  });

  it("anchors the completion divider to latestTurn.assistantMessageId before timestamp fallback", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("assistant-earlier"),
          role: "assistant",
          text: "progress update",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "final answer",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [],
      [],
    );

    expect(
      deriveCompletionDividerBeforeEntryId(entries, {
        assistantMessageId: MessageId.make("assistant-final"),
        startedAt: "2026-02-23T00:00:00.000Z",
        completedAt: "2026-02-23T00:00:02.000Z",
      }),
    ).toBe("assistant-final");
  });
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "context-1",
          turnId: "turn-1",
          kind: "context-window.updated",
          summary: "Context window updated",
          tone: "info",
        }),
        makeActivity({
          id: "tool-1",
          turnId: "turn-1",
          kind: "tool.completed",
          summary: "Ran command",
          tone: "tool",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries(
      [
        makeActivity({
          id: "compaction-1",
          turnId: "turn-1",
          kind: "context-compaction",
          summary: "Context compacted",
          tone: "info",
        }),
      ],
      TurnId.make("turn-1"),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
  });
});

describe("hasToolActivityForTurn", () => {
  it("returns false when turn id is missing", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
    ];

    expect(hasToolActivityForTurn(activities, undefined)).toBe(false);
    expect(hasToolActivityForTurn(activities, null)).toBe(false);
  });

  it("returns true only for matching tool activity in the target turn", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({ id: "tool-1", turnId: "turn-1", kind: "tool.completed", tone: "tool" }),
      makeActivity({ id: "info-1", turnId: "turn-2", kind: "turn.completed", tone: "info" }),
    ];

    expect(hasToolActivityForTurn(activities, TurnId.make("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.make("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "ready",
        activeTurnId: undefined,
      }),
    ).toBe(true);
  });

  it("returns false when turn timestamps are incomplete", () => {
    expect(
      isLatestTurnSettled(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("uses the new send start while the session is running a different turn", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "ready",
          activeTurnId: undefined,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send after the prior turn completed", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          turnId: TurnId.make("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("formatTokenCount", () => {
  it("formats small counts without abbreviation", () => {
    expect(formatTokenCount(500)).toBe("500 tokens");
  });

  it("formats thousands with one decimal", () => {
    expect(formatTokenCount(12000)).toBe("12.0k tokens");
    expect(formatTokenCount(77900)).toBe("77.9k tokens");
  });

  it("formats large counts rounded", () => {
    expect(formatTokenCount(150000)).toBe("150k tokens");
  });
});

describe("formatToolUseCount", () => {
  it("uses singular for count of 1", () => {
    expect(formatToolUseCount(1)).toBe("1 tool use");
  });

  it("uses plural for other counts", () => {
    expect(formatToolUseCount(0)).toBe("0 tool uses");
    expect(formatToolUseCount(35)).toBe("35 tool uses");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("advertises available providers while keeping Cursor as a placeholder", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeAgent");
    const opencode = PROVIDER_OPTIONS.find((option) => option.value === "opencode");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "claudeAgent", label: "Claude", available: true },
      { value: "codex", label: "Codex", available: true },
      { value: "opencode", label: "OpenCode", available: true },
      { value: "cursor", label: "Cursor", available: true },
    ]);
    expect(claude).toEqual({
      value: "claudeAgent",
      label: "Claude",
      available: true,
    });
    expect(opencode).toEqual({
      value: "opencode",
      label: "OpenCode",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: true,
    });
  });
});
