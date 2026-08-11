import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AgentsPanel } from "./AgentsPanel";

function idleAgent(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id: "agent-1",
    kind: "subagent",
    title: "agent-1",
    role: null,
    model: null,
    effort: null,
    status: "idle",
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
    firstSeenAt: "2026-08-11T21:49:13.000Z",
    startedAt: "2026-08-11T21:49:13.000Z",
    completedAt: null,
    updatedAt: "2026-08-11T22:07:16.000Z",
    ...overrides,
  };
}

function panelModel(agent: RuntimeSubagent): AgentPanelModel {
  return {
    workflows: [],
    directAgents: [agent],
    runningCount: 0,
    waitingCount: 0,
    idleCount: 1,
    settledCount: 0,
    totalTokens: 0,
    hasAgents: true,
    liveCount: 0,
  };
}

describe("AgentsPanel elapsed time", () => {
  it("freezes an idle agent at its idle transition", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T22:34:00.000Z"));

    try {
      const markup = renderToStaticMarkup(<AgentsPanel model={panelModel(idleAgent())} />);

      expect(markup).toContain("18m 03s");
      expect(markup).not.toContain("44m 47s");
    } finally {
      vi.useRealTimers();
    }
  });
});
