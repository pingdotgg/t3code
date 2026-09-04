import {
  classifyTaskAgentKind,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveWorkEntryToolPresentation } from "@t3tools/client-runtime/work-log/presentation";

import {
  createMessageAttachmentPreviewProjector,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveTimelineEntriesWithState,
  deriveWorkLogEntries,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  selectHandoffImageResources,
  selectMessageImageResources,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
} from "./session-logic";

let nextActivityId = 0;

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
  // Fixtures model post-ingestion rows: ingestion stamps agentKind on every
  // task.* payload. Pass an explicit agentKind to model legacy rows.
  const rawPayload = overrides.payload ?? {};
  const payload =
    overrides.kind?.startsWith("task.") && !("agentKind" in rawPayload)
      ? {
          ...rawPayload,
          agentKind: classifyTaskAgentKind({
            taskType: typeof rawPayload.taskType === "string" ? rawPayload.taskType : undefined,
            agentId: typeof rawPayload.agentId === "string" ? rawPayload.agentId : undefined,
          }),
        }
      : rawPayload;
  return {
    id: EventId.make(overrides.id ?? `activity-${nextActivityId++}`),
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
  it.each([{}, { requestType: "unknown" }])(
    "exposes legacy OpenCode approvals without a known request kind: %j",
    (legacyPayload) => {
      const requested = makeActivity({
        kind: "approval.requested",
        payload: { requestId: "per-legacy", detail: "*", ...legacyPayload },
      });

      expect(derivePendingApprovals([requested])).toEqual([
        {
          requestId: "per-legacy",
          requestKind: "command",
          createdAt: requested.createdAt,
          detail: "*",
        },
      ]);
    },
  );

  it.each(["tool_user_input", "auth_tokens_refresh"])(
    "does not turn %s into an approval",
    (requestType) => {
      const activity = makeActivity({
        kind: "approval.requested",
        payload: { requestId: "not-an-approval", requestType },
      });

      expect(derivePendingApprovals([activity])).toEqual([]);
    },
  );

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
        payload: { requestId: "req-2", requestType: "unknown" },
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

  it("keeps app access approvals and persistence choices from remote activities", () => {
    const options = [
      { decision: "decline", label: "Decline" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Approve" },
    ];
    const activities = [
      makeActivity({
        kind: "approval.requested",
        summary: "App access approval requested",
        tone: "approval",
        payload: {
          requestId: "req-safari",
          requestType: "mcp_elicitation_approval",
          detail: "Allow ChatGPT to use Safari?",
          appName: "Safari",
          options,
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-safari",
        requestKind: "mcp-elicitation",
        createdAt: "2026-02-23T00:00:00.000Z",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    ]);
  });

  it("derives dynamic tool requests as actionable generic approvals", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "approval-open-dynamic-tool",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "approval.requested",
        summary: "Approval requested",
        tone: "approval",
        payload: {
          requestId: "req-dynamic-tool",
          requestType: "dynamic_tool_call",
          detail: "Search the web",
        },
      }),
    ];

    expect(derivePendingApprovals(activities)).toEqual([
      {
        requestId: "req-dynamic-tool",
        requestKind: "command",
        createdAt: "2026-02-23T00:00:01.000Z",
        detail: "Search the web",
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
          requestType: "unknown",
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
});

describe("derivePendingUserInputs", () => {
  it("keeps free-text questions without suggested answers", () => {
    const question = {
      id: "0",
      header: "Question",
      question: "What should it be named?",
      options: [],
      allowCustomAnswer: true,
      multiSelect: false,
    };
    const activities = [
      makeActivity({
        id: "async-question",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { requestId: "async-1", responseMode: "message", questions: [question] },
      }),
    ];
    expect(derivePendingUserInputs(activities)[0]?.questions).toEqual([question]);
  });

  it("preserves native choice values and the custom-answer restriction", () => {
    const question = {
      id: "interaction-result",
      header: "Result",
      question: "Which result should be used?",
      options: [
        { value: " first\t", label: "Result", description: "First result" },
        { value: "second", label: "Result", description: "Second result" },
      ],
      allowCustomAnswer: false,
      multiSelect: false,
    };
    const activities = [
      makeActivity({
        id: "native-user-input",
        kind: "user-input.requested",
        summary: "User input requested",
        payload: { requestId: "req-native-choice", questions: [question] },
      }),
    ];

    expect(derivePendingUserInputs(activities)[0]?.questions).toEqual([question]);
  });

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
            "Provider adapter request failed (codex) for item/tool/requestUserInput: Unknown pending Codex user input request: req-user-input-stale-1",
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

  it("starts timing again after a plan is cleared and recreated", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-old-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: { plan: [{ step: "Check", status: "inProgress" }] },
      }),
      makeActivity({
        id: "plan-old-complete",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: { plan: [{ step: "Check", status: "completed" }] },
      }),
      makeActivity({
        id: "plan-clear",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: { plan: [] },
      }),
      makeActivity({
        id: "plan-new-start",
        createdAt: "2026-02-23T00:00:10.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: { plan: [{ step: "Check", status: "inProgress" }] },
      }),
      makeActivity({
        id: "plan-new-complete",
        createdAt: "2026-02-23T00:00:13.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: { plan: [{ step: "Check", status: "completed" }] },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))?.steps).toEqual([
      { durationMs: 3_000, step: "Check", status: "completed" },
    ]);
  });

  it("tracks repeated step labels independently", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-1a",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [
            { step: "Check", status: "inProgress" },
            { step: "Check", status: "pending" },
          ],
        },
      }),
      makeActivity({
        id: "plan-1b",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [
            { step: "Check", status: "completed" },
            { step: "Check", status: "inProgress" },
          ],
        },
      }),
      makeActivity({
        id: "plan-1c",
        createdAt: "2026-02-23T00:00:11.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [
            { step: "Check", status: "completed" },
            { step: "Check", status: "completed" },
          ],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))?.steps).toEqual([
      { durationMs: 4_000, step: "Check", status: "completed" },
      { durationMs: 6_000, step: "Check", status: "completed" },
    ]);
  });

  it("derives fallback durations in completion order", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [
            { step: "First", status: "pending" },
            { step: "Second", status: "pending" },
          ],
        },
      }),
      makeActivity({
        id: "plan-second-complete",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [
            { step: "First", status: "pending" },
            { step: "Second", status: "completed" },
          ],
        },
      }),
      makeActivity({
        id: "plan-first-complete",
        createdAt: "2026-02-23T00:00:11.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: {
          plan: [
            { step: "First", status: "completed" },
            { step: "Second", status: "completed" },
          ],
        },
      }),
    ];

    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))?.steps).toEqual([
      { durationMs: 5_000, step: "First", status: "completed" },
      { durationMs: 5_000, step: "Second", status: "completed" },
    ]);
  });

  it("clears the active plan when a later snapshot has no steps", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "plan-set",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: { plan: [{ step: "Inspect code", status: "inProgress" }] },
      }),
      makeActivity({
        id: "plan-clear",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        turnId: "turn-1",
        payload: { plan: [] },
      }),
    ];
    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))).toBeNull();
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

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it("is true for error tone", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "error",
        detail: "nothing special",
      }),
    ).toBe(true);
  });

  it("is true when lifecycle says failed even if detail is empty", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "failed",
      }),
    ).toBe(true);
  });

  it("detects file-not-found style tool output with completed lifecycle", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "File not found: C:\\foo\\nonexistent.ts",
      }),
    ).toBe(true);
  });

  it("detects glob no files and PowerShell command errors", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Glob",
        tone: "tool",
        detail: "No files found",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Bash",
        tone: "tool",
        detail:
          "The term 'this_is_not_a_command' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      }),
    ).toBe(true);
  });

  it("is false for successful completed tools", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "Found 3 matching files",
      }),
    ).toBe(false);
  });

  it("treats successful tool rows as success candidates", () => {
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolSuccess({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(false);
    expect(workEntryIndicatesToolSuccess({ ...base, tone: "thinking", detail: "…" })).toBe(false);
    expect(
      workEntryIndicatesToolNeutralStatus({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "inProgress",
        detail: "…",
      }),
    ).toBe(true);
    expect(
      workEntryIndicatesToolNeutralStatus({
        ...base,
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail: "ok",
      }),
    ).toBe(false);
  });

  it("does not run heuristics on non-tool info rows", () => {
    expect(
      workEntryIndicatesToolFailure({
        ...base,
        label: "Context compacted",
        tone: "info",
        detail: "File not found in conversation",
      }),
    ).toBe(false);
  });
});

