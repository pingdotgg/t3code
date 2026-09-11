import { deriveAgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import {
  allPanelAgents,
  expansionsAfterCollapse,
  finishedAgents,
  isLiveAgent,
} from "./AgentsPanel.logic";

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
    firstSeenAt: "2026-02-23T00:00:00.000Z",
    startedAt: "2026-02-23T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-02-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("isLiveAgent", () => {
  it("treats idle as settled: a resting agent is not work in flight", () => {
    expect(isLiveAgent(agent({ id: "a", status: "running" }))).toBe(true);
    expect(isLiveAgent(agent({ id: "b", status: "waiting" }))).toBe(true);
    expect(isLiveAgent(agent({ id: "c", status: "idle" }))).toBe(false);
    expect(isLiveAgent(agent({ id: "d", status: "completed" }))).toBe(false);
    expect(isLiveAgent(agent({ id: "e", status: "failed" }))).toBe(false);
  });
});

describe("finishedAgents", () => {
  it("collects settled members from every phase and from direct spawns", () => {
    const model = deriveAgentPanelModel({
      agents: [
        agent({ id: "wf", kind: "workflow", status: "running" }),
        agent({ id: "m1", parentAgentId: "wf", phaseIndex: 0, status: "completed" }),
        agent({ id: "m2", parentAgentId: "wf", phaseIndex: 0, status: "running" }),
        agent({ id: "m3", parentAgentId: "wf", phaseIndex: 1, status: "failed" }),
        agent({ id: "direct-live", status: "running" }),
        agent({ id: "direct-done", status: "completed" }),
      ],
    });

    expect(finishedAgents(model).map((entry) => entry.id)).toEqual(["m1", "m3", "direct-done"]);
    // The coordinator is a container for its members, not a row of its own:
    // counting it would report one more agent than is running and double its
    // members' usage in the panel total.
    expect(allPanelAgents(model).map((entry) => entry.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "direct-done",
      "direct-live",
    ]);
  });

  it("keeps roster order when an agent settles, so cards never reshuffle", () => {
    const before = deriveAgentPanelModel({
      agents: [
        agent({ id: "first", firstSeenAt: "2026-02-23T00:00:00.000Z", status: "completed" }),
        agent({ id: "second", firstSeenAt: "2026-02-23T00:00:01.000Z", status: "running" }),
        agent({ id: "third", firstSeenAt: "2026-02-23T00:00:02.000Z", status: "completed" }),
      ],
    });
    const after = deriveAgentPanelModel({
      agents: [
        agent({ id: "first", firstSeenAt: "2026-02-23T00:00:00.000Z", status: "completed" }),
        agent({ id: "second", firstSeenAt: "2026-02-23T00:00:01.000Z", status: "completed" }),
        agent({ id: "third", firstSeenAt: "2026-02-23T00:00:02.000Z", status: "completed" }),
      ],
    });

    expect(finishedAgents(before).map((entry) => entry.id)).toEqual(["first", "third"]);
    expect(finishedAgents(after).map((entry) => entry.id)).toEqual(["first", "second", "third"]);
  });
});

describe("expansionsAfterCollapse", () => {
  it("closes cards inside the collapsed section and leaves the rest open", () => {
    const expanded = new Set(["a", "b", "c"]);
    const next = expansionsAfterCollapse(expanded, [agent({ id: "b" }), agent({ id: "c" })]);

    expect([...next]).toEqual(["a"]);
    // The caller's set is never mutated: React state has to change identity.
    expect([...expanded]).toEqual(["a", "b", "c"]);
  });
});
