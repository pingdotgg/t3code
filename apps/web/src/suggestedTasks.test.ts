import { describe, expect, it } from "vite-plus/test";

import { buildIssueTriageTask, buildPullRequestTask } from "./suggestedTasks";

describe("suggested task builders", () => {
  it("builds a PR-specific thread title and editable review prompt", () => {
    const task = buildPullRequestTask({
      number: 42,
      title: "Improve the draft page",
      url: "https://github.com/acme/app/pull/42",
      baseBranch: "main",
      headBranch: "feature/draft-page",
      state: "open",
    });

    expect(task.title).toBe("PR #42 · Improve the draft page");
    expect(task.prompt).toContain("Review PR #42");
    expect(task.prompt).toContain("Do not make changes");
  });

  it("builds an analysis-only issue triage prompt", () => {
    const task = buildIssueTriageTask({
      number: 84,
      title: "Sidebar freezes",
      url: "https://github.com/acme/app/issues/84",
      state: "open",
      labels: ["bug"],
      assignees: [],
    });

    expect(task.title).toBe("Triage #84 · Sidebar freezes");
    expect(task.prompt).toContain("reproduction steps");
    expect(task.prompt).toContain("Do not implement changes yet");
  });
});