describe("deriveWorkLogEntries", () => {
  it("keeps the latest task progress without emitting plan-update log entries", () => {
    const activities = [
      makeActivity({ id: "before", kind: "tool.completed", summary: "Read files", sequence: 0 }),
      makeActivity({
        id: "plan-1",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        turnId: "turn-1",
        sequence: 1,
        payload: { plan: [{ step: "Verify the composer", status: "inProgress" }] },
      }),
      makeActivity({
        id: "plan-2",
        kind: "turn.plan.updated",
        summary: "Plan updated",
        turnId: "turn-1",
        sequence: 2,
        payload: { plan: [{ step: "Verify the composer", status: "completed" }] },
      }),
      makeActivity({ id: "after", kind: "tool.completed", summary: "Ran tests", sequence: 3 }),
    ];
    expect(deriveWorkLogEntries(activities).map((entry) => entry.id)).toEqual(["before", "after"]);
    expect(deriveActivePlanState(activities, TurnId.make("turn-1"))?.steps).toMatchObject([
      { step: "Verify the composer", status: "completed" },
    ]);
  });

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

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["tool-complete"]);
  });

  it("omits routine setup updates before work starts and after later turn activity", () => {
    const setupActivities = [
      makeActivity({
        id: "setup-requested",
        kind: "setup-script.requested",
        summary: "Preparing setup script",
        tone: "info",
        sequence: 1,
      }),
      makeActivity({
        id: "setup-started",
        kind: "setup-script.started",
        summary: "Setup script started",
        tone: "info",
        sequence: 2,
      }),
    ];

    expect(deriveWorkLogEntries(setupActivities)).toEqual([]);
    expect(
      deriveWorkLogEntries([
        ...setupActivities,
        makeActivity({
          id: "first-turn-tool",
          kind: "tool.completed",
          summary: "Read project files",
          turnId: "turn-1",
          sequence: 3,
        }),
        makeActivity({
          id: "later-turn-tool",
          kind: "tool.completed",
          summary: "Ran tests",
          turnId: "turn-2",
          sequence: 4,
        }),
      ]).map((entry) => entry.id),
    ).toEqual(["first-turn-tool", "later-turn-tool"]);
  });

  it("preserves setup failures and unrelated info without a turn id", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "setup-requested",
        kind: "setup-script.requested",
        summary: "Preparing setup script",
        tone: "info",
        sequence: 1,
      }),
      makeActivity({
        id: "setup-failed",
        kind: "setup-script.failed",
        summary: "Setup script failed to start",
        tone: "error",
        payload: { detail: "Could not start the setup terminal" },
        sequence: 2,
      }),
      makeActivity({
        id: "runtime-notice",
        kind: "runtime.warning",
        summary: "Reconnecting to provider",
        tone: "info",
        sequence: 3,
      }),
    ]);

    expect(entries).toMatchObject([
      {
        id: "setup-failed",
        label: "Setup script failed to start",
        tone: "error",
        detail: "Could not start the setup terminal",
        turnId: null,
      },
      {
        id: "runtime-notice",
        label: "Reconnecting to provider",
        tone: "info",
        turnId: null,
      },
    ]);
  });

  it("drops runtime warnings with no displayable content, keeps ones with a preview", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "warning-noise",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "runtime.warning",
        summary: "Claude system message 'background_tasks_changed' (no displayable text content)",
        tone: "info",
      }),
      makeActivity({
        id: "warning-signal",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "runtime.warning",
        summary: "Reconnecting... 2/5",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["warning-signal"]);
  });

  it("omits task.started but shows task.progress and task.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "task.started",
        summary: "default task started",
        tone: "info",
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Updating files",
        tone: "info",
      }),
      makeActivity({
        id: "task-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress", "task-complete"]);
  });

  it("uses payload summary as label for task entries when available", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-progress-with-summary",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        payload: { summary: "Searching for API endpoints" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Searching for API endpoints");
  });

  it("uses payload detail as label for task.completed and preserves error tone", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "task-completed-failed",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "task.completed",
        summary: "Task failed",
        tone: "error",
        payload: { detail: "Failed to deploy changes" },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries[0]?.label).toBe("Failed to deploy changes");
    expect(entries[0]?.tone).toBe("error");
  });

  it("keeps tool entries from every turn and tags each with its turn id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        turnId: "turn-1",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
      makeActivity({
        id: "turn-2-tool",
        turnId: "turn-2",
        summary: "Tool call complete",
        kind: "tool.completed",
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries.map((entry) => entry.id)).toEqual(["turn-1-tool", "turn-2-tool"]);
    expect(entries.map((entry) => entry.turnId)).toEqual([
      TurnId.make("turn-1"),
      TurnId.make("turn-2"),
    ]);
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

    const entries = deriveWorkLogEntries(activities);
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

    const entries = deriveWorkLogEntries(activities);
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

    const entries = deriveWorkLogEntries(activities);
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

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bun run lint");
  });

  it("extracts failed tool lifecycle status from item payloads", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-failed",
        kind: "tool.updated",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          status: "failed",
          detail: "No files found",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("failed");
  });

  it("defaults tool.completed entries to completed lifecycle status", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-done",
        kind: "tool.completed",
        summary: "Glob",
        tone: "tool",
        payload: {
          itemType: "mcp_tool_call",
          detail: "Found 3 files",
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolLifecycleStatus).toBe("completed");
  });

  it("preserves MCP server, tool, arguments, and results for expanded display", () => {
    const item = {
      type: "mcpToolCall",
      server: "t3-code",
      tool: "preview_status",
      arguments: {},
      status: "completed",
      result: { content: [{ type: "text", text: "attached" }] },
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-done",
        kind: "tool.completed",
        summary: "t3-code · preview_status",
        payload: {
          itemType: "mcp_tool_call",
          title: "t3-code · preview_status",
          toolSurface: "browser",
          toolIcon: { _tag: "website", pageUrl: "https://example.com/checkout" },
          toolSource: {
            key: "browser-use:browser",
            name: "Browser",
            kind: "browser",
          },
          data: { item },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolTitle).toBe("t3-code · preview_status");
    expect(entry?.toolSurface).toBe("browser");
    expect(entry?.toolIcon).toEqual({
      _tag: "website",
      pageUrl: "https://example.com/checkout",
    });
    expect(entry?.toolSource).toEqual({
      key: "browser-use:browser",
      name: "Browser",
      kind: "browser",
    });
    expect(entry?.toolData).toEqual(item);
  });

  it.each([
    ["inProgress", "Clicking in the preview browser"],
    ["completed", "Clicked in the preview browser"],
    ["failed", "Failed to click in the preview browser"],
  ] as const)(
    "preserves Claude MCP identity behind generic titles while %s",
    (status, displayName) => {
      const data = {
        toolName: "mcp__t3_code__preview_click",
        input: { selector: "#submit" },
        ...(status === "inProgress"
          ? {}
          : { result: { type: "tool_result", is_error: status === "failed", content: "Result" } }),
      };
      const [entry] = deriveWorkLogEntries([
        makeActivity({
          kind: status === "inProgress" ? "tool.updated" : "tool.completed",
          summary: "MCP tool call",
          payload: { itemType: "mcp_tool_call", title: "MCP tool call", status, data },
        }),
      ]);

      expect(entry).toMatchObject({ toolTitle: "MCP tool call", toolData: data });
      expect(resolveWorkEntryToolPresentation(entry!)).toEqual({
        displayName,
        icon: "browser",
      });
    },
  );

  it("keeps MCP payloads while collapsing lifecycle updates", () => {
    const item = {
      type: "mcpToolCall",
      server: "t3-code",
      tool: "preview_snapshot",
      arguments: { interactiveOnly: true },
      status: "completed",
    };
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "mcp-tool-progress",
        kind: "tool.updated",
        summary: "t3-code · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
          toolSurface: "browser",
          data: { item },
        },
      }),
      makeActivity({
        id: "mcp-tool-complete",
        kind: "tool.completed",
        summary: "t3-code · preview_snapshot",
        payload: {
          itemType: "mcp_tool_call",
          toolCallId: "call-1",
          toolIcon: { _tag: "website", pageUrl: "https://example.com/result" },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.toolData).toEqual(item);
    expect(entry?.toolCallId).toBe("call-1");
    expect(entry?.toolSurface).toBe("browser");
    expect(entry?.toolIcon).toEqual({
      _tag: "website",
      pageUrl: "https://example.com/result",
    });
    expect(resolveWorkEntryToolPresentation(entry!)?.displayName).toBe(
      "Took a snapshot of the preview page",
    );
  });

  it("collapses interleaved lifecycle updates by tool call id", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-a-progress",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Tool A",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-a",
          status: "inProgress",
          data: { command: "vp test run" },
        },
      }),
      makeActivity({
        id: "tool-b-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Tool B",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-b",
          status: "inProgress",
          data: { command: "vp lint" },
        },
      }),
      makeActivity({
        id: "tool-a-complete",
        createdAt: "2026-02-23T00:00:03.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Tool A completed",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-a",
          status: "completed",
        },
      }),
      makeActivity({
        id: "tool-b-complete",
        createdAt: "2026-02-23T00:00:04.000Z",
        turnId: "turn-1",
        kind: "tool.completed",
        summary: "Tool B completed",
        payload: {
          itemType: "command_execution",
          toolCallId: "call-b",
          status: "completed",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities)).toMatchObject([
      {
        id: "tool-a-complete",
        command: "vp test run",
        toolCallId: "call-a",
        toolLifecycleStatus: "completed",
      },
      {
        id: "tool-b-complete",
        command: "vp lint",
        toolCallId: "call-b",
        toolLifecycleStatus: "completed",
      },
    ]);
  });

  it("does not merge reused tool call ids across turns", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "turn-1-tool",
        createdAt: "2026-02-23T00:00:01.000Z",
        turnId: "turn-1",
        kind: "tool.updated",
        summary: "Tool",
        payload: {
          itemType: "command_execution",
          toolCallId: "reused-call",
          status: "inProgress",
        },
      }),
      makeActivity({
        id: "turn-2-tool",
        createdAt: "2026-02-23T00:00:02.000Z",
        turnId: "turn-2",
        kind: "tool.completed",
        summary: "Tool completed",
        payload: {
          itemType: "command_execution",
          toolCallId: "reused-call",
          status: "completed",
        },
      }),
    ];

    expect(deriveWorkLogEntries(activities)).toHaveLength(2);
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

    const [entry] = deriveWorkLogEntries(activities);
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

    const [entry] = deriveWorkLogEntries(activities);
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

    const [entry] = deriveWorkLogEntries(activities);
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

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe("bash script.sh");
    expect(entry?.rawCommand).toBeUndefined();
  });

  it("preserves serialized shell wrappers with non-matching boundary quotes", () => {
    const command =
      "/bin/zsh -lc 'git status\nsed -n '\"'1,20p' apps/web/src/components/DiffPanel.tsx\"";
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "command-tool-serialized-wrapper",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          data: { item: { command } },
        },
      }),
    ];

    const [entry] = deriveWorkLogEntries(activities);
    expect(entry?.command).toBe(command);
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

    const [entry] = deriveWorkLogEntries(activities);
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

    const [entry] = deriveWorkLogEntries(activities);
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

    const [entry] = deriveWorkLogEntries(activities);
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

    const entries = deriveWorkLogEntries(activities);
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

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "read-complete",
      toolTitle: "Read File",
      detail: 'import * as Effect from "effect/Effect"',
      itemType: "dynamic_tool_call",
    });
  });

  it("keeps viewed image metadata while collapsing a streamed Claude Read", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "image-read-update",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Image view",
        payload: {
          toolCallId: "tool-read-image",
          itemType: "image_view",
          detail: `${imagePath.slice(0, 177)}...`,
          data: { imagePath },
        },
      }),
      makeActivity({
        id: "image-read-complete",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.completed",
        summary: "Image view",
        payload: {
          toolCallId: "tool-read-image",
          itemType: "image_view",
          detail: `${imagePath.slice(0, 177)}...`,
          data: {},
        },
      }),
    ];

    const entries = deriveWorkLogEntries(activities);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "image-read-complete",
      itemType: "image_view",
      viewedImagePath: imagePath,
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

    const [entry] = deriveWorkLogEntries(activities);
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

    const entries = deriveWorkLogEntries(activities);
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

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "tool-complete",
      createdAt: "2026-02-23T00:00:03.000Z",
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

    const entries = deriveWorkLogEntries(activities);

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

    const entries = deriveWorkLogEntries(activities);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("a-complete-same-timestamp");
  });
});

