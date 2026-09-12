import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { allPanelAgents, workflowIsVisible } from "./AgentsPanel.logic";

function agent(overrides: Partial<RuntimeSubagent> & { id: string }): RuntimeSubagent {
  return {
    kind: "subagent",
    title: overrides.id,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-10T00:00:00.000Z",
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function workflowGroup(
  workflow: RuntimeSubagent,
  members: ReadonlyArray<RuntimeSubagent>,
): AgentPanelWorkflowGroup {
  return {
    workflow,
    phases: [
      {
        index: 0,
        title: "Review",
        members,
        state: members.length === 0 ? "pending" : "done",
        activeCount: 0,
        settledCount: members.length,
      },
    ],
    unphasedMembers: [],
  };
}

function panelModel(workflows: ReadonlyArray<AgentPanelWorkflowGroup>): AgentPanelModel {
  return {
    workflows,
    directAgents: [],
    runningCount: 1,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 0,
    totalTokens: 0,
    hasAgents: true,
    liveCount: 1,
  };
}

describe("Agents panel workflow visibility", () => {
  it("keeps a running coordinator visible before its first member starts", () => {
    const group = workflowGroup(agent({ id: "workflow", kind: "workflow" }), []);

    expect(workflowIsVisible(group)).toBe(true);
    expect(allPanelAgents(panelModel([group])).map((entry) => entry.id)).toEqual(["workflow"]);
  });

  it("keeps the workflow visible between phases without duplicating its coordinator", () => {
    const group = workflowGroup(agent({ id: "workflow", kind: "workflow" }), [
      agent({ id: "reviewer", status: "completed", parentAgentId: "workflow" }),
    ]);

    expect(workflowIsVisible(group)).toBe(true);
    expect(allPanelAgents(panelModel([group])).map((entry) => entry.id)).toEqual(["reviewer"]);
  });

  it("retains a failed memberless coordinator in the finished roster", () => {
    const group = workflowGroup(agent({ id: "workflow", kind: "workflow", status: "failed" }), []);

    expect(workflowIsVisible(group)).toBe(false);
    expect(allPanelAgents(panelModel([group])).map((entry) => entry.id)).toEqual(["workflow"]);
  });
});
