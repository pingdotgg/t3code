import type { GitRunStackedActionResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commitSummary } from "./commitSummary";

const result = (overrides: Partial<GitRunStackedActionResult>): GitRunStackedActionResult => ({
  action: "commit",
  branch: { status: "skipped_not_requested" },
  commit: { status: "skipped_not_requested" },
  push: { status: "skipped_not_requested" },
  pr: { status: "skipped_not_requested" },
  toast: { title: "Done", cta: { kind: "none" } },
  ...overrides,
});

describe("commitSummary", () => {
  it("Given a commit that was pushed and opened a PR, when it is summarized, then each step is named", () => {
    const text = commitSummary(
      "T-1 worktree",
      result({
        action: "commit_push_pr",
        commit: { status: "created", commitSha: "0123456789abcdef", subject: "Add the panel" },
        push: { status: "pushed", upstreamBranch: "origin/feat/t-1" },
        pr: { status: "created", number: 12, url: "https://example.test/pull/12" },
      }),
    );

    expect(text).toBe(
      'I committed 0123456 "Add the panel", pushed origin/feat/t-1, opened PR #12 (https://example.test/pull/12) in T-1 worktree.',
    );
  });

  it("Given a push with nothing to commit, when it is summarized, then it says nothing was committed", () => {
    const text = commitSummary(
      "T-1 worktree",
      result({
        action: "commit_push",
        commit: { status: "skipped_no_changes" },
        push: { status: "pushed", branch: "feat/t-1" },
      }),
    );

    expect(text).toBe("I found nothing new to commit, pushed feat/t-1 in T-1 worktree.");
  });
});
