import { describe, expect, it } from "vite-plus/test";

import type { PipelineRun } from "@t3tools/contracts";

import { pipelineStepTone, stepRevisions } from "./pipeline-run-view";

function makeRun(input: {
  readonly status: PipelineRun["status"];
  readonly currentStepIndex: number;
  readonly steps: ReadonlyArray<{ status: string; attempt: number }>;
  readonly revisions?: ReadonlyArray<{ stepIndex: number }>;
}): PipelineRun {
  return {
    status: input.status,
    currentStepIndex: input.currentStepIndex,
    definition: { name: "P", steps: input.steps.map((_, index) => ({ name: `S${index + 1}` })) },
    steps: input.steps.map((step, index) => ({ index, stepId: `s${index}`, ...step })),
    revisions: input.revisions ?? [],
  } as unknown as PipelineRun;
}

describe("pipelineStepTone", () => {
  it("separates running, completed and failed from the rest", () => {
    expect(pipelineStepTone("running")).toBe("active");
    expect(pipelineStepTone("completed")).toBe("success");
    expect(pipelineStepTone("failed")).toBe("danger");
    expect(pipelineStepTone("skipped")).toBe("muted");
  });
});

describe("stepRevisions", () => {
  it("keeps only the revisions of one step", () => {
    const run = makeRun({
      status: "paused",
      currentStepIndex: 1,
      steps: [
        { status: "completed", attempt: 1 },
        { status: "completed", attempt: 1 },
      ],
      revisions: [{ stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 0 }],
    });
    expect(stepRevisions(run, 0)).toHaveLength(2);
    expect(stepRevisions(run, 1)).toHaveLength(1);
  });
});