describe("image asset requests", () => {
  const image = {
    type: "image" as const,
    id: "image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 42,
  };
  const message = {
    id: MessageId.make("image-message"),
    role: "user" as const,
    text: "Inspect these images",
    turnId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    streaming: false,
    attachments: [image],
  };

  it("requests the whole row's gallery and crops without signing local preview IDs", () => {
    const attachments = Object.freeze([
      image,
      { ...image, id: "second" },
      { ...image, id: "crop", name: "preview-annotation-1.png" },
      { ...image, id: "local", previewUrl: "blob:local" },
      { ...image, id: "inline", previewUrl: "data:image/png;base64,AA==" },
      { ...image, id: "provided", previewUrl: "https://preview.test/image" },
      { ...image, type: "file" as const, id: "file", mimeType: "application/pdf" },
      { ...image, type: "future", id: "unknown" },
      image,
    ]);

    expect(selectMessageImageResources(attachments)).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "second" },
      { _tag: "attachment", attachmentId: "crop" },
      { _tag: "attachment", attachmentId: "provided" },
    ]);
  });

  it("requests offscreen handoffs without signing the rest of the loaded history", () => {
    const history = {
      ...message,
      id: MessageId.make("history"),
      attachments: [{ ...image, id: "history-image" }],
    };
    const offscreen = {
      ...message,
      id: MessageId.make("offscreen"),
      attachments: [image, { ...image, id: "crop", name: "preview-annotation-1.png" }],
    };
    const empty = {
      ...message,
      id: MessageId.make("empty"),
      attachments: [{ ...image, id: "empty" }],
    };
    const assistant = {
      ...message,
      id: MessageId.make("assistant"),
      role: "assistant" as const,
      attachments: [{ ...image, id: "assistant-image" }],
    };
    expect(
      selectHandoffImageResources([history, message, offscreen, empty, assistant], {
        [message.id]: ["blob:message"],
        [offscreen.id]: ["blob:offscreen", "blob:crop"],
        [empty.id]: [],
        [assistant.id]: ["blob:unused"],
      }),
    ).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "crop" },
    ]);
  });

  it("does not scan history when no handoff is pending", () => {
    let reads = 0;
    const messages = new Proxy([message], {
      get(target, property, receiver) {
        if (property === "0") reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const empty = selectHandoffImageResources(messages, {});
    expect(reads).toBe(0);
    expect(empty).toHaveLength(0);
    expect(selectHandoffImageResources(undefined, { missing: ["blob:missing"] })).toBe(empty);
    expect(selectMessageImageResources(undefined)).toBe(empty);
  });

  it("hands signed URLs to a mounted row only after the local preview is released", () => {
    const server = createMessageAttachmentPreviewProjector();
    const handoff = createMessageAttachmentPreviewProjector();
    const row = createMessageAttachmentPreviewProjector();
    const pending = handoff(
      server(message, () => undefined),
      () => "blob:pending",
    );
    expect(selectMessageImageResources(pending.attachments)).toEqual([]);
    expect(selectHandoffImageResources([message], { [message.id]: ["blob:pending"] })).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);

    const ready = server(message, () => "https://server.test/image");
    expect(selectMessageImageResources(handoff(ready, () => "blob:pending").attachments)).toEqual(
      [],
    );
    const released = server(message, () => undefined);
    expect(selectMessageImageResources(released.attachments)).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);
    const displayed = row(released, () => "https://server.test/image");
    expect(displayed).toEqual(ready);
    expect(pending.attachments?.[0]).toMatchObject({ previewUrl: "blob:pending" });
    expect(row(released, () => "https://server.test/renewed").attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/renewed",
    });
    expect(displayed.attachments?.[0]).toMatchObject({ previewUrl: "https://server.test/image" });
    expect(row(released, () => undefined)).toBe(message);
  });
});

