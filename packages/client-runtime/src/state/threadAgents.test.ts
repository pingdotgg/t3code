import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationThreadActivity, ThreadAgentSnapshot } from "@t3tools/contracts";
import {
  deriveAgentPanelState,
  deriveLatestAgentSnapshot,
  formatAgentTokenCount,
} from "./threadAgents.ts";

// Shape captured from a real server run (integrated verification, 2026-07-20).
const persistedAgent = {
  agentId: "a732c41b4b7ba7742",
  provider: "claudeAgent",
  kind: "subagent",
  name: "Say hi",
  agentType: "general-purpose",
  status: "completed",
  usage: { totalTokens: 22_798, toolUses: 0 },
  firstStartedAt: "2026-07-21T03:52:02.264Z",
  lastActivityAt: "2026-07-21T03:52:03.936Z",
  endedAt: "2026-07-21T03:52:03.936Z",
  activationCount: 1,
  lastTurnId: "45609775-4b3b-4444-879d-1d9f25a1b954",
  resultSummary: "Hi! How can I help you today?",
  recentActivity: [],
  updatedAt: "2026-07-21T03:52:03.936Z",
};

function activity(kind: string, payload: unknown, sequence: number): OrchestrationThreadActivity {
  return {
    id: `evt-${sequence}`,
    tone: "info",
    kind,
    summary: "agents",
    payload,
    turnId: null,
    sequence,
    createdAt: "2026-07-21T03:52:03.936Z",
  } as OrchestrationThreadActivity;
}

describe("deriveLatestAgentSnapshot", () => {
  it("decodes a persisted server payload and returns the newest roster", () => {
    const agents = deriveLatestAgentSnapshot([
      activity("agent.snapshot", { agents: [{ ...persistedAgent, status: "running" }] }, 1),
      activity("context-window.updated", { usedTokens: 10 }, 2),
      activity("agent.snapshot", { agents: [persistedAgent] }, 3),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe("completed");
    expect(agents[0]?.usage?.totalTokens).toBe(22_798);
    expect(agents[0]?.resultSummary).toBe("Hi! How can I help you today?");
  });

  it("treats the newest agents array as authoritative even when its rows fail to decode", () => {
    // Falling back to the older roster would resurrect a stale "running"
    // snapshot; an undecodable newest roster must yield an empty panel.
    const agents = deriveLatestAgentSnapshot([
      activity("agent.snapshot", { agents: [persistedAgent], revision: 1 }, 1),
      activity("agent.snapshot", { agents: [{ bogus: true }], revision: 2 }, 2),
    ]);
    expect(agents).toHaveLength(0);
  });

  it("skips bad rows within a roster while keeping decodable ones", () => {
    const agents = deriveLatestAgentSnapshot([
      activity("agent.snapshot", { agents: [persistedAgent, { bogus: true }], revision: 1 }, 1),
    ]);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe(persistedAgent.agentId);
  });

  it("selects the highest revision regardless of list position", () => {
    const older = { ...persistedAgent, status: "running" };
    const agents = deriveLatestAgentSnapshot([
      activity("agent.snapshot", { agents: [persistedAgent], revision: 5 }, 1),
      activity("agent.snapshot", { agents: [older], revision: 4 }, 2),
    ]);
    expect(agents[0]?.status).toBe("completed");
  });

  it("returns an empty roster when no snapshot activity exists", () => {
    expect(deriveLatestAgentSnapshot([activity("task.progress", {}, 1)])).toHaveLength(0);
  });
});

describe("deriveAgentPanelState", () => {
  const base = deriveLatestAgentSnapshot([
    activity("agent.snapshot", { agents: [persistedAgent] }, 1),
  ]);

  it("counts settled agents and sums tokens", () => {
    const state = deriveAgentPanelState(base);
    expect(state.settledCount).toBe(1);
    expect(state.runningCount).toBe(0);
    expect(state.totalTokens).toBe(22_798);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]?.workflow).toBeNull();
  });

  it("groups workflow members under declared phases with derived status", () => {
    const workflow: ThreadAgentSnapshot = {
      ...(base[0] as ThreadAgentSnapshot),
      agentId: "wf-1",
      kind: "workflow",
      name: "audit",
      status: "running",
      phases: [
        { index: 0, title: "Audit" },
        { index: 1, title: "Verify" },
      ],
    };
    const member: ThreadAgentSnapshot = {
      ...(base[0] as ThreadAgentSnapshot),
      agentId: "wa-1",
      kind: "workflow_agent",
      parentAgentId: "wf-1",
      phaseIndex: 0,
      status: "completed",
    };
    const state = deriveAgentPanelState([workflow, member]);
    const group = state.groups[0];
    expect(group?.workflow?.agentId).toBe("wf-1");
    expect(group?.phases[0]?.status).toBe("done");
    expect(group?.phases[1]?.status).toBe("pending");
  });
});

describe("formatAgentTokenCount", () => {
  it("formats counts at k/M scale", () => {
    expect(formatAgentTokenCount(950)).toBe("950");
    expect(formatAgentTokenCount(22_798)).toBe("22.8k");
    expect(formatAgentTokenCount(1_200_000)).toBe("1.2M");
  });
});
