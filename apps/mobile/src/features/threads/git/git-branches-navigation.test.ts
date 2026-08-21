import { describe, expect, it } from "vite-plus/test";

import { shouldCloseGitBranchesSheetAfterCreate } from "./git-branches-navigation";

describe("shouldCloseGitBranchesSheetAfterCreate", () => {
  it.each([
    ["keeps a failed stack-step form open", "stack-step", null, false],
    ["closes after a successful stack step", "stack-step", {}, true],
    ["keeps normal branch behavior", "branch", null, true],
  ] as const)("%s", (_scenario, creationMode, creationResult, expected) => {
    expect(shouldCloseGitBranchesSheetAfterCreate(creationMode, creationResult)).toBe(expected);
  });
});