describe("deriveTimelineEntries", () => {
  const streamingMessage = {
    id: MessageId.make("streaming-message"),
    role: "assistant" as const,
    text: "",
    turnId: TurnId.make("streaming-turn"),
    createdAt: "2026-02-23T00:00:03.000Z",
    updatedAt: "2026-02-23T00:00:03.000Z",
    streaming: true,
  };

  it("reuses preview objects while preserving URL and attachment metadata changes", () => {
    const image = {
      type: "image" as const,
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const file = {
      type: "file" as const,
      id: "file",
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
    };
    const message = { ...streamingMessage, attachments: Object.freeze([image, file]) };
    const project = createMessageAttachmentPreviewProjector();
    const urls = new Map([[image.id, "https://first.test/image"]]);
    const first = project(message, (attachment) => urls.get(attachment.id));
    Object.freeze(first.attachments);
    expect(project(message, (attachment) => new Map(urls).get(attachment.id))).toBe(first);
    const streamed = project({ ...message, text: "Next" }, (attachment) => urls.get(attachment.id));
    expect(streamed.attachments).toBe(first.attachments);
    expect(streamed.text).toBe("Next");
    expect(first.text).toBe("");
    expect(first.attachments?.[1]).toBe(file);

    urls.set(image.id, "https://second.test/image");
    const renewed = project(message, (attachment) => urls.get(attachment.id));
    expect(renewed.attachments?.[0]).toMatchObject({ previewUrl: "https://second.test/image" });
    expect(first.attachments?.[0]).toMatchObject({ previewUrl: "https://first.test/image" });
    const renamed = project(
      { ...message, attachments: [{ ...image, name: "renamed.png" }, file] },
      (attachment) => urls.get(attachment.id),
    );
    expect(renamed.attachments?.[0]).toMatchObject({
      name: "renamed.png",
      previewUrl: "https://second.test/image",
    });
    expect(project(message, () => undefined)).toBe(message);
  });

  it("keeps pending preview handoffs stable and restores the current server URL", () => {
    const message = {
      ...streamingMessage,
      role: "user" as const,
      streaming: false,
      attachments: [
        {
          type: "image" as const,
          id: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 42,
        },
      ],
    };
    const server = createMessageAttachmentPreviewProjector();
    const handoff = createMessageAttachmentPreviewProjector();
    const first = handoff(
      server(message, () => undefined),
      () => "blob:handoff",
    );
    expect(
      handoff(
        server(message, () => undefined),
        () => "blob:handoff",
      ),
    ).toBe(first);
    const ready = server(message, () => "https://server.test/image");
    expect(handoff(ready, () => "blob:handoff").attachments?.[0]).toMatchObject({
      previewUrl: "blob:handoff",
    });
    expect(handoff(ready, () => undefined)).toBe(ready);
    expect(ready.attachments?.[0]).toMatchObject({ previewUrl: "https://server.test/image" });
    expect(first.attachments?.[0]).toMatchObject({ previewUrl: "blob:handoff" });
  });

  it("reuses ordered history without changing an earlier projection", () => {
    const history = { ...streamingMessage, id: MessageId.make("history"), streaming: false };
    const work = [
      { id: "work", createdAt: history.createdAt, label: "Ran tests", tone: "tool" as const },
    ];
    const first = deriveTimelineEntriesWithState([history, streamingMessage], [], work);
    Object.freeze(first.entries);
    for (const entry of first.entries) Object.freeze(entry);

    const firstMessage = {
      ...streamingMessage,
      text: "First",
      updatedAt: "2026-02-23T00:00:04.000Z",
    };
    const secondMessage = {
      ...streamingMessage,
      text: "Second",
      updatedAt: "2026-02-23T00:00:05.000Z",
    };
    const firstBranch = deriveTimelineEntriesWithState([history, firstMessage], [], work, first);
    const secondBranch = deriveTimelineEntriesWithState([history, secondMessage], [], work, first);

    expect(firstBranch.entries).toEqual(deriveTimelineEntries([history, firstMessage], [], work));
    expect(secondBranch.entries).toEqual(deriveTimelineEntries([history, secondMessage], [], work));
    expect(firstBranch.entries[0]).toBe(first.entries[0]);
    expect(firstBranch.entries[2]).toBe(first.entries[2]);
    expect(first.entries[1]).toMatchObject({ message: { text: "" } });
    expect(firstBranch.entries[1]).toMatchObject({ message: { text: "First" } });
  });

  it("preserves stable source ordering for ties, append, and older pages", () => {
    const plan = {
      id: "plan:thread:turn",
      turnId: streamingMessage.turnId,
      planMarkdown: "Plan",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: streamingMessage.createdAt,
      updatedAt: streamingMessage.createdAt,
    };
    const firstWork = {
      id: "work-1",
      createdAt: streamingMessage.createdAt,
      label: "Ran tests",
      tone: "tool" as const,
    };
    const first = deriveTimelineEntriesWithState([streamingMessage], [plan], [firstWork]);
    const appendedMessage = { ...streamingMessage, id: MessageId.make("appended") };
    const appendedWork = { ...firstWork, id: "work-2" };
    const messages = [streamingMessage, appendedMessage];
    const work = [firstWork, appendedWork];
    const appended = deriveTimelineEntriesWithState(messages, [plan], work, first);
    expect(appended.entries.map((entry) => entry.id)).toEqual([
      streamingMessage.id,
      appendedMessage.id,
      plan.id,
      firstWork.id,
      appendedWork.id,
    ]);
    expect(appended.entries[0]).toBe(first.entries[0]);

    const older = {
      ...streamingMessage,
      id: MessageId.make("older"),
      createdAt: "2026-02-22T00:00:00.000Z",
    };
    const prepended = deriveTimelineEntriesWithState([older, ...messages], [plan], work, appended);
    expect(prepended.entries).toEqual(deriveTimelineEntries([older, ...messages], [plan], work));
    const corrected = {
      ...streamingMessage,
      createdAt: "2026-02-24T00:00:00.000Z",
      streaming: false,
    };
    expect(
      deriveTimelineEntriesWithState([corrected, appendedMessage], [plan], work, appended).entries,
    ).toEqual(deriveTimelineEntries([corrected, appendedMessage], [plan], work));
  });

  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          turnId: null,
          updatedAt: "2026-02-23T00:00:01.000Z",
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
});

describe("deriveWorkLogEntries context window handling", () => {
  it("excludes context window updates from the work log", () => {
    const entries = deriveWorkLogEntries([
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
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Ran command");
  });

  it("keeps context compaction activities as normal work log entries", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        id: "compaction-1",
        turnId: "turn-1",
        kind: "context-compaction",
        summary: "Context compacted",
        tone: "info",
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("Context compacted");
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
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "running",
        activeTurnId: TurnId.make("turn-2"),
      }),
    ).toBe(false);
  });

  it("returns true once the session is no longer running that turn", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        status: "ready",
        activeTurnId: null,
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
          status: "running",
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
          status: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to the latest user message while a running turn is being acknowledged", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "running",
          activeTurnId: TurnId.make("turn-2"),
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("falls back to sendStartedAt once the latest turn is settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          status: "ready",
          activeTurnId: null,
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

describe("deriveWorkLogEntries quiet-timeline guarantee", () => {
  it("N concurrent subagents produce exactly N lifecycle rows, zero attributed tool rows", () => {
    const activities: OrchestrationThreadActivity[] = [];
    for (let agent = 0; agent < 5; agent += 1) {
      const taskId = `task-${agent}`;
      // Progress ticks (several per agent) + attributed tool rows.
      for (let tick = 0; tick < 4; tick += 1) {
        activities.push(
          makeActivity({
            kind: "task.progress",
            summary: `agent ${agent} tick ${tick}`,
            tone: "info",
            payload: { taskId, summary: `working ${tick}`, role: "explorer" },
            turnId: "turn-batch",
            sequence: agent * 20 + tick,
          }),
        );
        activities.push(
          makeActivity({
            kind: "tool.completed",
            summary: "Read",
            payload: { itemType: "dynamic_tool_call", agentId: taskId },
            sequence: agent * 20 + 10 + tick,
          }),
        );
      }
      activities.push(
        makeActivity({
          kind: "task.completed",
          summary: "Task completed",
          tone: "info",
          payload: {
            taskId,
            status: "completed",
            summary: `agent ${agent} done`,
            role: "explorer",
          },
          turnId: "turn-batch",
          sequence: agent * 20 + 19,
        }),
      );
    }

    const entries = deriveWorkLogEntries(activities);
    // A1 CTA design: all direct spawns in one turn collapse into ONE
    // call-to-action row carrying the batch's agent ids.
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]!.agentSpawn!.agentTaskIds).toHaveLength(5);
    expect(spawnRows[0]!.agentSpawn!.workflowId).toBeNull();
    // No agent-attributed tool rows leak into the main log.
    expect(entries.some((entry) => entry.sourceActivityKind?.startsWith("tool."))).toBe(false);
  });

  it("a workflow run and its members collapse into one CTA row keyed to the coordinator", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "coordinator",
        tone: "info",
        payload: { taskId: "wf-1", taskType: "local_workflow", workflowName: "math-check" },
        sequence: 1,
      }),
      makeActivity({
        kind: "task.progress",
        summary: "member",
        tone: "info",
        payload: { taskId: "wf-1:wf:0", status: "running", parentAgentId: "wf-1" },
        sequence: 2,
      }),
      makeActivity({
        kind: "task.completed",
        summary: "member done",
        tone: "info",
        payload: { taskId: "wf-1:wf:1", status: "completed", parentAgentId: "wf-1" },
        sequence: 3,
      }),
    ]);
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(1);
    expect(spawnRows[0]!.agentSpawn!.workflowId).toBe("wf-1");
    expect(spawnRows[0]!.agentSpawn!.agentTaskIds).toEqual(
      expect.arrayContaining(["wf-1", "wf-1:wf:0", "wf-1:wf:1"]),
    );
  });

  it("keeps unattributed tool rows (over-hiding loses the only signal)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "tool.completed",
        summary: "Bash",
        payload: { itemType: "command_execution", command: "ls" },
      }),
    ]);
    expect(entries).toHaveLength(1);
  });

  it("folds timelineBypass agent rows into one CTA (Codex children, workflow members)", () => {
    // Codex children carry their parent's spawn turn (spawnTurnId stamping),
    // which is what batches a fleet into one CTA.
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "child work",
        tone: "info",
        payload: { taskId: "child-1", timelineBypass: true },
        turnId: "turn-spawn",
      }),
      makeActivity({
        kind: "task.progress",
        summary: "child work again",
        tone: "info",
        payload: { taskId: "child-2", timelineBypass: true },
        turnId: "turn-spawn",
      }),
    ]);
    // Not suppressed outright (a Codex fleet's rows are ALL bypassed and
    // still need a CTA anchor) — but never more than the batch's single row.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agentSpawn?.agentTaskIds).toEqual(["child-1", "child-2"]);
  });

  it("timelineBypass non-agent rows (background shells) stay suppressed", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "stall",
        tone: "info",
        payload: { taskId: "sh-1", taskType: "local_bash", timelineBypass: true },
      }),
    ]);
    expect(entries).toHaveLength(0);
  });

  it("drops task.updated and tool.progress from the work log (fold input only)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.updated",
        summary: "Task running",
        tone: "info",
        payload: { taskId: "task-1", status: "running" },
      }),
      makeActivity({
        kind: "tool.progress",
        summary: "Read",
        tone: "info",
        payload: { taskId: "task-1", toolName: "Read" },
      }),
    ]);
    expect(entries).toHaveLength(0);
  });
});

