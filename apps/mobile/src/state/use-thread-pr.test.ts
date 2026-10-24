import { ProjectId, type ThreadPullRequestLink, type VcsStatusResult } from "@t3tools/contracts";
import { buildMenuItems } from "@t3tools/client-runtime/state/vcs";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import { describe, expect, it } from "vite-plus/test";

import {
  presentThreadLinkedPullRequests,
  resolveThreadPrSource,
  withThreadOpenPullRequest,
} from "./thread-pr-presentation";

function linkedPr(
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-09-08T00:00:00.000Z",
    stack: null,
    snapshot: {
      state: "open",
      title: `Change ${number}`,
      headBranch: `change-${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-09-08T00:00:00.000Z",
    },
    ...overrides,
  };
}

describe("presentThreadLinkedPullRequests", () => {
  it("uses the top of a derived stack even when its bottom was linked later", () => {
    const bottom = linkedPr(1, { linkedAt: "2026-09-09T00:00:00.000Z" });
    const top = linkedPr(2);
    expect(
      presentThreadLinkedPullRequests([
        bottom,
        {
          ...top,
          snapshot: { ...top.snapshot!, baseBranch: "change-1" },
        },
      ]),
    ).toMatchObject({ kind: "stack", label: "2", number: 2, url: top.url });
  });
});

describe("resolveThreadPrSource compatibility", () => {
  const legacyRef = {
    projectId: ProjectId.make("project"),
    repository: "t3tools/t3code",
    number: 1,
    url: "https://github.com/t3tools/t3code/pull/1",
  };
  const branchRef = { ...legacyRef, number: 2, url: "https://github.com/t3tools/t3code/pull/2" };

  it("polls the legacy reference when only the older linking capability exists", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("ignores stale snapshots after reconnecting to a server without array support", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef },
        { threadPullRequestLinking: true, threadPullRequests: false },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("uses snapshots without polling when both capabilities are advertised", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequestLinking: true, threadPullRequests: true },
      ),
    ).toMatchObject({ linkedPresentation: { number: 3 }, pullRequestRef: null });
  });

  it("does not revive a removed modern link from the compatibility reference", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        { threadPullRequests: true },
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: branchRef });
  });

  it("does not poll when a modern link is waiting for its first snapshot", () => {
    expect(
      resolveThreadPrSource(
        {
          pullRequests: [linkedPr(3, { snapshot: null })],
          linkedPullRequest: legacyRef,
          branchPullRequest: branchRef,
        },
        { threadPullRequests: true },
      ),
    ).toMatchObject({ linkedPresentation: { number: 3, state: null }, pullRequestRef: null });
  });
});

describe("withThreadOpenPullRequest", () => {
  const status: VcsStatusResult = {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "local-work",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 1,
    behindCount: 0,
    pr: null,
  };
  const prLabel = (next: VcsStatusResult | null) =>
    buildMenuItems(next, false).find((item) => item.id === "pr")?.label;

  it("offers the linked open pull request when the checkout's ref has none", () => {
    const next = withThreadOpenPullRequest(status, [linkedPr(42)], true);
    expect(next?.pr).toMatchObject({ number: 42, url: linkedPr(42).url, state: "open" });
    expect(prLabel(next)).toBe("View PR");
  });

  it("treats a link waiting for its first sync as open", () => {
    expect(
      withThreadOpenPullRequest(status, [linkedPr(42, { snapshot: null })], true)?.pr,
    ).toMatchObject({ number: 42, state: "open" });
  });

  it("keeps checkout status for a legacy link whose state the server cannot report", () => {
    const legacy = threadPullRequestsOf({
      linkedPullRequest: {
        projectId: ProjectId.make("project"),
        repository: "t3tools/t3code",
        number: 42,
        url: linkedPr(42).url,
      },
    });
    expect(withThreadOpenPullRequest(status, legacy, false)).toBe(status);
    expect(prLabel(withThreadOpenPullRequest(status, legacy, false))).toBe("Create PR");
  });

  it("keeps the checkout ref's own open pull request", () => {
    const own: VcsStatusResult = {
      ...status,
      pr: {
        number: 3,
        title: "Own change",
        url: "https://github.com/t3tools/t3code/pull/3",
        baseRef: "main",
        headRef: "local-work",
        state: "open",
      },
    };
    expect(withThreadOpenPullRequest(own, [linkedPr(42)], true)).toBe(own);
  });

  it("ignores links that are no longer open", () => {
    const merged = linkedPr(42, { snapshot: { ...linkedPr(42).snapshot!, state: "merged" } });
    const closed = linkedPr(43, { snapshot: { ...linkedPr(43).snapshot!, state: "closed" } });
    expect(withThreadOpenPullRequest(status, [merged, closed], true)).toBe(status);
    expect(prLabel(withThreadOpenPullRequest(status, [merged], true))).toBe("Create PR");
  });

  it("prefers an open link over a merged one", () => {
    const merged = linkedPr(41, {
      linkedAt: "2026-09-10T00:00:00.000Z",
      snapshot: { ...linkedPr(41).snapshot!, state: "merged" },
    });
    expect(withThreadOpenPullRequest(status, [merged, linkedPr(42)], true)?.pr?.number).toBe(42);
  });
});
