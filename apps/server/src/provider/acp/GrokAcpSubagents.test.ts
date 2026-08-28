import { describe, expect, it } from "@effect/vitest";

import {
  applyGrokSubagentUpdate,
  applyGrokWorkflowUpdate,
  emptyGrokSubagentTrackState,
  grokWorkflowMemberTaskId,
  parseXAiSubagentUpdate,
  parseXAiWorkflowUpdated,
} from "./GrokAcpSubagents.ts";

describe("parseXAiSubagentUpdate", () => {
  it("reads snake_case subagent_spawned envelopes", () => {
    const parsed = parseXAiSubagentUpdate({
      sessionId: "parent-session",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "child-1",
        subagent_type: "explore",
        description: "Search the codebase",
        child_session_id: "child-session-1",
        model: "grok-4.6",
      },
    });
    expect(parsed).toEqual({
      kind: "spawned",
      subagentId: "child-1",
      childSessionId: "child-session-1",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: undefined,
      error: undefined,
      tokensUsed: undefined,
      durationMs: undefined,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
  });

  it("accepts PascalCase tags and camelCase fields", () => {
    const parsed = parseXAiSubagentUpdate({
      sessionUpdate: "SubagentFinished",
      subagentId: "child-2",
      agentType: "plan",
      status: "failed",
      error: "depth limit",
      tokensUsed: 12,
      durationMs: 40,
      toolCallCount: 3,
    });
    expect(parsed?.kind).toBe("finished");
    expect(parsed?.subagentId).toBe("child-2");
    expect(parsed?.role).toBe("plan");
    expect(parsed?.error).toBe("depth limit");
    expect(parsed?.tokensUsed).toBe(12);
    expect(parsed?.toolCallCount).toBe(3);
  });

  it("ignores unrelated session extras", () => {
    expect(
      parseXAiSubagentUpdate({
        update: { sessionUpdate: "auto_compact_started", tokens_used: 100 },
      }),
    ).toBeUndefined();
  });
});

describe("applyGrokSubagentUpdate", () => {
  it("maps spawn/progress/finish onto the shared child-task path", () => {
    const spawned = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), {
      kind: "spawned",
      subagentId: "child-1",
      childSessionId: "child-session",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: undefined,
      error: undefined,
      tokensUsed: undefined,
      durationMs: undefined,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
    expect(spawned.events).toEqual([
      {
        type: "task.started",
        payload: {
          taskId: "child-1",
          description: "Search the codebase",
          title: "Search the codebase",
          taskType: "subagent",
          role: "explore",
          model: "grok-4.6",
          agentPath: "child-session",
          timelineBypass: true,
        },
      },
    ]);
    expect(spawned.events[0]?.payload.parentAgentId).toBeUndefined();

    const progressed = applyGrokSubagentUpdate(spawned.state, {
      kind: "progress",
      subagentId: "child-1",
      childSessionId: "child-session",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: "running",
      error: undefined,
      tokensUsed: 80,
      durationMs: 200,
      turnCount: 1,
      toolCallCount: 2,
      lastToolName: "grep",
      output: undefined,
    });
    expect(progressed.events).toHaveLength(1);
    expect(progressed.events[0]).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "child-1",
        status: "running",
        lastToolName: "grep",
        typedUsage: { totalTokens: 80, durationMs: 200, toolUses: 2 },
      },
    });

    const finished = applyGrokSubagentUpdate(progressed.state, {
      kind: "finished",
      subagentId: "child-1",
      childSessionId: "child-session",
      role: "explore",
      description: "Search the codebase",
      model: "grok-4.6",
      status: "completed",
      error: undefined,
      tokensUsed: 120,
      durationMs: 400,
      turnCount: 2,
      toolCallCount: 4,
      lastToolName: undefined,
      output: "Found 3 call sites.",
    });
    expect(finished.events).toEqual([
      {
        type: "task.completed",
        payload: {
          taskId: "child-1",
          description: "Search the codebase",
          title: "Search the codebase",
          taskType: "subagent",
          role: "explore",
          model: "grok-4.6",
          agentPath: "child-session",
          timelineBypass: true,
          status: "completed",
          summary: "Found 3 call sites.",
          typedUsage: { totalTokens: 120, durationMs: 400, toolUses: 4 },
        },
      },
    ]);
  });

  it("does not treat the parent ACP session as a workflow coordinator", () => {
    const parsed = parseXAiSubagentUpdate({
      sessionId: "parent-session",
      parent_session_id: "parent-session",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "child-1",
        subagent_type: "explore",
      },
    });
    expect(parsed).toBeDefined();
    const applied = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), parsed!);
    expect(applied.events[0]?.payload.parentAgentId).toBeUndefined();
    expect(applied.events[0]?.payload.taskType).toBe("subagent");
  });

  it("completes a first-seen terminal subagent", () => {
    const applied = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), {
      kind: "finished",
      subagentId: "late-1",
      childSessionId: undefined,
      role: "general-purpose",
      description: undefined,
      model: undefined,
      status: "failed",
      error: "cancelled by parent",
      tokensUsed: 9,
      durationMs: 30,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
    expect(applied.events.map((event) => event.type)).toEqual(["task.started", "task.completed"]);
    expect(applied.events[1]?.payload).toMatchObject({
      taskId: "late-1",
      status: "failed",
      summary: "cancelled by parent",
    });
  });

  it("keeps spawn-time token count when a later tick only reports tools", () => {
    const spawned = applyGrokSubagentUpdate(emptyGrokSubagentTrackState(), {
      kind: "spawned",
      subagentId: "child-1",
      childSessionId: undefined,
      role: "explore",
      description: undefined,
      model: undefined,
      status: undefined,
      error: undefined,
      tokensUsed: 50,
      durationMs: undefined,
      turnCount: undefined,
      toolCallCount: undefined,
      lastToolName: undefined,
      output: undefined,
    });
    const toolOnly = applyGrokSubagentUpdate(spawned.state, {
      kind: "progress",
      subagentId: "child-1",
      childSessionId: undefined,
      role: "explore",
      description: undefined,
      model: undefined,
      status: "running",
      error: undefined,
      tokensUsed: undefined,
      durationMs: 900,
      turnCount: undefined,
      toolCallCount: 7,
      lastToolName: "bash",
      output: undefined,
    });
    expect(toolOnly.events[0]?.payload.typedUsage).toEqual({
      totalTokens: 50,
      durationMs: 900,
      toolUses: 7,
    });
  });
});