describe("rerun workflows", () => {
  it("turn-less direct spawns do not collapse into one global batch", () => {
    // Rows that lost their turn id (defensive path) group per task, so two
    // unrelated turn-less spawns never merge into one immortal CTA.
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.started",
        summary: "Task started",
        payload: { taskId: "loose-1", taskType: "local_agent", role: "a" },
        sequence: 1,
      }),
      makeActivity({
        kind: "task.started",
        summary: "Task started",
        payload: { taskId: "loose-2", taskType: "local_agent", role: "b" },
        sequence: 2,
      }),
    ]);
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows).toHaveLength(2);
    expect(spawnRows.map((row) => row.agentSpawn!.agentTaskIds)).toEqual([
      ["loose-1"],
      ["loose-2"],
    ]);
  });

  it("each workflow run gets its own CTA row (distinct coordinator ids)", () => {
    const entries = deriveWorkLogEntries([
      makeActivity({
        kind: "task.progress",
        summary: "run 1",
        tone: "info",
        payload: { taskId: "wf-run1", taskType: "local_workflow", workflowName: "math-check" },
        turnId: "turn-1",
        sequence: 1,
      }),
      makeActivity({
        kind: "task.completed",
        summary: "run 1 done",
        tone: "info",
        payload: { taskId: "wf-run1", status: "completed", taskType: "local_workflow" },
        turnId: "turn-1",
        sequence: 2,
      }),
      makeActivity({
        kind: "task.progress",
        summary: "run 2",
        tone: "info",
        payload: { taskId: "wf-run2", taskType: "local_workflow", workflowName: "math-check" },
        turnId: "turn-2",
        sequence: 3,
      }),
    ]);
    const spawnRows = entries.filter((entry) => entry.agentSpawn !== undefined);
    expect(spawnRows.map((row) => row.agentSpawn!.workflowId)).toEqual(["wf-run1", "wf-run2"]);
    expect(spawnRows.map((row) => row.turnId)).toEqual(["turn-1", "turn-2"]);
  });
});

