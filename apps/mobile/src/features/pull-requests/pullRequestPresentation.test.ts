import { describe, expect, it } from "vite-plus/test";

import { formatDiffStat, resolvePullRequestState } from "./pullRequestPresentation";

describe("resolvePullRequestState", () => {
  it("ranks merged and closed above draft", () => {
    expect(resolvePullRequestState({ state: "merged", isDraft: true }).kind).toBe("merged");
    expect(resolvePullRequestState({ state: "closed", isDraft: true }).kind).toBe("closed");
  });

  it("names the base branch when the open pull request conflicts", () => {
    expect(
      resolvePullRequestState({
        state: "open",
        isDraft: false,
        mergeability: "conflicting",
        baseBranch: "main",
      }).label,
    ).toBe("Conflicts with main");
  });
});

describe("formatDiffStat", () => {
  it("omits a missing change set rather than drawing +0 −0", () => {
    expect(formatDiffStat(0, 0)).toBeNull();
    expect(formatDiffStat(12, 3)).toBe("+12 −3");
  });
});
