import type { ThreadPullRequestLink, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveLinkedPullRequestHeaderAction,
  withLinkedPullRequest,
} from "./linkedPullRequestStatus";

const status = { isRepo: true, refName: "fork-branch", pr: null } as unknown as VcsStatusResult;

function link(
  number: number,
  snapshot: Partial<NonNullable<ThreadPullRequestLink["snapshot"]>> | null = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-09-08T00:00:00.000Z",
    stack: null,
    snapshot:
      snapshot === null
        ? null
        : {
            state: "open",
            title: `Change ${number}`,
            headBranch: `change-${number}`,
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-09-08T00:00:00.000Z",
            ...snapshot,
          },
  };
}

describe("withLinkedPullRequest", () => {
  it("offers the linked pull request when the checkout's ref has none", () => {
    expect(withLinkedPullRequest(status, [link(7)])?.pr).toMatchObject({
      number: 7,
      url: "https://github.com/t3tools/t3code/pull/7",
      state: "open",
      headRef: "change-7",
      baseRef: "main",
    });
  });

  it("treats a link awaiting its first sync as open", () => {
    expect(withLinkedPullRequest(status, [link(7, null)])?.pr).toMatchObject({
      number: 7,
      state: "open",
    });
  });

  it("keeps the ref-derived open pull request", () => {
    const open = { ...status, pr: { number: 3, state: "open" } } as unknown as VcsStatusResult;
    expect(withLinkedPullRequest(open, [link(7)])).toBe(open);
  });

  it("ignores links that are no longer open", () => {
    expect(withLinkedPullRequest(status, [link(7, { state: "merged" })])).toBe(status);
  });

  it("passes through a missing status or no links", () => {
    expect(withLinkedPullRequest(null, [link(7)])).toBeNull();
    expect(withLinkedPullRequest(status, undefined)).toBe(status);
    expect(withLinkedPullRequest(status, [])).toBe(status);
  });
});

describe("resolveLinkedPullRequestHeaderAction", () => {
  it("opens the only linked pull request directly", () => {
    expect(resolveLinkedPullRequestHeaderAction([link(7)])).toEqual({
      kind: "open",
      label: "Open pull request #7",
      url: "https://github.com/t3tools/t3code/pull/7",
    });
  });

  it("lists several linked pull requests", () => {
    expect(resolveLinkedPullRequestHeaderAction([link(7), link(8)])).toEqual({
      kind: "list",
      label: "Linked pull requests (2)",
    });
  });

  it("offers nothing without a visible link", () => {
    expect(resolveLinkedPullRequestHeaderAction(undefined)).toBeNull();
    expect(resolveLinkedPullRequestHeaderAction([])).toBeNull();
    expect(
      resolveLinkedPullRequestHeaderAction([{ ...link(7), source: "stack-dismissed" }]),
    ).toBeNull();
  });
});