describe("session activity performance", () => {
  it("reuses entries for unchanged activities", () => {
    const activities = ["status", "diff", "log"].map((command, index) =>
      makeActivity({
        id: `stable-tool-${index}`,
        kind: "tool.completed",
        sequence: index,
        payload: {
          itemType: "command_execution",
          data: { toolCallId: `stable-tool-${index}`, item: { command: ["git", command] } },
        },
      }),
    );

    const initialEntries = deriveWorkLogEntries(activities.slice(0, 2));
    const appendedEntries = deriveWorkLogEntries(activities);
    expect(appendedEntries[0]).toBe(initialEntries[0]);
    expect(appendedEntries[1]).toBe(initialEntries[1]);
  });

  it("reuses entries when appending to 20,000 ordered tool activities", () => {
    const activities = Array.from({ length: 20_000 }, (_, index) =>
      makeActivity({
        id: `benchmark-tool-${index}`,
        createdAt: new Date(1_700_000_000_000 + index).toISOString(),
        kind: "tool.completed",
        summary: "Ran command",
        sequence: index,
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: {
            toolCallId: `benchmark-tool-${index}`,
            item: { command: ["git", "status"] },
          },
        },
      }),
    );
    const initialEntries = deriveWorkLogEntries(activities);
    expect(initialEntries).toHaveLength(20_000);
    const updatedActivities = [
      ...activities,
      makeActivity({
        id: "benchmark-tool-appended",
        createdAt: new Date(1_700_000_000_000 + activities.length).toISOString(),
        kind: "tool.completed",
        summary: "Ran command",
        sequence: activities.length,
        payload: {
          itemType: "command_execution",
          title: "Ran command",
          data: { toolCallId: "benchmark-tool-appended", item: { command: ["git", "diff"] } },
        },
      }),
    ];

    const updatedEntries = deriveWorkLogEntries(updatedActivities);
    expect(updatedEntries).toHaveLength(20_001);
    expect(initialEntries.every((entry, index) => updatedEntries[index] === entry)).toBe(true);
    expect(updatedEntries.at(-1)).toMatchObject({
      id: "benchmark-tool-appended",
      command: "git diff",
      toolLifecycleStatus: "completed",
    });
  });
});
