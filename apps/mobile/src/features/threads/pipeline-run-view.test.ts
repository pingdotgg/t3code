import { describe, expect, it } from "vite-plus/test";

import { pipelineStepTone } from "./pipeline-run-view";

describe("pipelineStepTone", () => {
  it("separates running, completed and failed from the rest", () => {
    expect(pipelineStepTone("running")).toBe("active");
    expect(pipelineStepTone("completed")).toBe("success");
    expect(pipelineStepTone("failed")).toBe("danger");
    expect(pipelineStepTone("skipped")).toBe("muted");
  });
});
