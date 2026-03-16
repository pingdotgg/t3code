import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveActiveWorkStartedAt,
  deriveAgentTeamsState,
  deriveActivePlanState,
  PROVIDER_OPTIONS,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  findLatestProposedPlan,
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
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload,
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
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
          },
        ],
      },
    ]);
  });
});

describe("deriveAgentTeamsState", () => {
  it("builds team runs from teammate activities without duplicating the lead", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "tool-team-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.started",
        summary: "Subagent task started",
        tone: "tool",
        payload: {
          itemType: "collab_agent_tool_call",
          toolUseId: "tool-task-1",
          data: {
            input: {
              name: "db-reviewer",
              team_name: "release-squad",
              subagent_type: "code-reviewer",
            },
          },
        },
      }),
      makeActivity({
        id: "team-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "teammate.started",
        summary: "db-reviewer started",
        tone: "info",
        payload: {
          agentId: "agent-db-reviewer",
          taskId: "task-1",
          toolUseId: "tool-task-1",
        },
      }),
      makeActivity({
        id: "team-progress",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "teammate.progress",
        summary: "db-reviewer update",
        tone: "info",
        payload: {
          agentId: "agent-db-reviewer",
          taskId: "task-1",
          toolUseId: "tool-task-1",
          summary: "Checking rollback safety.",
        },
      }),
      makeActivity({
        id: "team-completed",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "teammate.completed",
        summary: "db-reviewer completed",
        tone: "info",
        payload: {
          agentId: "agent-db-reviewer",
          taskId: "task-1",
          toolUseId: "tool-task-1",
          detail: "Migration review finished.",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);

    expect(state.leadLabel).toBe("Lead");
    expect(state.hasTeamActivity).toBe(true);
    expect(state.activeRunId).toBeNull();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      label: "release-squad",
      status: "completed",
      teamName: "release-squad",
      activeCount: 0,
      pendingApprovalCount: 0,
    });
    expect(state.runs[0]?.members[0]).toMatchObject({
      label: "db-reviewer",
      status: "completed",
      agentId: "agent-db-reviewer",
      agentType: "code-reviewer",
      teamName: "release-squad",
      taskId: "task-1",
      toolUseId: "tool-task-1",
      teammateName: "db-reviewer",
    });
    expect(state.runs[0]?.members[0]?.activities.map((activity) => activity.kind)).toEqual([
      "tool.started",
      "teammate.started",
      "teammate.progress",
      "teammate.completed",
    ]);
  });

  it("uses stable agent ids so stop events replace running state instead of creating duplicates", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "teammate.started",
        summary: "reviewer started",
        tone: "info",
        payload: {
          agentId: "agent-reviewer",
          agentName: "reviewer",
          teamName: "triage",
        },
      }),
      makeActivity({
        id: "agent-idle",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "teammate.idle",
        summary: "reviewer idle",
        tone: "info",
        payload: {
          agentId: "agent-reviewer",
          agentName: "reviewer",
          teamName: "triage",
        },
      }),
      makeActivity({
        id: "agent-stopped",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "teammate.stopped",
        summary: "reviewer stopped",
        tone: "info",
        payload: {
          agentId: "agent-reviewer",
          agentName: "reviewer",
          teamName: "triage",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.members).toHaveLength(1);
    expect(state.runs[0]?.members[0]?.status).toBe("stopped");
  });

  it("does not let later placeholder updates overwrite a known teammate name", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "named-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "teammate.started",
        summary: "db-reviewer started",
        tone: "info",
        payload: {
          agentId: "agent-db-reviewer",
          teammateName: "db-reviewer",
          teamName: "release-squad",
        },
      }),
      makeActivity({
        id: "generic-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "teammate.progress",
        summary: "Teammate update",
        tone: "info",
        payload: {
          agentId: "agent-db-reviewer",
          agentType: "code-reviewer",
          teamName: "release-squad",
          summary: "Still reviewing",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs[0]?.members[0]).toMatchObject({
      label: "db-reviewer",
      teammateName: "db-reviewer",
      agentType: "code-reviewer",
    });
  });

  it("surfaces teammate activity even when Claude only provides free-text detail", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "team-fallback-start",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "teammate.started",
        summary: "Teammate started",
        tone: "info",
        payload: {
          detail: "researcher: You are a researcher in a small test team.",
        },
      }),
      makeActivity({
        id: "team-fallback-stop",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "teammate.stopped",
        summary: "researcher stopped",
        tone: "info",
        payload: {
          detail: "researcher: Finished the small test.",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.hasTeamActivity).toBe(true);
    expect(state.runs[0]?.members[0]).toMatchObject({
      label: "researcher",
      status: "stopped",
    });
  });

  it("shows team activity for sparse collab agent tool calls before teammate metadata arrives", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "team-create",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "File change - TeamCreate: {}",
        tone: "tool",
        payload: {
          itemType: "file_change",
          detail: "TeamCreate: {}",
        },
      }),
      makeActivity({
        id: "subagent-task",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Subagent task - Agent: {}",
        tone: "tool",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Agent: {}",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.hasTeamActivity).toBe(true);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]).toMatchObject({
      label: "Agent",
      status: "running",
      activeCount: 1,
    });
    expect(state.runs[0]?.members[0]).toMatchObject({
      label: "Agent",
      status: "running",
    });
  });

  it("groups unnamed tool activity and later named teammates into one run", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "agent-tool-1",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "Subagent task - Agent: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Agent: {}",
        },
      }),
      makeActivity({
        id: "agent-tool-2",
        createdAt: "2026-02-23T00:00:01.500Z",
        kind: "tool.updated",
        summary: "Subagent task - Agent: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Agent: {}",
        },
      }),
      makeActivity({
        id: "researcher-start",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "teammate.started",
        summary: "Teammate started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          detail: "researcher: You are a researcher in a small test team.",
        },
      }),
      makeActivity({
        id: "executor-start",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "teammate.started",
        summary: "Teammate started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          detail: "executor: You are an executor in a small test team.",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.members.map((member) => member.label).toSorted()).toEqual([
      "executor",
      "researcher",
    ]);
  });

  it("does not treat SendMessage tool calls as extra teammates", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "team-create",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "tool.updated",
        summary: "File change - TeamCreate: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "file_change",
          detail: "TeamCreate: {}",
        },
      }),
      makeActivity({
        id: "subagent-task-1",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.updated",
        summary: "Subagent task - Agent: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Agent: {}",
        },
      }),
      makeActivity({
        id: "subagent-task-2",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Subagent task - Agent: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Agent: {}",
        },
      }),
      makeActivity({
        id: "send-message-1",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.updated",
        summary: "Tool call - SendMessage: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "dynamic_tool_call",
          data: {
            input: {
              name: "researcher",
              team_name: "test-team",
            },
          },
        },
      }),
      makeActivity({
        id: "send-message-2",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Tool call - SendMessage: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "dynamic_tool_call",
          data: {
            input: {
              name: "tester",
              team_name: "test-team",
            },
          },
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);

    expect(state.hasTeamActivity).toBe(true);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.members).toHaveLength(2);
    expect(state.runs[0]?.members.map((member) => member.label)).toEqual(["Agent", "Agent"]);
  });

  it("hydrates Claude artifact roster names without counting dynamic teammate tools as members", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "team-run-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "team.run.started",
        summary: "test-team team started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          runId: "team-run:turn-turn-team:1",
          teamKey: "turn-turn-team",
          startedAt: "2026-02-23T00:00:01.000Z",
          teamName: "test-team",
        },
      }),
      makeActivity({
        id: "team-run-updated",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "team.run.updated",
        summary: "test-team team updated",
        tone: "info",
        turnId: "turn-team",
        payload: {
          runId: "team-run:turn-turn-team:1",
          teamKey: "turn-turn-team",
          startedAt: "2026-02-23T00:00:01.000Z",
          teamName: "test-team",
          statusSource: "claude-files",
          members: [
            {
              agentId: "researcher@test-team",
              teammateName: "researcher",
              agentColor: "blue",
              agentType: "general-purpose",
            },
            {
              agentId: "tester@test-team",
              teammateName: "tester",
              agentColor: "green",
              agentType: "general-purpose",
            },
          ],
          tasks: [
            {
              taskId: "1",
              teammateName: "researcher",
              status: "running",
            },
            {
              taskId: "2",
              teammateName: "tester",
              status: "running",
            },
          ],
        },
      }),
      makeActivity({
        id: "subagent-task-1",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.updated",
        summary: "Subagent task - Agent: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          runId: "team-run:turn-turn-team:1",
          teamKey: "turn-turn-team",
          toolUseId: "tool-task-1",
          detail: "Agent: {}",
        },
      }),
      makeActivity({
        id: "subagent-task-2",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "tool.updated",
        summary: "Subagent task - Agent: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          runId: "team-run:turn-turn-team:1",
          teamKey: "turn-turn-team",
          toolUseId: "tool-task-2",
          detail: "Agent: {}",
        },
      }),
      makeActivity({
        id: "send-message-1",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.updated",
        summary: "Tool call - SendMessage: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "dynamic_tool_call",
          runId: "team-run:turn-turn-team:1",
          teamKey: "turn-turn-team",
          teamName: "test-team",
          toolUseId: "tool-send-1",
        },
      }),
      makeActivity({
        id: "send-message-2",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "tool.updated",
        summary: "Tool call - SendMessage: {}",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "dynamic_tool_call",
          runId: "team-run:turn-turn-team:1",
          teamKey: "turn-turn-team",
          teamName: "test-team",
          toolUseId: "tool-send-2",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);

    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.members).toHaveLength(2);
    expect(state.runs[0]?.members.map((member) => member.label).toSorted()).toEqual([
      "researcher",
      "tester",
    ]);
    expect(state.runs[0]?.members.map((member) => member.agentColor).toSorted()).toEqual([
      "blue",
      "green",
    ]);
  });
  it("does not count TeamCreate, TeamDelete, or SendMessage tool calls as team members", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "team-run-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "team.run.started",
        summary: "my-team team started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
          startedAt: "2026-02-23T00:00:01.000Z",
          teamName: "my-team",
        },
      }),
      makeActivity({
        id: "team-create-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "tool.started",
        summary: "Subagent task started",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "TeamCreate: {}",
          toolUseId: "tool-tc-1",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
      makeActivity({
        id: "team-create-done",
        createdAt: "2026-02-23T00:00:03.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "TeamCreate: my-team",
          toolUseId: "tool-tc-1",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
          teamName: "my-team",
        },
      }),
      makeActivity({
        id: "teammate-explorer-started",
        createdAt: "2026-02-23T00:00:04.000Z",
        kind: "teammate.started",
        summary: "explorer started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-1",
          taskType: "in_process_teammate",
          teammateName: "explorer",
          agentName: "explorer",
          agentColor: "blue",
          agentType: "Explore",
          teamName: "my-team",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
          toolUseId: "tool-agent-1",
        },
      }),
      makeActivity({
        id: "teammate-analyst-started",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "teammate.started",
        summary: "analyst started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-2",
          taskType: "in_process_teammate",
          teammateName: "analyst",
          agentName: "analyst",
          agentColor: "green",
          agentType: "general-purpose",
          teamName: "my-team",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
          toolUseId: "tool-agent-2",
        },
      }),
      makeActivity({
        id: "sendmessage-started",
        createdAt: "2026-02-23T00:00:06.000Z",
        kind: "tool.started",
        summary: "Subagent task started",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "SendMessage: {}",
          toolUseId: "tool-send-1",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
      makeActivity({
        id: "sendmessage-done",
        createdAt: "2026-02-23T00:00:07.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "SendMessage to explorer: Research NextJS vs Vite",
          toolUseId: "tool-send-1",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    // Should only have 2 real members (explorer + analyst), NOT TeamCreate or SendMessage
    expect(state.runs[0]?.members).toHaveLength(2);
    const labels = state.runs[0]!.members.map((m) => m.label).toSorted();
    expect(labels).toEqual(["analyst", "explorer"]);
  });

  it("marks run as ended when TeamDelete tool.completed fires", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "team-run-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "team.run.started",
        summary: "my-team started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
          startedAt: "2026-02-23T00:00:01.000Z",
        },
      }),
      makeActivity({
        id: "teammate-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "teammate.started",
        summary: "explorer started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-1",
          teammateName: "explorer",
          teamName: "my-team",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
      makeActivity({
        id: "team-delete-completed",
        createdAt: "2026-02-23T00:00:10.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "TeamDelete: my-team",
          toolUseId: "tool-delete-1",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.endedAt).toBeDefined();
    expect(state.runs[0]?.activeCount).toBe(0);
    expect(state.runs[0]?.status).toBe("completed");
  });

  it("tracks task.progress for known teammate taskIds and updates member status to running", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "team-run-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "team.run.started",
        summary: "team started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
          startedAt: "2026-02-23T00:00:01.000Z",
        },
      }),
      makeActivity({
        id: "teammate-started",
        createdAt: "2026-02-23T00:00:02.000Z",
        kind: "teammate.started",
        summary: "explorer started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-explorer-1",
          taskType: "in_process_teammate",
          teammateName: "explorer",
          teamName: "my-team",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
      makeActivity({
        id: "task-progress",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "task.progress",
        summary: "Reasoning update",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-explorer-1",
          summary: "Searching for test files...",
          lastToolName: "Grep",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    const explorer = state.runs[0]?.members.find((m) => m.label === "explorer");
    expect(explorer).toBeDefined();
    expect(explorer?.status).toBe("running");
    expect(explorer?.activities.length).toBeGreaterThanOrEqual(2);
  });

  it("marks member completed when task.completed arrives for a teammate taskId", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "teammate-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "teammate.started",
        summary: "explorer started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-e1",
          taskType: "in_process_teammate",
          teammateName: "explorer",
          teamName: "my-team",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
      makeActivity({
        id: "task-completed",
        createdAt: "2026-02-23T00:00:10.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-e1",
          status: "completed",
          summary: "Search complete. Found 3 test files.",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    const explorer = state.runs[0]?.members.find((m) => m.label === "explorer");
    expect(explorer).toBeDefined();
    expect(explorer?.status).toBe("completed");
  });

  it("associates SendMessage tool.completed with the target teammate's activity feed", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "teammate-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        kind: "teammate.started",
        summary: "explorer started",
        tone: "info",
        turnId: "turn-team",
        payload: {
          taskId: "task-e1",
          teammateName: "explorer",
          teamName: "my-team",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
          toolUseId: "tool-agent-1",
        },
      }),
      makeActivity({
        id: "sendmsg-done",
        createdAt: "2026-02-23T00:00:05.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-team",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "SendMessage to explorer: Research NextJS vs Vite",
          toolUseId: "tool-send-1",
          runId: "team-run:turn-team:1",
          teamKey: "turn-team",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    // SendMessage should NOT create a separate member
    expect(state.runs[0]?.members).toHaveLength(1);
    expect(state.runs[0]?.members[0]?.label).toBe("explorer");
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

    expect(deriveActivePlanState(activities, TurnId.makeUnsafe("turn-1"))).toEqual({
      createdAt: "2026-02-23T00:00:02.000Z",
      turnId: "turn-1",
      explanation: "Refined plan",
      steps: [{ step: "Implement Codex user input", status: "inProgress" }],
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
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Older",
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:01.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-1",
            turnId: TurnId.makeUnsafe("turn-1"),
            planMarkdown: "# Latest",
            createdAt: "2026-02-23T00:00:01.000Z",
            updatedAt: "2026-02-23T00:00:02.000Z",
          },
          {
            id: "plan:thread-1:turn:turn-2",
            turnId: TurnId.makeUnsafe("turn-2"),
            planMarkdown: "# Different turn",
            createdAt: "2026-02-23T00:00:03.000Z",
            updatedAt: "2026-02-23T00:00:03.000Z",
          },
        ],
        TurnId.makeUnsafe("turn-1"),
      ),
    ).toEqual({
      id: "plan:thread-1:turn:turn-1",
      turnId: "turn-1",
      planMarkdown: "# Latest",
      createdAt: "2026-02-23T00:00:01.000Z",
      updatedAt: "2026-02-23T00:00:02.000Z",
    });
  });

  it("falls back to the most recently updated proposed plan", () => {
    const latestPlan = findLatestProposedPlan(
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# First",
          createdAt: "2026-02-23T00:00:01.000Z",
          updatedAt: "2026-02-23T00:00:01.000Z",
        },
        {
          id: "plan:thread-1:turn:turn-2",
          turnId: TurnId.makeUnsafe("turn-2"),
          planMarkdown: "# Latest",
          createdAt: "2026-02-23T00:00:02.000Z",
          updatedAt: "2026-02-23T00:00:03.000Z",
        },
      ],
      null,
    );

    expect(latestPlan?.planMarkdown).toBe("# Latest");
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

  it("omits task start and completion lifecycle entries", () => {
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

    const entries = deriveWorkLogEntries(activities, undefined);
    expect(entries.map((entry) => entry.id)).toEqual(["task-progress"]);
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

    const entries = deriveWorkLogEntries(activities, TurnId.makeUnsafe("turn-2"));
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
});

