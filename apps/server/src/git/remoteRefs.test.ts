import { describe, expect, it } from "@effect/vitest";

import { extractBranchNameFromRemoteRef, parseRemoteRefWithRemoteNames } from "./remoteRefs.ts";

describe("remote ref parsing", () => {
  it.each([
    ["origin/feature/メモ\u3000", "feature/メモ\u3000"],
    ["origin/feature\u00a0", "feature\u00a0"],
    ["origin/\u00a0", "\u00a0"],
    ["  origin/main \n", "main"],
  ])("keeps Unicode whitespace in the branch name of %j", (ref, branchName) => {
    expect(parseRemoteRefWithRemoteNames(ref, ["origin"])?.branchName).toBe(branchName);
  });

  it.each([
    ["refs/remotes/origin/feature/メモ\u3000", "feature/メモ\u3000"],
    ["origin/feature\u00a0", "feature\u00a0"],
    ["refs/remotes/origin/\u3000", "\u3000"],
    ["refs/remotes/origin/main\n", "main"],
  ])("extracts the branch name of %j without trimming Unicode whitespace", (ref, branchName) => {
    expect(extractBranchNameFromRemoteRef(ref, { remoteNames: ["origin"] })).toBe(branchName);
  });

  it("keeps Unicode whitespace after the first slash when no remote matches", () => {
    expect(extractBranchNameFromRemoteRef("origin/\u00a0")).toBe("\u00a0");
  });
});
