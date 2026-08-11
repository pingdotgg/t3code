import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectDeleteCommandInput } from "./projectRemoval";

describe("projectDeleteCommandInput", () => {
  it("force-deletes threads even when only archived threads exist", () => {
    expect(projectDeleteCommandInput(ProjectId.make("project-1"))).toEqual({
      projectId: "project-1",
      force: true,
    });
  });
});