describe("deriveTimelineEntries", () => {
  it("includes proposed plans alongside messages and work entries in chronological order", () => {
    const entries = deriveTimelineEntries(
      [
        {
          id: MessageId.makeUnsafe("message-1"),
          role: "assistant",
          text: "hello",
          createdAt: "2026-02-23T00:00:01.000Z",
          streaming: false,
        },
      ],
      [
        {
          id: "plan:thread-1:turn:turn-1",
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "# Ship it",
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
      [],
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["message", "proposed-plan", "work"]);
    expect(entries[1]).toMatchObject({
      kind: "proposed-plan",
      proposedPlan: {
        planMarkdown: "# Ship it",
      },
    });
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

    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-1"))).toBe(true);
    expect(hasToolActivityForTurn(activities, TurnId.makeUnsafe("turn-2"))).toBe(false);
  });
});

describe("isLatestTurnSettled", () => {
  const latestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("returns false while the same turn is still active in a running session", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toBe(false);
  });

  it("returns false while any turn is running to avoid stale latest-turn banners", () => {
    expect(
      isLatestTurnSettled(latestTurn, {
        orchestrationStatus: "running",
        activeTurnId: TurnId.makeUnsafe("turn-2"),
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
          turnId: TurnId.makeUnsafe("turn-1"),
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
    turnId: TurnId.makeUnsafe("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  it("prefers the in-flight turn start when the latest turn is not settled", () => {
    expect(
      deriveActiveWorkStartedAt(
        latestTurn,
        {
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
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
          turnId: TurnId.makeUnsafe("turn-1"),
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });
});

describe("PROVIDER_OPTIONS", () => {
  it("keeps Claude Code selectable while Cursor remains a placeholder", () => {
    const claude = PROVIDER_OPTIONS.find((option) => option.value === "claudeCode");
    const cursor = PROVIDER_OPTIONS.find((option) => option.value === "cursor");
    expect(PROVIDER_OPTIONS).toEqual([
      { value: "codex", label: "Codex", available: true },
      { value: "claudeCode", label: "Claude Code", available: true },
      { value: "cursor", label: "Cursor", available: false },
    ]);
    expect(claude).toEqual({
      value: "claudeCode",
      label: "Claude Code",
      available: true,
    });
    expect(cursor).toEqual({
      value: "cursor",
      label: "Cursor",
      available: false,
    });
  });
});
