import { describe, expect, it } from "vite-plus/test";

import {
  allowsSinglePullRequestMerge,
  pullRequestArmedAutoMergeLabel,
  pullRequestPendingAutoMergeLabel,
  pullRequestShowsAutoMerge,
  pullRequestShowsMergeNow,
  resolvePullRequestMergeMethod,
  resolvePullRequestPrimaryControl,
} from "./pullRequestMerge.ts";

describe("resolvePullRequestPrimaryControl", () => {
  const open = {
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    checksState: "passing" as const,
    autoMergeEnabled: false,
    hasMergeMethod: true,
    canMerge: true,
    canMarkReady: true,
    canEnableAutoMerge: true,
  };

  // regression: #9188 pending/failing checks offered Merge instead of auto-merge
  it("moves pending and failing checks to auto-merge", () => {
    expect(resolvePullRequestPrimaryControl({ ...open, checksState: "pending" })).toBe(
      "enable-auto-merge",
    );
    expect(resolvePullRequestPrimaryControl({ ...open, checksState: "failing" })).toBe(
      "enable-auto-merge",
    );
  });

  it("does not offer auto-merge while the host state is unknown", () => {
    expect(
      resolvePullRequestPrimaryControl({
        ...open,
        checksState: "pending",
        autoMergeEnabled: undefined,
      }),
    ).toBe("merge");
  });

  it("keeps merge when checks pass", () => {
    expect(resolvePullRequestPrimaryControl(open)).toBe("merge");
  });

  it("shows armed auto-merge ahead of checks", () => {
    expect(resolvePullRequestPrimaryControl({ ...open, autoMergeEnabled: true })).toBe(
      "auto-merge-armed",
    );
  });
});

describe("allowsSinglePullRequestMerge", () => {
  it.each([
    [false, true, false, null, true],
    [false, false, true, null, true],
    [true, false, true, null, false],
    [true, false, false, "Lookup failed", false],
    [true, true, false, null, false],
    [true, false, false, null, true],
  ] as const)(
    "capability=%s stack=%s pending=%s error=%s permits=%s",
    (supportsStackActions, hasStack, stackPending, stackError, allowed) => {
      expect(
        allowsSinglePullRequestMerge({ supportsStackActions, hasStack, stackPending, stackError }),
      ).toBe(allowed);
    },
  );
});

describe("resolvePullRequestMergeMethod", () => {
  it("prefers the current selection, then project default, then last selected", () => {
    expect(resolvePullRequestMergeMethod(["merge", "squash"], "squash", "rebase", "merge")).toBe(
      "squash",
    );
    expect(resolvePullRequestMergeMethod(["merge", "squash"], null, "squash", "merge")).toBe(
      "squash",
    );
    expect(resolvePullRequestMergeMethod(["merge", "squash"], null, "rebase", "merge")).toBe(
      "merge",
    );
    expect(resolvePullRequestMergeMethod(["rebase"], null, undefined, "squash")).toBe("rebase");
  });
});

describe("pull request merge menu visibility", () => {
  const open = {
    canMergeSingle: true,
    state: "open" as const,
    canMerge: true,
    isDraft: false,
    conflicting: false,
    hasMergeMethod: true,
  };

  it("offers merge now while auto-merge is primary or armed", () => {
    expect(pullRequestShowsMergeNow({ ...open, primaryAction: "enable-auto-merge" })).toBe(true);
    expect(pullRequestShowsMergeNow({ ...open, primaryAction: "auto-merge-armed" })).toBe(true);
    expect(pullRequestShowsMergeNow({ ...open, primaryAction: "merge" })).toBe(false);
  });

  it("offers enable auto-merge only when merge is still the primary control", () => {
    expect(
      pullRequestShowsAutoMerge({
        ...open,
        autoMergeArmed: false,
        canDisableAutoMerge: false,
        canEnableAutoMerge: true,
        primaryAction: "merge",
      }),
    ).toBe(true);
    expect(
      pullRequestShowsAutoMerge({
        ...open,
        autoMergeArmed: false,
        canDisableAutoMerge: false,
        canEnableAutoMerge: true,
        primaryAction: "enable-auto-merge",
      }),
    ).toBe(false);
    expect(
      pullRequestShowsAutoMerge({
        ...open,
        autoMergeArmed: true,
        canDisableAutoMerge: true,
        canEnableAutoMerge: false,
        primaryAction: "auto-merge-armed",
      }),
    ).toBe(true);
  });

  it("keeps disable available on stacks and conflicting armed pull requests", () => {
    expect(
      pullRequestShowsAutoMerge({
        ...open,
        canMergeSingle: false,
        conflicting: true,
        autoMergeArmed: true,
        canDisableAutoMerge: true,
        canEnableAutoMerge: false,
        primaryAction: "resolve",
      }),
    ).toBe(true);
    expect(
      pullRequestShowsAutoMerge({
        ...open,
        canMergeSingle: false,
        autoMergeArmed: false,
        canDisableAutoMerge: false,
        canEnableAutoMerge: true,
        primaryAction: "merge",
      }),
    ).toBe(false);
  });
});

describe("auto-merge labels", () => {
  it("lowercases the selected merge method label", () => {
    expect(pullRequestPendingAutoMergeLabel("Squash and merge")).toBe(
      "Auto-merge (squash and merge)",
    );
    expect(pullRequestArmedAutoMergeLabel("squash")).toBe("Auto-merge (squash and merge)");
    expect(pullRequestArmedAutoMergeLabel(undefined)).toBe("Auto-merge");
  });
});
