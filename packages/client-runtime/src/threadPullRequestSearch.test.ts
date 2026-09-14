import { type ThreadPullRequestLink, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createThreadPullRequestMatcher } from "./threadPullRequestSearch.ts";

const pr = {
  projectId: ProjectId.make("project"),
  repository: "owner/repo",
  number: 123,
  url: "https://github.com/owner/repo/pull/123",
};

describe("createThreadPullRequestMatcher", () => {
  it.each(["123", "#123", " #123 "])("matches either stored PR with %s", (query) => {
    const matches = createThreadPullRequestMatcher(query);
    expect(matches({ linkedPullRequest: pr })).toBe(true);
    expect(matches({ branchPullRequest: pr })).toBe(true);
    expect(matches({ linkedPullRequest: { ...pr, number: 456 }, branchPullRequest: pr })).toBe(
      true,
    );
  });
  it.each(["", " ", "12", "#12", "1234", "#1234", "fix 123", "garbage"])(
    "does not match unrelated or partial queries: %s",
    (query) => expect(createThreadPullRequestMatcher(query)({ linkedPullRequest: pr })).toBe(false),
  );
  it("handles threads with no PR and single-digit PRs", () => {
    const matches = createThreadPullRequestMatcher("#1");
    expect(matches({})).toBe(false);
    expect(matches({ linkedPullRequest: null, branchPullRequest: null })).toBe(false);
    expect(matches({ branchPullRequest: { ...pr, number: 1 } })).toBe(true);
  });
});

const link: ThreadPullRequestLink = {
  host: "github.com",
  repository: "owner/repo",
  number: 123,
  url: pr.url,
  source: "manual",
  linkedAt: "2026-09-14T00:00:00Z",
  snapshot: null,
  stack: null,
};

it("matches any visible link, excluding dismissed links and stale legacy projections", () => {
  const thread = {
    pullRequests: [link, { ...link, number: 456, url: "https://github.com/owner/repo/pull/456" }],
    linkedPullRequest: { ...pr, number: 789 },
  };
  expect(createThreadPullRequestMatcher("#456")(thread)).toBe(true);
  expect(createThreadPullRequestMatcher("12")(thread)).toBe(false);
  expect(createThreadPullRequestMatcher("789")(thread)).toBe(false);
  expect(
    createThreadPullRequestMatcher("123")({
      pullRequests: [{ ...link, source: "stack-dismissed" }],
      linkedPullRequest: pr,
    }),
  ).toBe(false);
});

it("preserves upstream's nonnumeric PR metadata search", () => {
  for (const query of ["owner/repo#123", pr.url]) {
    expect(createThreadPullRequestMatcher(query)({ pullRequests: [link] })).toBe(true);
  }
});

it("matches a branch PR alongside a different manually linked PR", () => {
  const thread = { pullRequests: [link], branchPullRequest: { ...pr, number: 456 } };
  expect(createThreadPullRequestMatcher("456")(thread)).toBe(true);
  expect(createThreadPullRequestMatcher("#456")(thread)).toBe(true);
  expect(createThreadPullRequestMatcher("45")(thread)).toBe(false);
});

it("matches a candidate by its saved title without a legacy projection", () => {
  const candidate = {
    ...link,
    snapshot: {
      state: "merged" as const,
      title: "Improve rendering speed",
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-09-14T00:00:00Z",
    },
  };
  expect(createThreadPullRequestMatcher("rendering")({ pullRequests: [candidate] })).toBe(true);
  expect(createThreadPullRequestMatcher("unrelated")({ pullRequests: [candidate] })).toBe(false);
});
