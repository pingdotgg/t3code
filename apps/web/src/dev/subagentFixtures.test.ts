import {
  deriveAgentPanelModel,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkLogEntries } from "../session-logic";
import {
  DEV_SUBAGENT_SCENARIOS,
  devSubagentActivities,
  isDevSubagentScenario,
} from "./subagentFixtures";

const NOW = Date.parse("2026-08-11T22:00:00.000Z");

function panelModelFor(scenario: (typeof DEV_SUBAGENT_SCENARIOS)[number]) {
  const activities = devSubagentActivities(scenario, NOW);
  return deriveAgentPanelModel({ agents: foldSubagentActivities(activities) });
}

/** The chat renders one CTA row per spawn group; this counts them. */
function spawnCtaRowsFor(scenario: (typeof DEV_SUBAGENT_SCENARIOS)[number]) {
  return deriveWorkLogEntries(devSubagentActivities(scenario, NOW)).filter(
    (entry) => entry.agentSpawn !== undefined,
  );
}

describe("dev subagent fixtures", () => {
  it("recognizes exactly the published scenarios", () => {
    for (const scenario of DEV_SUBAGENT_SCENARIOS) {
      expect(isDevSubagentScenario(scenario)).toBe(true);
    }
    expect(isDevSubagentScenario("not-a-scenario")).toBe(false);
  });

  it("never stamps an activity after the fixture clock", () => {
    for (const scenario of DEV_SUBAGENT_SCENARIOS) {
      const late = devSubagentActivities(scenario, NOW).filter(
        (activity) => Date.parse(activity.createdAt) > NOW,
      );
      expect({ scenario, late: late.map((activity) => activity.id) }).toEqual({
        scenario,
        late: [],
      });
    }
  });

  it("produces agents for every scenario except the empty state", () => {
    for (const scenario of DEV_SUBAGENT_SCENARIOS) {
      expect({ scenario, hasAgents: panelModelFor(scenario).hasAgents }).toEqual({
        scenario,
        hasAgents: scenario !== "empty",
      });
    }
  });

  it("renders the empty state as no agents at all", () => {
    const model = panelModelFor("empty");
    expect(model.hasAgents).toBe(false);
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents).toHaveLength(0);
    expect(spawnCtaRowsFor("empty")).toHaveLength(0);
  });

  it("groups a live workflow into phases with the arc done -> running -> pending", () => {
    const model = panelModelFor("workflow-live");
    expect(model.workflows).toHaveLength(1);

    const group = model.workflows[0]!;
    expect(group.workflow.kind).toBe("workflow");
    expect(group.workflow.workflowName).toBe("review-changes");
    expect(group.workflow.status).toBe("running");
    // Every member resolves to a phase; none fall through to the orphan list.
    expect(group.unphasedMembers).toHaveLength(0);
    expect(group.phases.map((phase) => [phase.title, phase.state])).toEqual([
      ["Scan", "done"],
      ["Review", "running"],
      ["Verify", "pending"],
    ]);
    // A pending phase with no members still renders as a rail segment.
    expect(group.phases[2]!.members).toHaveLength(0);
    expect(model.liveCount).toBeGreaterThan(0);
    expect(model.totalTokens).toBeGreaterThan(0);
  });

  it("exposes the script handle the panel needs to offer the {} script button", () => {
    const group = panelModelFor("workflow-live").workflows[0]!;
    expect(group.workflow.runHandles?.scriptPath).toBe("/tmp/t3-workflows/review-changes.js");
  });

  it("settles every row when the workflow completes", () => {
    const model = panelModelFor("workflow-settled");
    const group = model.workflows[0]!;
    expect(group.workflow.status).toBe("completed");
    expect(group.phases.every((phase) => phase.state === "done")).toBe(true);
    expect(model.liveCount).toBe(0);
  });

  it("keeps failure detail on the failed workflow", () => {
    const group = panelModelFor("workflow-failed").workflows[0]!;
    expect(group.workflow.status).toBe("failed");

    const members = group.phases.flatMap((phase) => phase.members);
    const failed = members.find((member) => member.status === "failed");
    expect(failed?.error).toContain("Type error after codemod");
    // A retried slot reports its attempt as a run counter, not a duplicate row.
    expect(failed?.activationCount).toBeGreaterThanOrEqual(1);
    expect(members.some((member) => member.status === "cancelled")).toBe(true);
  });

  it("puts direct spawns in the direct list, not under a workflow", () => {
    const model = panelModelFor("direct");
    expect(model.workflows).toHaveLength(0);
    expect(model.directAgents).toHaveLength(3);
    expect(model.directAgents.map((agent) => agent.status).sort()).toEqual([
      "completed",
      "idle",
      "running",
    ]);
  });

  it("collapses a whole workflow run into a single inline CTA row", () => {
    const rows = spawnCtaRowsFor("workflow-live");
    expect(rows).toHaveLength(1);
    // The coordinator and all four members share one row.
    expect(rows[0]!.agentSpawn?.workflowId).toBe("wf-review");
    expect(rows[0]!.agentSpawn?.agentTaskIds.length).toBeGreaterThan(1);
  });

  it("batches direct spawns into one CTA row and keeps runs separate in mixed", () => {
    expect(spawnCtaRowsFor("direct")).toHaveLength(1);
    // A workflow run and a direct batch are two distinct narrative events.
    const mixed = spawnCtaRowsFor("mixed");
    expect(mixed).toHaveLength(2);
    expect(mixed.filter((row) => row.agentSpawn?.workflowId === "wf-review")).toHaveLength(1);
    expect(mixed.filter((row) => row.agentSpawn?.workflowId === null)).toHaveLength(1);
  });

  it("builds the scale scenario without dropping members or phases", () => {
    const group = panelModelFor("many").workflows[0]!;
    const members = [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
    expect(members).toHaveLength(60);
    expect(group.phases).toHaveLength(5);
    expect(spawnCtaRowsFor("many")).toHaveLength(1);
  });

  it("keeps hostile values intact so the fixed-height rows can be tested", () => {
    const group = panelModelFor("overflow").workflows[0]!;
    const members = group.phases.flatMap((phase) => phase.members);
    const failed = members.find((member) => member.status === "failed");
    expect(failed?.usage?.totalTokens).toBe(2_400_000);
    expect(failed?.error?.length).toBeGreaterThan(80);
  });

  it("times live rows relative to the supplied clock", () => {
    const activities = devSubagentActivities("workflow-live", NOW);
    for (const activity of activities) {
      expect(Date.parse(activity.createdAt)).toBeLessThanOrEqual(NOW);
    }
    // Deterministic for a fixed clock: same input, same rows.
    expect(devSubagentActivities("workflow-live", NOW)).toEqual(activities);
  });
});
