/**
 * Comprehensive integration tests for Claude Agent Teams state derivation.
 *
 * These tests simulate real activity streams as observed from the SQLite database
 * during actual team sessions with Claude Code. They validate:
 *
 * 1. Team lifecycle: creation → running → shutdown → ended
 * 2. Agent status transitions: running → idle → completed
 * 3. Lead coordination tools (TeamCreate, SendMessage, etc.) are NOT counted as members
 * 4. TeamDelete triggers run shutdown
 * 5. task.progress/task.completed for teammate taskIds update member status
 * 6. Background subagent events are properly tracked
 * 7. Timeline team-run entries include correct metadata
 */

import { describe, expect, it } from "vitest";
import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveAgentTeamsState, deriveTimelineEntries } from "./session-logic";

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

/**
 * Builds a realistic activity stream that matches what we see in the SQLite database
 * when a user creates a team with two agents (explorer + analyst), sends messages,
 * and then deletes the team.
 */
function buildFullTeamLifecycleActivities(): OrchestrationThreadActivity[] {
  const turnId = "turn-lifecycle-test";
  const teamKey = `turn-${turnId}`;
  const runId = `team-run:${teamKey}:1`;
  const teamName = "test-team-lifecycle";
  const explorerToolUseId = "toolu_explorer_001";
  const analystToolUseId = "toolu_analyst_001";

  return [
    // 1. team.run.started
    makeActivity({
      id: "run-started",
      createdAt: "2026-03-16T12:00:01.000Z",
      kind: "team.run.started",
      summary: `${teamName} team started`,
      tone: "info",
      turnId,
      payload: { runId, teamKey, startedAt: "2026-03-16T12:00:01.000Z", statusSource: "runtime" },
    }),

    // 2. TeamCreate tool.started (should NOT create a member)
    makeActivity({
      id: "tc-started",
      createdAt: "2026-03-16T12:00:02.000Z",
      kind: "tool.started",
      summary: "Subagent task started",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: "TeamCreate: {}",
        toolUseId: "toolu_tc_001",
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),

    // 3. TeamCreate tool.completed with team info
    makeActivity({
      id: "tc-completed",
      createdAt: "2026-03-16T12:00:03.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: `TeamCreate: ${teamName}`,
        toolUseId: "toolu_tc_001",
        runId,
        teamKey,
        statusSource: "runtime",
        teamName,
      },
    }),

    // 4. team.run.updated with member roster
    makeActivity({
      id: "run-updated-roster",
      createdAt: "2026-03-16T12:00:04.000Z",
      kind: "team.run.updated",
      summary: `${teamName} team updated`,
      tone: "info",
      turnId,
      payload: {
        runId,
        teamKey,
        startedAt: "2026-03-16T12:00:01.000Z",
        statusSource: "claude-files",
        teamName,
        members: [
          {
            agentId: `explorer@${teamName}`,
            teammateName: "explorer",
            agentColor: "blue",
            agentType: "Explore",
          },
          {
            agentId: `analyst@${teamName}`,
            teammateName: "analyst",
            agentColor: "green",
            agentType: "general-purpose",
          },
        ],
      },
    }),

    // 5. Agent tool started for explorer (collab_agent_tool_call)
    makeActivity({
      id: "agent-explorer-started",
      createdAt: "2026-03-16T12:00:05.000Z",
      kind: "tool.started",
      summary: "Subagent task started",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: "Agent: {}",
        toolUseId: explorerToolUseId,
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),

    // 6. Agent tool completed for explorer (now with full input from input_json_delta)
    makeActivity({
      id: "agent-explorer-completed",
      createdAt: "2026-03-16T12:00:06.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: 'Agent: {"description":"Search codebase"}',
        toolUseId: explorerToolUseId,
        runId,
        teamKey,
        statusSource: "runtime",
        agentName: "explorer",
        agentColor: "blue",
        agentType: "Explore",
        teamName,
        teammateName: "explorer",
      },
    }),

    // 7. teammate.started for explorer (from task.started with in_process_teammate)
    makeActivity({
      id: "teammate-explorer-started",
      createdAt: "2026-03-16T12:00:07.000Z",
      kind: "teammate.started",
      summary: "explorer started",
      tone: "info",
      turnId,
      payload: {
        taskId: "task-explorer-1",
        taskType: "in_process_teammate",
        detail: "explorer: Search the codebase for test files...",
        teammateName: "explorer",
        toolUseId: explorerToolUseId,
        teamName,
        agentName: "explorer",
        agentColor: "blue",
        agentType: "Explore",
        runId,
        teamKey,
      },
    }),

    // 8. Agent tool for analyst
    makeActivity({
      id: "agent-analyst-started",
      createdAt: "2026-03-16T12:00:08.000Z",
      kind: "tool.started",
      summary: "Subagent task started",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: "Agent: {}",
        toolUseId: analystToolUseId,
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),
    makeActivity({
      id: "agent-analyst-completed",
      createdAt: "2026-03-16T12:00:09.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: 'Agent: {"description":"Analyze findings"}',
        toolUseId: analystToolUseId,
        runId,
        teamKey,
        statusSource: "runtime",
        agentName: "analyst",
        agentColor: "green",
        agentType: "general-purpose",
        teamName,
        teammateName: "analyst",
      },
    }),

    // 9. teammate.started for analyst
    makeActivity({
      id: "teammate-analyst-started",
      createdAt: "2026-03-16T12:00:10.000Z",
      kind: "teammate.started",
      summary: "analyst started",
      tone: "info",
      turnId,
      payload: {
        taskId: "task-analyst-1",
        taskType: "in_process_teammate",
        detail: "analyst: Analyze the explorer's findings...",
        teammateName: "analyst",
        toolUseId: analystToolUseId,
        teamName,
        agentName: "analyst",
        agentColor: "green",
        agentType: "general-purpose",
        runId,
        teamKey,
      },
    }),

    // 10. SendMessage from lead to explorer (should NOT create a member)
    makeActivity({
      id: "sendmsg-explorer-started",
      createdAt: "2026-03-16T12:01:01.000Z",
      kind: "tool.started",
      summary: "Subagent task started",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: "SendMessage: {}",
        toolUseId: "toolu_send_001",
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),
    makeActivity({
      id: "sendmsg-explorer-completed",
      createdAt: "2026-03-16T12:01:02.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: "SendMessage to explorer: Research NextJS vs Vite",
        toolUseId: "toolu_send_001",
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),

    // 11. task.progress from explorer (has taskId but no explicit team metadata)
    makeActivity({
      id: "explorer-progress-1",
      createdAt: "2026-03-16T12:02:01.000Z",
      kind: "task.progress",
      summary: "Reasoning update",
      tone: "info",
      turnId,
      payload: {
        taskId: "task-explorer-1",
        summary: "Searching for test files with pattern *.test.*",
        lastToolName: "Grep",
      },
    }),

    // 12. task.completed for explorer
    makeActivity({
      id: "explorer-task-completed",
      createdAt: "2026-03-16T12:03:01.000Z",
      kind: "task.completed",
      summary: "Task completed",
      tone: "info",
      turnId,
      payload: {
        taskId: "task-explorer-1",
        status: "completed",
        summary: "Found 15 test files across 3 directories.",
      },
    }),

    // 13. SendMessage from lead to analyst (forwarding results)
    makeActivity({
      id: "sendmsg-analyst-completed",
      createdAt: "2026-03-16T12:03:30.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: "SendMessage to analyst: Based on explorer findings, create a summary report.",
        toolUseId: "toolu_send_002",
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),

    // 14. task.completed for analyst
    makeActivity({
      id: "analyst-task-completed",
      createdAt: "2026-03-16T12:04:01.000Z",
      kind: "task.completed",
      summary: "Task completed",
      tone: "info",
      turnId,
      payload: {
        taskId: "task-analyst-1",
        status: "completed",
        summary: "Summary report generated.",
      },
    }),

    // 15. TeamDelete (should end the run)
    makeActivity({
      id: "td-started",
      createdAt: "2026-03-16T12:05:01.000Z",
      kind: "tool.started",
      summary: "Subagent task started",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: "TeamDelete: {}",
        toolUseId: "toolu_td_001",
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),
    makeActivity({
      id: "td-completed",
      createdAt: "2026-03-16T12:05:02.000Z",
      kind: "tool.completed",
      summary: "Subagent task",
      tone: "tool",
      turnId,
      payload: {
        itemType: "collab_agent_tool_call",
        detail: `TeamDelete: ${teamName}`,
        toolUseId: "toolu_td_001",
        runId,
        teamKey,
        statusSource: "runtime",
      },
    }),
  ];
}

describe("Agent Teams: Full lifecycle integration", () => {
  const activities = buildFullTeamLifecycleActivities();

  it("identifies exactly 2 team members (explorer + analyst), not lead tools", () => {
    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.members).toHaveLength(2);
    const labels = state.runs[0]!.members.map((m) => m.label).toSorted();
    expect(labels).toEqual(["analyst", "explorer"]);
  });

  it("does not create members for TeamCreate, TeamDelete, or SendMessage", () => {
    const state = deriveAgentTeamsState(activities);
    const memberLabels = state.runs[0]!.members.map((m) => m.label);
    expect(memberLabels).not.toContain("TeamCreate");
    expect(memberLabels).not.toContain("TeamDelete");
    expect(memberLabels).not.toContain("SendMessage");
    expect(memberLabels).not.toContain("SendMessage to explorer");
    expect(memberLabels).not.toContain("SendMessage to analyst");
  });

  it("preserves agent colors from Claude metadata", () => {
    const state = deriveAgentTeamsState(activities);
    const explorer = state.runs[0]!.members.find((m) => m.label === "explorer");
    const analyst = state.runs[0]!.members.find((m) => m.label === "analyst");
    expect(explorer?.agentColor).toBe("blue");
    expect(analyst?.agentColor).toBe("green");
  });

  it("preserves agent types from Claude metadata", () => {
    const state = deriveAgentTeamsState(activities);
    const explorer = state.runs[0]!.members.find((m) => m.label === "explorer");
    const analyst = state.runs[0]!.members.find((m) => m.label === "analyst");
    expect(explorer?.agentType).toBe("Explore");
    expect(analyst?.agentType).toBe("general-purpose");
  });

  it("tracks explorer status through running → completed", () => {
    // Before task.completed
    const midActivities = activities.slice(0, 12); // Through task.progress
    const midState = deriveAgentTeamsState(midActivities);
    const explorerMid = midState.runs[0]!.members.find((m) => m.label === "explorer");
    expect(explorerMid?.status).toBe("running");

    // After task.completed
    const state = deriveAgentTeamsState(activities);
    const explorer = state.runs[0]!.members.find((m) => m.label === "explorer");
    expect(explorer?.status).toBe("completed");
  });

  it("marks the run as ended after TeamDelete", () => {
    const state = deriveAgentTeamsState(activities);
    expect(state.runs[0]?.endedAt).toBeDefined();
    expect(state.runs[0]?.activeCount).toBe(0);
    expect(state.activeRunId).toBeNull();
  });

  it("run status is completed when both members complete and team is deleted", () => {
    const state = deriveAgentTeamsState(activities);
    expect(state.runs[0]?.status).toBe("completed");
  });

  it("routes SendMessage activity to target member's feed", () => {
    const state = deriveAgentTeamsState(activities);
    const explorer = state.runs[0]!.members.find((m) => m.label === "explorer");
    const sendMsgActivity = explorer?.activities.find((a) =>
      a.detail?.includes("SendMessage to explorer"),
    );
    expect(sendMsgActivity).toBeDefined();
  });

  it("includes task.progress activities in the member's feed", () => {
    const state = deriveAgentTeamsState(activities);
    const explorer = state.runs[0]!.members.find((m) => m.label === "explorer");
    const progressActivity = explorer?.activities.find(
      (a) => a.detail === "Searching for test files with pattern *.test.*",
    );
    expect(progressActivity).toBeDefined();
  });
});

describe("Agent Teams: Background subagent tracking", () => {
  it("tracks subagent tool calls as team members when they have agent metadata", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "sub-tool-started",
        createdAt: "2026-03-16T12:00:01.000Z",
        kind: "tool.started",
        summary: "Subagent task started",
        tone: "tool",
        turnId: "turn-sub",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: 'Agent: {"description":"Explore the codebase"}',
          toolUseId: "toolu_sub_001",
        },
      }),
      makeActivity({
        id: "sub-tool-completed",
        createdAt: "2026-03-16T12:00:10.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-sub",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: 'Agent: {"description":"Explore the codebase"}',
          toolUseId: "toolu_sub_001",
          agentName: "codebase-explorer",
          agentType: "Explore",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.hasTeamActivity).toBe(true);
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.members).toHaveLength(1);
    expect(state.runs[0]?.members[0]?.label).toBe("codebase-explorer");
    expect(state.runs[0]?.members[0]?.agentType).toBe("Explore");
  });

  it("does not create phantom members for TaskCreate/TaskUpdate tool calls", () => {
    const activities: OrchestrationThreadActivity[] = [
      makeActivity({
        id: "run-started",
        createdAt: "2026-03-16T12:00:01.000Z",
        kind: "team.run.started",
        summary: "team started",
        tone: "info",
        turnId: "turn-task-tools",
        payload: { runId: "run-1", teamKey: "key-1", startedAt: "2026-03-16T12:00:01.000Z" },
      }),
      makeActivity({
        id: "teammate-started",
        createdAt: "2026-03-16T12:00:02.000Z",
        kind: "teammate.started",
        summary: "worker started",
        tone: "info",
        turnId: "turn-task-tools",
        payload: {
          taskId: "task-w1",
          teammateName: "worker",
          teamName: "my-team",
          runId: "run-1",
          teamKey: "key-1",
        },
      }),
      // TaskCreate tool call — should NOT create a member
      makeActivity({
        id: "task-create-tool",
        createdAt: "2026-03-16T12:00:03.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-task-tools",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "TaskCreate: Build feature X",
          toolUseId: "toolu_taskcreate_1",
          runId: "run-1",
          teamKey: "key-1",
        },
      }),
      // TaskUpdate tool call — should NOT create a member
      makeActivity({
        id: "task-update-tool",
        createdAt: "2026-03-16T12:00:04.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-task-tools",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "TaskUpdate: Mark task as done",
          toolUseId: "toolu_taskupdate_1",
          runId: "run-1",
          teamKey: "key-1",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs[0]?.members).toHaveLength(1);
    expect(state.runs[0]?.members[0]?.label).toBe("worker");
  });
});

