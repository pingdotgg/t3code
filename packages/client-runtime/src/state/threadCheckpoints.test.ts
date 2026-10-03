import { describe, expect, it } from "vite-plus/test";
import { partitionCheckpointFiles } from "./threadCheckpoints.ts";

describe("checkpoint review grouping", () => {
  it("keeps uncertain and legacy changes visible alongside a separate Git import group", () => {
    const local = { path: "fix.ts", additions: 3, deletions: 1 };
    const imported = {
      path: "upstream.ts",
      additions: 500,
      deletions: 200,
      origin: "git" as const,
    };
    const legacy = { path: "legacy.ts", additions: 2, deletions: 0 };
    const groups = partitionCheckpointFiles([local, imported, legacy]);
    expect(groups.workspaceFiles).toEqual([local, legacy]);
    expect(groups.gitFiles).toEqual([imported]);
  });
});
