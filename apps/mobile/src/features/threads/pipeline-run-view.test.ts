import { describe, expect, it } from "vite-plus/test";

import {
  nextPipelineStartAttempt,
  pipelineStepPosition,
  pipelineStepTone,
} from "./pipeline-run-view";

describe("pipelineStepPosition", () => {
  const run = {
    definition: { name: "Review", steps: [{ name: "Plan" }, { name: "Build" }] },
    steps: [{ stepId: "a" }, { stepId: "b" }],
  } as unknown as Parameters<typeof pipelineStepPosition>[0];

  it("numbers the step from one and names it from the snapshot", () => {
    expect(pipelineStepPosition(run, "b")).toEqual({ number: 2, total: 2, name: "Build" });
  });

  it("is null for a step the run does not have", () => {
    expect(pipelineStepPosition(run, "missing")).toBeNull();
  });
});

describe("pipelineStepTone", () => {
  it("separates running, completed and failed from the rest", () => {
    expect(pipelineStepTone("running")).toBe("active");
    expect(pipelineStepTone("completed")).toBe("success");
    expect(pipelineStepTone("failed")).toBe("danger");
    expect(pipelineStepTone("skipped")).toBe("muted");
  });
});

describe("nextPipelineStartAttempt", () => {
  it("reuses the attempt until the request changes", () => {
    let counter = 0;
    const create = () => {
      counter += 1;
      return { commandId: `c${counter}`, worktreeBranchName: `b${counter}` };
    };
    const first = nextPipelineStartAttempt(null, "x", create);
    expect(nextPipelineStartAttempt(first, "x", create)).toBe(first);
    expect(nextPipelineStartAttempt(first, "y", create).commandId).toBe("c2");
  });
});
