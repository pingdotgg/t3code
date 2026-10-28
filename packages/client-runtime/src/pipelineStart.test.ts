import { PipelineId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextPipelineStartAttempt } from "./pipelineStart.ts";

const base = {
  pipelineId: PipelineId.make("pipeline-1"),
  projectId: ProjectId.make("project-1"),
  input: "ship it",
  workspace: { mode: "worktree", branch: "main" },
};

describe("nextPipelineStartAttempt", () => {
  it.each([
    ["identical request", {}, true],
    ["other pipeline", { pipelineId: PipelineId.make("pipeline-2") }, false],
    ["other project", { projectId: ProjectId.make("project-2") }, false],
    ["other input text", { input: "ship it now" }, false],
    ["other workspace selection", { workspace: { mode: "local", branch: "main" } }, false],
  ])("%s: command id reused is %s", (_name, change, reused) => {
    let issued = 0;
    const newId = () => `command-${(issued += 1)}`;
    const first = nextPipelineStartAttempt(null, base, newId);
    const second = nextPipelineStartAttempt(first, { ...base, ...change }, newId);
    expect(second.commandId === first.commandId).toBe(reused);
    expect(issued).toBe(reused ? 1 : 2);
  });
});
