import type { ThreadPullRequestLink, ThreadPullRequestSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  openLinkedThreadPullRequests,
  settleClosePullRequestsMessage,
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
    repository: "pingdotgg/t3code",
    number,
    url: `https://github.com/pingdotgg/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: snapshot(),
    stack: null,
    ...input,
  };
}

describe("openLinkedThreadPullRequests", () => {
  it("keeps only visible links whose snapshot is open", () => {
    expect(
      openLinkedThreadPullRequests([
        link(1),
        link(2, { snapshot: snapshot({ state: "closed" }) }),
        link(3, { snapshot: snapshot({ state: "merged" }) }),
        link(4, { snapshot: null }),
        link(5, { source: "stack-dismissed" }),
      ]).map((entry) => entry.number),
    ).toEqual([1]);
  });

  it("treats a missing list as empty", () => {
    expect(openLinkedThreadPullRequests(undefined)).toEqual([]);
  });
});

describe("settleClosePullRequestsMessage", () => {
  it("names a single pull request", () => {
    expect(settleClosePullRequestsMessage(1)).toBe(
      "This thread has 1 open pull request.\n\nClose them when settling?",
    );
  });

  it("pluralizes several pull requests", () => {
    expect(settleClosePullRequestsMessage(3)).toBe(
      "This thread has 3 open pull requests.\n\nClose them when settling?",
    );
  });
});
