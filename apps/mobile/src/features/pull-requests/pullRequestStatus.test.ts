import type { PullRequestActivity, PullRequestCheck, PullRequestComment } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { pullRequestChecksSummary, pullRequestReviewSummary } from "./pullRequestStatus";

const author = { login: "julius", name: null, avatarUrl: null };
function review(state: string, at: string): PullRequestComment {
  return {
    id: `${state}:${at}`,
    kind: "review",
    author,
    body: "",
    createdAt: at,
    url: null,
    path: null,
    reviewState: state,
  };
}
function activity(
  comments: readonly PullRequestComment[],
): Pick<PullRequestActivity, "comments" | "commits"> {
  return { comments, commits: [] };
}
function check(status: PullRequestCheck["status"]): PullRequestCheck {
  return { name: status, status, url: null, description: null };
}

describe("mobile overview review status", () => {
  it("shows a current approval without a review comment, even after a push, and clears a reset", () => {
    const data = {
      comments: [review("APPROVED", "2026-10-10T09:00:00Z")],
      commits: [{ oid: "abc", messageHeadline: "Update", committedDate: "2026-10-10T10:00:00Z" }],
    };
    expect(
      pullRequestReviewSummary(
        { reviewers: [{ ...author, reviewState: "approved" }] },
        { ...data, comments: [] },
      ),
    ).toMatchObject({ title: "Approved by julius", count: "1 approved" });
    expect(
      pullRequestReviewSummary({ reviewers: [{ ...author, reviewState: "none" }] }, data),
    ).toMatchObject({ title: "Awaiting review", reviews: [] });
  });

  it.each([
    ["approved-with-suggestions", "Approved with suggestions", "1 approved"],
    ["waiting-for-author", "Waiting for author", "1 reviewer"],
    ["rejected", "Rejected", "1 reviewer"],
  ] as const)("keeps the meaning of %s", (reviewState, label, count) => {
    expect(
      pullRequestReviewSummary({ reviewers: [{ ...author, reviewState }] }, null),
    ).toMatchObject({ count, reviews: [{ label }] });
  });

  it("uses each reviewer's latest verdict even when history arrives out of order", () => {
    const result = pullRequestReviewSummary(
      { reviewers: [] },
      activity([
        review("CHANGES_REQUESTED", "2026-10-10T10:00:00Z"),
        review("APPROVED", "2026-10-10T09:00:00Z"),
      ]),
    );
    expect(result.title).toBe("Changes requested");
    expect(result.reviews).toHaveLength(1);
  });

  it("does not claim a dismissed approval or an approval preceding the latest commit", () => {
    const approved = review("APPROVED", "2026-10-10T09:00:00Z");
    expect(
      pullRequestReviewSummary(
        { reviewers: [] },
        activity([approved, review("DISMISSED", "2026-10-10T10:00:00Z")]),
      ).reviews,
    ).toEqual([]);
    const result = pullRequestReviewSummary(
      { reviewers: [author] },
      {
        comments: [approved],
        commits: [
          { oid: "abc123", messageHeadline: "Update", committedDate: "2026-10-10T10:00:00Z" },
        ],
      },
    );
    expect(result.title).toBe("Awaiting review");
  });

  it("keeps an approval when a later review only comments, and normalizes provider spelling", () => {
    const result = pullRequestReviewSummary(
      { reviewers: [] },
      activity([
        review("approved", "2026-10-10T09:00:00Z"),
        review("COMMENTED", "2026-10-10T10:00:00Z"),
      ]),
    );
    expect(result.title).toBe("Approved by julius");
    expect(result.reviews).toHaveLength(1);
    expect(
      pullRequestReviewSummary(
        { reviewers: [] },
        activity([review("changes-requested", "2026-10-10T11:00:00Z")]),
      ).title,
    ).toBe("Changes requested");
  });
});

describe("mobile overview check status", () => {
  it("does not claim a pending check has started running", () => {
    expect(pullRequestChecksSummary({ checks: [check("pending")] })).toMatchObject({
      title: "Checks pending",
      count: "1 pending",
    });
  });
  it("excludes skipped checks from passing totals", () => {
    expect(pullRequestChecksSummary({ checks: [check("success"), check("success")] }).title).toBe(
      "All checks passed",
    );
    expect(
      pullRequestChecksSummary({ checks: [check("success"), check("skipped")] }),
    ).toMatchObject({
      label: "1 of 1 passed",
      title: "All checks passed",
      count: "1 of 1",
    });
    expect(
      pullRequestChecksSummary({ checks: [check("failure"), check("skipped")] }),
    ).toMatchObject({
      title: "1 check failing",
      count: "0 of 1",
    });
    expect(pullRequestChecksSummary({ checks: [check("skipped")] })).toMatchObject({
      label: "All checks skipped",
      title: "All checks skipped",
      count: undefined,
    });
    expect(pullRequestChecksSummary({ checks: [] }).title).toBe("No checks reported");
  });

  it("excludes skipped checks from completed totals", () => {
    expect(
      pullRequestChecksSummary({ checks: [check("neutral"), check("skipped")] }),
    ).toMatchObject({
      label: "1 completed",
      title: "Checks completed",
    });
  });

  it("prioritizes failed checks while others are running", () => {
    expect(
      pullRequestChecksSummary({ checks: [check("success"), check("pending"), check("failure")] }),
    ).toMatchObject({ title: "1 check failing", count: "1 of 3" });
  });
});
