import { describe, expect, it } from "vite-plus/test";
import type { PullRequestActivity, PullRequestReviewThread } from "@t3tools/contracts";

import { settledReviewSummary } from "./pullRequestReviewGuideInput.ts";

const thread = (
  overrides: Partial<PullRequestReviewThread> & { body?: string; login?: string },
): PullRequestReviewThread => ({
  id: overrides.id ?? "t1",
  path: overrides.path ?? "src/a.ts",
  line: 1,
  side: "right",
  isResolved: overrides.isResolved ?? false,
  isOutdated: overrides.isOutdated ?? false,
  comments: [
    {
      id: "c1",
      author: { login: overrides.login ?? "macroscope[bot]", name: null, avatarUrl: null },
      body: overrides.body ?? "Possible null dereference",
      createdAt: "2026-10-01T00:00:00.000Z",
      url: null,
    },
  ],
});

const activity = (reviewThreads: ReadonlyArray<PullRequestReviewThread>): PullRequestActivity => ({
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads,
  commits: [],
});

describe("settledReviewSummary", () => {
  it("lists resolved and outdated threads and leaves open ones for the guide", () => {
    const summary = settledReviewSummary(
      activity([
        thread({ id: "open", path: "src/open.ts", body: "Still open" }),
        thread({ id: "resolved", path: "src/a.ts", isResolved: true }),
        thread({
          id: "outdated",
          path: "src/b.ts",
          isOutdated: true,
          login: "julius",
          body: "Rename this <!-- bot:meta -->\n\nplease",
        }),
      ]),
    );

    expect(summary).toBe(
      [
        "- src/a.ts (resolved, macroscope[bot]): Possible null dereference",
        "- src/b.ts (outdated, julius): Rename this please",
      ].join("\n"),
    );
  });
});
