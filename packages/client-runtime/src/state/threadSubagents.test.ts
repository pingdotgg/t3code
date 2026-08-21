import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  deriveAgentPanelModel,
  emptyAgentPanelModel,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "./threadSubagents.ts";

const now = DateTime.makeUnsafe("2026-08-13T10:00:00.000Z");

function subagent(
  id: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("root-1"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claude"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: `Prompt for ${id}`,
    title: id,
    model: "claude-opus-4-20250514",
    kind: "subagent",
    role: { name: "reviewer", source: "provider" },
    status: "running",
    progress: undefined,
    result: null,
    usage: null,
    currentActivationId: null,
    activationCount: 1,
    workflow: null,
    workflowMembership: null,
    recentActivity: [],
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...overrides,
  };
}

describe("deriveAgentPanelModel", () => {
  it("returns the empty panel model when V2 has no subagents", () => {
    expect(deriveAgentPanelModel([])).toBe(emptyAgentPanelModel());
  });

  it("groups V2 workflow members and derives phase state", () => {
    const workflowId = NodeId.make("workflow-1");
    const workflow = subagent(workflowId, {
      kind: "workflow",
      role: { name: "coordinator", source: "provider" },
      workflow: {
        name: "review",
        phases: [
          { index: 0, title: "Inspect" },
          { index: 1, title: "Verify" },
        ],
        runId: "workflow-run-1",
        scriptPath: "/tmp/review.js",
      },
    });
    const completed = subagent("workflow-1:agent-0", {
      kind: "workflow_agent",
      parentNodeId: workflowId,
      status: "completed",
      result: "done",
      completedAt: now,
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 0,
        phaseIndex: 0,
        attempt: 1,
      },
    });
    const idle = subagent("workflow-1:agent-1", {
      kind: "workflow_agent",
      parentNodeId: workflowId,
      status: "idle",
      usage: { totalTokens: 120, toolUses: 3 },
      activationCount: 2,
      recentActivity: [{ at: now, summary: "Inspected the implementation" }],
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 1,
        phaseIndex: 1,
        attempt: 2,
      },
    });

    const model = deriveAgentPanelModel([workflow, completed, idle]);

    expect(model.workflows[0]?.workflow).toMatchObject({
      id: "workflow-1",
      workflowName: "review",
      runHandles: { runId: "workflow-run-1", scriptPath: "/tmp/review.js" },
    });
    expect(model.workflows[0]?.phases.map((phase) => phase.state)).toEqual(["done", "running"]);
    expect(model.workflows[0]?.phases[1]?.members[0]).toMatchObject({
      id: "workflow-1:agent-1",
      phaseTitle: "Verify",
      progress: "Inspected the implementation",
      usage: { totalTokens: 120, toolUses: 3 },
    });
    expect(model.runningCount).toBe(0);
    expect(model.idleCount).toBe(1);
    expect(model.settledCount).toBe(1);
    expect(model.totalTokens).toBe(120);
  });

  it("keeps orphaned and direct subagents visible in first-seen order", () => {
    const later = DateTime.makeUnsafe("2026-08-13T10:00:01.000Z");
    const direct = subagent("direct", { startedAt: later, updatedAt: later });
    const orphan = subagent("orphan", {
      startedAt: null,
      workflowMembership: {
        workflowSubagentId: NodeId.make("missing-workflow"),
        agentIndex: 0,
        phaseIndex: 9,
        attempt: 1,
      },
    });

    const model = deriveAgentPanelModel([direct, orphan]);

    expect(model.workflows).toEqual([]);
    expect(model.directAgents.map((agent) => agent.id)).toEqual(["orphan", "direct"]);
  });

  it("orders nested subagents beneath their parent", () => {
    const later = DateTime.makeUnsafe("2026-08-13T10:00:01.000Z");
    const childThreadId = ThreadId.make("child-thread");
    const parent = subagent("parent", {
      childThreadId,
      startedAt: later,
      updatedAt: later,
    });
    const child = subagent("child", {
      threadId: childThreadId,
      parentNodeId: NodeId.make("parent:thread-root"),
    });
    const model = deriveAgentPanelModel([child, parent]);

    expect(model.directAgents.map((agent) => [agent.id, agent.parentAgentId])).toEqual([
      ["parent", null],
      ["child", "parent"],
    ]);
  });

  it("keeps unknown workflow phase members in the unphased list", () => {
    const workflowId = NodeId.make("workflow-2");
    const workflow = subagent(workflowId, {
      kind: "workflow",
      workflow: { phases: [{ index: 0, title: "Known" }] },
    });
    const member = subagent("workflow-2:agent-0", {
      kind: "workflow_agent",
      workflowMembership: {
        workflowSubagentId: workflowId,
        agentIndex: 0,
        phaseIndex: 9,
        attempt: 1,
      },
    });

    expect(deriveAgentPanelModel([workflow, member]).workflows[0]?.unphasedMembers).toHaveLength(1);
  });
});

describe("subagent formatting", () => {
  it("compacts model ids", () => {
    expect(formatSubagentModelLabel("claude-sonnet-5[1m]")).toBe("sonnet-5[1m]");
    expect(formatSubagentModelLabel("claude-opus-4-20250514")).toBe("opus-4");
    expect(formatSubagentModelLabel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(formatSubagentModelLabel(null)).toBeNull();
  });

  it("formats token counts", () => {
    expect(formatSubagentTokenCount(950)).toBe("950");
    expect(formatSubagentTokenCount(41_200)).toBe("41.2k");
    expect(formatSubagentTokenCount(247_000)).toBe("247k");
    expect(formatSubagentTokenCount(1_400_000)).toBe("1.4M");
  });
});
