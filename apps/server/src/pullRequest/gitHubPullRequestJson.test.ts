import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import {
  decodePullRequestSearchJson,
  pullRequestSearchGraphQlQuery,
} from "./gitHubPullRequestJson.ts";

describe("GitHub pull request search JSON", () => {
  it("preserves a team review request from the server-selected reviewing query", () => {
    const decoded = decodePullRequestSearchJson(
      JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                number: 42,
                title: "Review me  ",
                url: "https://github.com/acme/web/pull/42",
                author: { login: "octocat" },
                headRefName: "feature/review",
                baseRefName: "main",
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                createdAt: "2026-08-10T00:00:00Z",
                updatedAt: "2026-08-10T01:00:00Z",
                repository: { nameWithOwner: "acme/web" },
                reviewRequests: {
                  nodes: [{ requestedReviewer: { slug: "reviewers" } }],
                },
                labels: { nodes: [] },
              },
            ],
          },
        },
      }),
    );

    expect(Result.isSuccess(decoded)).toBe(true);
    if (!Result.isSuccess(decoded)) return;
    expect(decoded.success.items[0]?.hasTeamReviewRequest).toBe(true);
    expect(decoded.success.items[0]?.reviewRequestLogins).toEqual([]);
    expect(decoded.success.items[0]?.title).toBe("Review me");
    expect(pullRequestSearchGraphQlQuery(1)).toContain("... on Team { slug }");
  });
});
