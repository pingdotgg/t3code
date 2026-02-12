import { describe, expect, it } from "vitest";

import {
  gitRunStackedActionInputSchema,
  gitRunStackedActionResultSchema,
  gitStackedActionSchema,
  gitStatusInputSchema,
  gitStatusResultSchema,
} from "./git";

describe("git contracts", () => {
  it("parses git status input and trims cwd", () => {
    const parsed = gitStatusInputSchema.parse({ cwd: "  /tmp/repo  " });
    expect(parsed.cwd).toBe("/tmp/repo");
  });

  it("parses git status result", () => {
    const parsed = gitStatusResultSchema.parse({
      branch: "feature/git-actions",
      hasWorkingTreeChanges: true,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
    });
    expect(parsed.branch).toBe("feature/git-actions");
    expect(parsed.hasWorkingTreeChanges).toBe(true);
  });

  it("accepts supported stacked actions", () => {
    expect(gitStackedActionSchema.parse("commit")).toBe("commit");
    expect(gitStackedActionSchema.parse("commit_push")).toBe("commit_push");
    expect(gitStackedActionSchema.parse("commit_push_pr")).toBe(
      "commit_push_pr",
    );
  });

  it("parses stacked action input", () => {
    const parsed = gitRunStackedActionInputSchema.parse({
      cwd: "/tmp/repo",
      action: "commit_push",
    });
    expect(parsed.action).toBe("commit_push");
  });

  it("parses stacked action result with metadata", () => {
    const parsed = gitRunStackedActionResultSchema.parse({
      action: "commit_push_pr",
      commit: {
        status: "created",
        commitSha: "abc123",
        subject: "Implement stacked git actions",
      },
      push: {
        status: "pushed",
        branch: "feature/git-actions",
        upstreamBranch: "origin/feature/git-actions",
        setUpstream: true,
      },
      pr: {
        status: "created",
        url: "https://github.com/pingdotgg/codething-mvp/pull/123",
        number: 123,
        baseBranch: "main",
        headBranch: "feature/git-actions",
        title: "Add stacked git actions workflow",
      },
    });

    expect(parsed.commit.status).toBe("created");
    expect(parsed.pr.number).toBe(123);
  });
});

