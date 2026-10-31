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
  it("prioritizes failed checks while others are running", () => {
    expect(
      pullRequestChecksSummary({ checks: [check("success"), check("pending"), check("failure")] }),
    ).toMatchObject({ title: "1 check failing", count: "1 of 3" });
  });
});
