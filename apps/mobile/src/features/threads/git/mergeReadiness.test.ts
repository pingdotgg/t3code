import { describe, expect, it } from "vite-plus/test";

import type { VcsStatusResult } from "@t3tools/contracts";

import { isMergeReady } from "./mergeReadiness";

function statusWith(
  pr: Partial<NonNullable<VcsStatusResult["pr"]>> | null,
): VcsStatusResult | null {
  if (pr === null) {
    return { pr: null } as VcsStatusResult;
  }
  return {
    pr: {
      number: 1,
      title: "Ship it",
      url: "https://github.com/SergeSerb2/SergeCode/pull/1",
      baseRef: "main",
      headRef: "feat/merge",
      state: "open",
      reviewDecision: "APPROVED",
      unresolvedReviewThreadCount: 0,
      ...pr,
    },
  } as VcsStatusResult;
}

describe("isMergeReady", () => {
  it("is ready when open, approved, and all threads resolved", () => {
    expect(isMergeReady(statusWith({}))).toBe(true);
  });

  it("is ready when review decision is null and all threads are resolved", () => {
    expect(isMergeReady(statusWith({ reviewDecision: null, unresolvedReviewThreadCount: 0 }))).toBe(
      true,
    );
  });

  it("is not ready when review is required", () => {
    expect(
      isMergeReady(
        statusWith({ reviewDecision: "REVIEW_REQUIRED", unresolvedReviewThreadCount: 0 }),
      ),
    ).toBe(false);
  });

  it("is not ready when review decision is CHANGES_REQUESTED", () => {
    expect(
      isMergeReady(
        statusWith({ reviewDecision: "CHANGES_REQUESTED", unresolvedReviewThreadCount: 0 }),
      ),
    ).toBe(false);
  });

  it("is not ready when unresolved threads remain", () => {
    expect(
      isMergeReady(statusWith({ reviewDecision: "APPROVED", unresolvedReviewThreadCount: 2 })),
    ).toBe(false);
  });

  it("is not ready when unresolved thread count is unknown", () => {
    expect(
      isMergeReady(statusWith({ reviewDecision: "APPROVED", unresolvedReviewThreadCount: null })),
    ).toBe(false);
  });

  it("is not ready when the PR is not open", () => {
    expect(isMergeReady(statusWith({ state: "merged" }))).toBe(false);
    expect(isMergeReady(statusWith({ state: "closed" }))).toBe(false);
  });

  it("is not ready when there is no PR", () => {
    expect(isMergeReady(statusWith(null))).toBe(false);
    expect(isMergeReady(null)).toBe(false);
  });
});