describe("Agent Teams: Timeline entries", () => {
  it("includes team-run entries with memberCount and summary", () => {
    const activities = buildFullTeamLifecycleActivities();
    const entries = deriveTimelineEntries([], [], [], activities);
    const teamRunEntries = entries.filter((e) => e.kind === "team-run");
    expect(teamRunEntries.length).toBeGreaterThanOrEqual(1);
    const entry = teamRunEntries[0];
    if (entry?.kind === "team-run") {
      expect(entry.run.label).toBeDefined();
      expect(entry.run.startedAt).toBeDefined();
      // Note: endedAt in timeline comes from extractAgentTeamRunSnapshots which only
      // tracks team.run.ended events, not TeamDelete. The full state derivation
      // (deriveAgentTeamsState) handles TeamDelete→endedAt separately.
      expect(entry.run.memberCount).toBeGreaterThanOrEqual(0);
      expect(entry.run.summary).toBeDefined();
    }
  });
});

describe("Agent Teams: Multiple runs in one thread", () => {
  it("handles team creation, deletion, and re-creation as separate runs", () => {
    const activities: OrchestrationThreadActivity[] = [
      // Run 1
      makeActivity({
        id: "run1-started",
        createdAt: "2026-03-16T12:00:01.000Z",
        kind: "team.run.started",
        summary: "team-1 started",
        tone: "info",
        turnId: "turn-1",
        payload: { runId: "run-1", teamKey: "key-1", startedAt: "2026-03-16T12:00:01.000Z" },
      }),
      makeActivity({
        id: "run1-member",
        createdAt: "2026-03-16T12:00:02.000Z",
        kind: "teammate.started",
        summary: "agent-a started",
        tone: "info",
        turnId: "turn-1",
        payload: { taskId: "t1", teammateName: "agent-a", runId: "run-1", teamKey: "key-1" },
      }),
      // TeamDelete ends run 1
      makeActivity({
        id: "run1-delete",
        createdAt: "2026-03-16T12:01:00.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-1",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "TeamDelete: team-1",
          runId: "run-1",
          teamKey: "key-1",
        },
      }),

      // Run 2 (different turn)
      makeActivity({
        id: "run2-started",
        createdAt: "2026-03-16T12:02:01.000Z",
        kind: "team.run.started",
        summary: "team-2 started",
        tone: "info",
        turnId: "turn-2",
        payload: { runId: "run-2", teamKey: "key-2", startedAt: "2026-03-16T12:02:01.000Z" },
      }),
      makeActivity({
        id: "run2-member",
        createdAt: "2026-03-16T12:02:02.000Z",
        kind: "teammate.started",
        summary: "agent-b started",
        tone: "info",
        turnId: "turn-2",
        payload: { taskId: "t2", teammateName: "agent-b", runId: "run-2", teamKey: "key-2" },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(2);

    // Run 1 should be ended
    const run1 = state.runs.find((r) => r.members.some((m) => m.label === "agent-a"));
    expect(run1?.endedAt).toBeDefined();
    expect(run1?.activeCount).toBe(0);

    // Run 2 should be active
    const run2 = state.runs.find((r) => r.members.some((m) => m.label === "agent-b"));
    expect(run2?.endedAt).toBeUndefined();
    expect(run2?.activeCount).toBeGreaterThan(0);

    expect(state.activeRunId).toBe("run-2");
  });
});

describe("Agent Teams: Status regression guard", () => {
  it("does not regress a completed member back to idle on late tool.completed", () => {
    const activities: OrchestrationThreadActivity[] = [
      // Explicit run start so all events share the same teamKey
      makeActivity({
        id: "run-started",
        createdAt: "2026-03-16T12:00:00.000Z",
        kind: "team.run.started",
        summary: "team started",
        tone: "info",
        turnId: "turn-reg",
        payload: { runId: "run-1", teamKey: "key-1", startedAt: "2026-03-16T12:00:00.000Z" },
      }),
      makeActivity({
        id: "teammate-started",
        createdAt: "2026-03-16T12:00:01.000Z",
        kind: "teammate.started",
        summary: "explorer started",
        tone: "info",
        turnId: "turn-reg",
        payload: {
          taskId: "task-e1",
          taskType: "in_process_teammate",
          teammateName: "explorer",
          teamName: "my-team",
          runId: "run-1",
          teamKey: "key-1",
          toolUseId: "tool-agent-1",
        },
      }),
      // Explorer completes its task
      makeActivity({
        id: "task-completed",
        createdAt: "2026-03-16T12:01:00.000Z",
        kind: "task.completed",
        summary: "Task completed",
        tone: "info",
        turnId: "turn-reg",
        payload: {
          taskId: "task-e1",
          status: "completed",
          summary: "Search complete.",
        },
      }),
      // Late tool.completed arrives AFTER the member is already completed
      makeActivity({
        id: "late-tool-completed",
        createdAt: "2026-03-16T12:01:05.000Z",
        kind: "tool.completed",
        summary: "Subagent task",
        tone: "tool",
        turnId: "turn-reg",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: 'Agent: {"description":"Search codebase"}',
          toolUseId: "tool-agent-1",
          runId: "run-1",
          teamKey: "key-1",
          agentName: "explorer",
          teammateName: "explorer",
        },
      }),
    ];

    const state = deriveAgentTeamsState(activities);
    expect(state.runs).toHaveLength(1);
    const explorer = state.runs[0]?.members.find((m) => m.label === "explorer");
    // Should still be "completed", NOT regressed to "idle" from tool.completed
    expect(explorer?.status).toBe("completed");
  });
});
