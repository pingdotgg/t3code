import { describe, expect, it } from "vite-plus/test";

import {
  appendIssueContext,
  issueBranchName,
  issueNumberFromBranch,
  formatCommentCount,
  issueContextForComposer,
  labelColor,
  narrowIssues,
  sortIssues,
} from "./issuesPanel.logic";

const issue = (overrides: Partial<Parameters<typeof sortIssues>[0][number]> = {}) =>
  ({
    tracker: "forgejo",
    host: "git.example.org",
    projectId: "00000000-0000-4000-8000-000000000000",
    projectTitle: "web",
    scope: "acme/web",
    displayKey: "#1",
    key: "1",
    title: "Cache is never invalidated",
    url: "https://git.example.org/acme/web/issues/1",
    author: { login: "bilal", name: null, avatarUrl: null },
    state: { category: "open", name: "open" },
    createdAt: "2026-06-16T05:00:00Z",
    updatedAt: "2026-06-16T05:00:00Z",
    commentCount: 0,
    closedAt: null,
    labels: [],
    assignees: [],
    ...overrides,
  }) as Parameters<typeof sortIssues>[0][number];

describe("sortIssues", () => {
  it("puts the most recently changed first", () => {
    const rows = sortIssues([
      issue({ key: "1", updatedAt: "2026-06-16T05:00:00Z" }),
      issue({ key: "2", updatedAt: "2026-06-17T05:00:00Z" }),
      issue({ key: "3", updatedAt: "2026-06-15T05:00:00Z" }),
    ]);
    expect(rows.map((row) => Number(row.key))).toEqual([2, 1, 3]);
  });
});

describe("sortIssues orders", () => {
  const rows = [
    issue({
      key: "1",
      createdAt: "2026-06-10T00:00:00Z",
      updatedAt: "2026-06-16T00:00:00Z",
      commentCount: 1,
    }),
    issue({
      key: "2",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-17T00:00:00Z",
      commentCount: 0,
    }),
    issue({
      key: "3",
      createdAt: "2026-06-20T00:00:00Z",
      updatedAt: "2026-06-15T00:00:00Z",
      commentCount: 9,
    }),
  ];

  it("puts the longest-standing first when asked for oldest", () => {
    expect(sortIssues(rows, "oldest").map((row) => Number(row.key))).toEqual([2, 1, 3]);
  });

  it("puts the most discussed first, breaking ties by recency", () => {
    expect(sortIssues(rows, "comments").map((row) => Number(row.key))).toEqual([3, 1, 2]);
  });
});

describe("narrowIssues", () => {
  const rows = [
    issue({ key: "1", title: "Cache is never invalidated" }),
    issue({ key: "42", title: "Sign in loops", labels: [{ name: "bug", color: null }] }),
  ];

  it("matches a title, a label, or the number itself", () => {
    expect(narrowIssues(rows, "cache").map((row) => Number(row.key))).toEqual([1]);
    expect(narrowIssues(rows, "bug").map((row) => Number(row.key))).toEqual([42]);
    expect(narrowIssues(rows, "#42").map((row) => Number(row.key))).toEqual([42]);
  });

  it("returns everything for an empty search", () => {
    expect(narrowIssues(rows, "   ")).toHaveLength(2);
  });
});

describe("formatCommentCount", () => {
  it("says nothing where the host reported no count", () => {
    // Zero means "not asked", which is what `gh issue list` answers with.
    expect(formatCommentCount(0)).toBeNull();
    expect(formatCommentCount(1)).toBe("1 comment");
    expect(formatCommentCount(4)).toBe("4 comments");
  });
});

describe("labelColor", () => {
  it("takes a hex triplet with or without its hash, and refuses anything else", () => {
    expect(labelColor("d73a4a")).toBe("#d73a4a");
    expect(labelColor("#d73a4a")).toBe("#d73a4a");
    expect(labelColor("f00")).toBe("#f00");
    expect(labelColor("red; background: url(x)")).toBeUndefined();
    expect(labelColor(null)).toBeUndefined();
  });
});

describe("issueContextForComposer", () => {
  const issue = {
    displayKey: "#12",
    title: "Cache is never invalidated",
    url: "https://git.example.org/acme/web/issues/12",
    state: { category: "open", name: "open" },
    scope: "acme/web",
    body: "It never clears.",
    comments: [{ author: { login: "octocat" }, body: "Confirmed" }],
  };

  it("carries the whole issue, because an agent cannot go and fetch it", () => {
    const context = issueContextForComposer(issue);
    expect(context).toContain("acme/web#12: Cache is never invalidated");
    expect(context).toContain("It never clears.");
    expect(context).toContain("Comment from octocat");
    expect(context).toContain("Confirmed");
  });

  it("says so rather than leaving a blank where there is no description", () => {
    expect(issueContextForComposer({ ...issue, body: "   ", comments: [] })).toContain(
      "_No description._",
    );
  });
});

describe("appendIssueContext", () => {
  it("keeps what was already typed", () => {
    expect(appendIssueContext("look at this", "## issue")).toBe("look at this\n\n## issue\n\n");
  });

  it("does not lead with blank lines in an empty composer", () => {
    expect(appendIssueContext("   ", "## issue")).toBe("## issue\n\n");
  });
});

describe("issueBranchName", () => {
  it("leads with the number so branches sort and grep by issue", () => {
    expect(issueBranchName({ key: "12", title: "Cache is never invalidated" })).toBe(
      "issue-12-cache-is-never-invalidated",
    );
  });

  it("falls back to the number alone when the title survives sanitising as nothing", () => {
    expect(issueBranchName({ key: "7", title: "!!!" })).toBe("issue-7");
  });
});

describe("issueNumberFromBranch", () => {
  it("reads the issue back out of a branch Start work named", () => {
    expect(issueNumberFromBranch(issueBranchName({ key: "12", title: "Cache bug" }))).toBe(12);
    expect(issueNumberFromBranch("issue-7")).toBe(7);
  });

  it("reads through a namespace, which a worktree branch may carry", () => {
    expect(issueNumberFromBranch("chris/issue-42-sign-in-loops")).toBe(42);
  });

  it("says nothing about a branch somebody named themselves", () => {
    expect(issueNumberFromBranch("feat/forgejo-provider")).toBeNull();
    expect(issueNumberFromBranch("issues-12")).toBeNull();
    expect(issueNumberFromBranch("issue-abc")).toBeNull();
    expect(issueNumberFromBranch(null)).toBeNull();
  });
});
