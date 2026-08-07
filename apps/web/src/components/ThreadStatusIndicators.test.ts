import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  prStatusIndicator,
  selectBranchPr,
  settledPrHoverColorClass,
} from "./ThreadStatusIndicators";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/current",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: {
      number: 42,
      title: "PR branch",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRef: "main",
      headRef: "feature/current",
      state: "open",
    },
    ...overrides,
  };
}

const otherBranchPr = {
  number: 7,
  title: "Branch-keyed PR",
  url: "https://github.com/pingdotgg/t3code/pull/7",
  baseRef: "main",
  headRef: "feature/other",
  state: "open",
} as const;

describe("selectBranchPr", () => {
  it("shows the PR when the live checkout matches the requested branch", () => {
    const gitStatus = status();

    expect(selectBranchPr({ branch: "feature/current", gitStatus, branchPr: undefined })).toBe(
      gitStatus.pr,
    );
  });

  it("falls back to the branch-keyed lookup when the checkout moved elsewhere", () => {
    expect(
      selectBranchPr({
        branch: "feature/other",
        gitStatus: status(),
        branchPr: otherBranchPr,
      }),
    ).toBe(otherBranchPr);
  });

  it("treats an empty PR on the matching checkout as authoritative", () => {
    // Regression: a warm branch-keyed result must not resurrect a badge the
    // status stream just cleared (e.g. immediately after a merge).
    expect(
      selectBranchPr({
        branch: "feature/current",
        gitStatus: status({ pr: null }),
        branchPr: otherBranchPr,
      }),
    ).toBeNull();
  });

  it("returns nothing when the branch is unknown and no lookup resolved", () => {
    expect(selectBranchPr({ branch: null, gitStatus: status(), branchPr: undefined })).toBeNull();
  });

  it("returns nothing while the branch-keyed lookup is unresolved", () => {
    expect(
      selectBranchPr({ branch: "feature/other", gitStatus: status(), branchPr: undefined }),
    ).toBeNull();
  });
});

describe("prStatusIndicator", () => {
  it("formats PR tooltips with number, uppercase status, and title", () => {
    expect(prStatusIndicator(status().pr, undefined)).toMatchObject({
      tooltip: "PR #42 - Open: PR branch",
      tooltipLead: "PR #42 - Open",
      tooltipTitle: "PR branch",
    });
  });

  it("uses red for closed pull requests", () => {
    const closedPr = status().pr;
    if (!closedPr) throw new Error("Expected pull request fixture");

    expect(prStatusIndicator({ ...closedPr, state: "closed" }, undefined)?.colorClass).toContain(
      "text-red-600",
    );
  });
});

describe("settledPrHoverColorClass", () => {
  it.each([
    ["open", "text-emerald-600"],
    ["merged", "text-violet-600"],
    ["closed", "text-red-600"],
  ] as const)("restores the %s pull request color on row hover", (state, colorClass) => {
    expect(settledPrHoverColorClass(state)).toContain(`group-hover/v2-row:${colorClass}`);
  });
});
