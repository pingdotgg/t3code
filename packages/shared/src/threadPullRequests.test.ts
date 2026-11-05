import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isPullRequestIdentityQuery,
  matchThreadSearchPullRequest,
  threadMatchesPullRequestListFilters,
  threadPullRequestMatchesIdentity,
} from "./threadPullRequests.ts";

function snapshot(input: Partial<ThreadPullRequestSnapshot> = {}): ThreadPullRequestSnapshot {
  return {
    state: "open",
    title: "Change",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function link(
  number: number,
  input: Partial<Omit<ThreadPullRequestLink, "number">> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: snapshot(),
    stack: null,
    ...input,
  };
}

describe("threadPullRequestMatchesIdentity", () => {
  it("matches number, repository, and URL prefixes without cutting a longer number", () => {
    const pr = link(22889);
    expect(threadPullRequestMatchesIdentity(pr, { number: 22889 })).toBe(true);
    expect(threadPullRequestMatchesIdentity(pr, { number: 2288 })).toBe(false);
    expect(threadPullRequestMatchesIdentity(pr, { number: 22889, repository: "Acme/App" })).toBe(
      true,
    );
    expect(threadPullRequestMatchesIdentity(pr, { number: 22889, repository: "other/app" })).toBe(
      false,
    );
    expect(
      threadPullRequestMatchesIdentity(pr, {
        url: "https://github.com/acme/app/pull/22889/files",
      }),
    ).toBe(true);
    expect(
      threadPullRequestMatchesIdentity(pr, {
        url: "https://github.com/acme/app/pull/2288",
      }),
    ).toBe(false);
  });
});

describe("threadMatchesPullRequestListFilters", () => {
  it("filters by presence, state, and identity; unsynced state never matches states", () => {
    const open = link(1, { snapshot: snapshot({ state: "open" }) });
    const merged = link(2, { snapshot: snapshot({ state: "merged" }) });
    const unsynced = link(3, { snapshot: null });
    const dismissed = link(4, { source: "stack-dismissed", snapshot: snapshot({ state: "open" }) });

    expect(threadMatchesPullRequestListFilters([open], { hasPullRequest: true })).toBe(true);
    expect(threadMatchesPullRequestListFilters([], { hasPullRequest: true })).toBe(false);
    expect(threadMatchesPullRequestListFilters([dismissed], { hasPullRequest: true })).toBe(false);
    expect(threadMatchesPullRequestListFilters([], { hasPullRequest: false })).toBe(true);

    expect(
      threadMatchesPullRequestListFilters([open, merged], { pullRequestStates: ["open"] }),
    ).toBe(true);
    expect(threadMatchesPullRequestListFilters([merged], { pullRequestStates: ["open"] })).toBe(
      false,
    );
    expect(threadMatchesPullRequestListFilters([unsynced], { pullRequestStates: ["open"] })).toBe(
      false,
    );

    expect(
      threadMatchesPullRequestListFilters([open, merged], { pullRequest: { number: 2 } }),
    ).toBe(true);
    expect(threadMatchesPullRequestListFilters([open], { pullRequest: { number: 2 } })).toBe(false);
  });
});

describe("pull request identity search helpers", () => {
  it("detects number, repo#n, and pull URL queries", () => {
    expect(isPullRequestIdentityQuery("22889")).toBe(true);
    expect(isPullRequestIdentityQuery("#22889")).toBe(true);
    expect(isPullRequestIdentityQuery("pr 22889")).toBe(true);
    expect(isPullRequestIdentityQuery("acme/app#22889")).toBe(true);
    expect(isPullRequestIdentityQuery("https://github.com/acme/app/pull/22889")).toBe(true);
    expect(isPullRequestIdentityQuery("open auth")).toBe(false);
  });

  it("matches linked PRs by number and reference, not by title text", () => {
    const pullRequests = [
      {
        number: 22889,
        title: "Trim model lists",
        references: ["acme/app#22889", "https://github.com/acme/app/pull/22889"],
      },
    ];
    expect(matchThreadSearchPullRequest("22889", pullRequests)).toEqual({
      number: 22889,
      repository: "acme/app",
      url: "https://github.com/acme/app/pull/22889",
    });
    expect(
      matchThreadSearchPullRequest("https://github.com/acme/app/pull/22889/files", pullRequests),
    ).toEqual({
      number: 22889,
      repository: "acme/app",
      url: "https://github.com/acme/app/pull/22889",
    });
    expect(matchThreadSearchPullRequest("trim model", pullRequests)).toBeNull();
    expect(matchThreadSearchPullRequest("2288", pullRequests)).toBeNull();
  });
});