describe("parseXAiWorkflowUpdated", () => {
  it("reads a workflow_updated envelope", () => {
    const parsed = parseXAiWorkflowUpdated({
      update: {
        sessionUpdate: "workflow_updated",
        run_id: "run-1",
        name: "review",
        objective: "Review the PR",
        status: "active",
        current_phase: "review",
        phases: [{ title: "review", state: "running" }],
        agents: [
          {
            agent_id: "agent-a",
            label: "Reviewer",
            phase: "review",
            model: "grok-4.6",
            state: "running",
            tokens_used: 20,
            duration_ms: 100,
          },
        ],
      },
    });
    expect(parsed?.runId).toBe("run-1");
    expect(parsed?.agents).toHaveLength(1);
    expect(parsed?.agents[0]?.agentId).toBe("agent-a");
  });
});

describe("applyGrokWorkflowUpdate", () => {
  it("stamps members with parentAgentId, timelineBypass, and a stable slot", () => {
    const applied = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), {
      runId: "run-1",
      revision: 1,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [{ title: "review", state: "running" }],
      currentPhase: "review",
      agentBudget: 4,
      agentsUsed: 1,
      elapsedMs: 100,
      activeAgents: 1,
      currentAgentLabel: "Reviewer",
      agents: [
        {
          agentId: "agent-a",
          label: "Reviewer",
          phase: "review",
          model: "grok-4.6",
          state: "running",
          tokensUsed: 20,
          durationMs: 100,
        },
      ],
      pauseMessage: undefined,
      resultSummary: undefined,
    });

    expect(applied.events[0]).toMatchObject({
      type: "task.started",
      payload: {
        taskId: "run-1",
        taskType: "local_workflow",
        workflowName: "review",
      },
    });
    const memberStart = applied.events.find(
      (event) =>
        event.type === "task.started" &&
        event.payload.taskId === grokWorkflowMemberTaskId("run-1", "agent-a"),
    );
    expect(memberStart?.payload).toMatchObject({
      parentAgentId: "run-1",
      timelineBypass: true,
      taskType: "subagent",
      title: "Reviewer",
      model: "grok-4.6",
    });
  });

  it("skips unchanged member ticks", () => {
    const first = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), {
      runId: "run-1",
      revision: 1,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [
        {
          agentId: "agent-a",
          label: "Reviewer",
          phase: undefined,
          model: undefined,
          state: "running",
          tokensUsed: 10,
          durationMs: 50,
        },
      ],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    const second = applyGrokWorkflowUpdate(first.state, {
      runId: "run-1",
      revision: 2,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [
        {
          agentId: "agent-a",
          label: "Reviewer",
          phase: undefined,
          model: undefined,
          state: "running",
          tokensUsed: 10,
          durationMs: 50,
        },
      ],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    expect(
      second.events.filter(
        (event) => event.payload.taskId === grokWorkflowMemberTaskId("run-1", "agent-a"),
      ),
    ).toHaveLength(0);
  });

  it("emits member progress when wire state changes but mapped status does not", () => {
    const member = {
      agentId: "agent-a",
      label: "Reviewer",
      phase: undefined as string | undefined,
      model: undefined as string | undefined,
      tokensUsed: 10,
      durationMs: 50,
    };
    const first = applyGrokWorkflowUpdate(emptyGrokSubagentTrackState(), {
      runId: "run-1",
      revision: 1,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [{ ...member, state: "start" }],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    const second = applyGrokWorkflowUpdate(first.state, {
      runId: "run-1",
      revision: 2,
      name: "review",
      objective: "Review the PR",
      status: "active",
      phases: [],
      currentPhase: undefined,
      agentBudget: undefined,
      agentsUsed: undefined,
      elapsedMs: undefined,
      activeAgents: undefined,
      currentAgentLabel: undefined,
      agents: [{ ...member, state: "running" }],
      pauseMessage: undefined,
      resultSummary: undefined,
    });
    const memberProgress = second.events.find(
      (event) =>
        event.type === "task.progress" &&
        event.payload.taskId === grokWorkflowMemberTaskId("run-1", "agent-a"),
    );
    expect(memberProgress?.payload).toMatchObject({
      status: "running",
      summary: "running",
    });
  });
});
