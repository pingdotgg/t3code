import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  workflowAnswerPreview,
  workflowPhaseSummary,
  workflowRunCounts,
  workflowRunPhases,
} from "./WorkflowRunView.logic";

const at = DateTime.makeUnsafe("2026-10-15T10:00:00.000Z");

function phasesOf(
  workflow: OrchestrationV2SubagentWorkflow,
  status: "running" | "cancelled" = "running",
) {
  const [group] = deriveWorkflowGroups(
    projectedSubagentsToRuntime([
      {
        id: "coordinator",
        title: "Build the game",
        prompt: "export const meta = …",
        model: null,
        status,
        workflow,
        result: null,
        startedAt: at,
        completedAt: null,
        updatedAt: at,
      },
    ]),
  );
  return workflowRunPhases(group!);
}

const PLAN = [
  { index: 0, title: "Plan" },
  { index: 1, title: "Build" },
];

describe("workflow run view", () => {
  it("summarizes a live phase and counts settled agents", () => {
    const phases = phasesOf({
      phases: PLAN,
      agents: [
        { index: 0, label: "plan", state: "completed", phaseIndex: 0 },
        { index: 1, label: "build:a", state: "failed", phaseIndex: 1 },
        { index: 2, label: "build:b", state: "running", phaseIndex: 1 },
        { index: 3, label: "build:c", state: "completed", phaseIndex: 1 },
      ],
    });
    expect(workflowPhaseSummary(phases[1]!.members)).toEqual({
      text: "1 running · 1 done · 1 failed",
      active: true,
      failed: true,
    });
    expect(workflowRunCounts(phases)).toEqual({ total: 4, settled: 3 });
  });

  it("names stopped agents when the workflow was stopped", () => {
    const phases = phasesOf(
      {
        phases: PLAN,
        agents: [
          { index: 0, label: "build:a", state: "completed", phaseIndex: 1 },
          { index: 1, label: "build:b", state: "running", phaseIndex: 1 },
        ],
      },
      "cancelled",
    );
    expect(workflowPhaseSummary(phases[1]!.members).text).toBe("1 done · 1 stopped");
  });

  it("lists agents without a phase under Other", () => {
    const phases = phasesOf({
      phases: [],
      agents: [{ index: 0, label: "loose", state: "running" }],
    });
    expect(phases.map((phase) => [phase.title, phase.state])).toEqual([["Other", "running"]]);
  });

  it("previews a structured answer by its first field", () => {
    expect(workflowAnswerPreview('{"summary":"Built the physics stream","files":[')).toBe(
      "Built the physics stream",
    );
    expect(workflowAnswerPreview("\nAll tests pass.\nDetails follow")).toBe("All tests pass.");
    expect(workflowAnswerPreview('{"summary":"Added \\"trucks\\"\\nThen tests')).toBe(
      'Added "trucks"',
    );
  });
});
