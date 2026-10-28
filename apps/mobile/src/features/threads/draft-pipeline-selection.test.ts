import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { activeDraftPipelineId } from "./draft-pipeline-selection";

describe("activeDraftPipelineId", () => {
  const environmentId = EnvironmentId.make("env-a");
  const selection = { environmentId, pipelineId: "plan-build" };

  it("keeps the choice whether or not the pipeline list has loaded", () => {
    expect(activeDraftPipelineId(selection, environmentId)).toBe("plan-build");
  });

  it("drops a choice made for another environment or without a project", () => {
    expect(activeDraftPipelineId(selection, EnvironmentId.make("env-b"))).toBeNull();
    expect(activeDraftPipelineId(selection, null)).toBeNull();
    expect(activeDraftPipelineId(null, environmentId)).toBeNull();
  });
});
