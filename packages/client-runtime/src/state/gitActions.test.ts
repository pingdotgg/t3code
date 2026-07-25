import { describe, expect, it } from "vite-plus/test";

import { buildGitActionProgressStages } from "./gitActions.ts";

const baseInput = {
  hasCustomCommitMessage: false,
  hasWorkingTreeChanges: false,
} as const;

describe("buildGitActionProgressStages", () => {
  it("returns a single push stage for push", () => {
    expect(buildGitActionProgressStages({ ...baseInput, action: "push" })).toEqual(["Pushing..."]);
  });

  it("returns a single merge stage for merge_pr", () => {
    expect(buildGitActionProgressStages({ ...baseInput, action: "merge_pr" })).toEqual([
      "Merging PR...",
    ]);
  });

  it("returns a single ready stage for ready_pr", () => {
    expect(buildGitActionProgressStages({ ...baseInput, action: "ready_pr" })).toEqual([
      "Marking PR ready for review...",
    ]);
  });

  it("ignores commit/push inputs for ready_pr", () => {
    expect(
      buildGitActionProgressStages({
        ...baseInput,
        action: "ready_pr",
        hasCustomCommitMessage: true,
        hasWorkingTreeChanges: true,
        pushTarget: "origin",
        featureBranch: true,
        shouldPushBeforePr: true,
      }),
    ).toEqual(["Marking PR ready for review..."]);
  });
});
