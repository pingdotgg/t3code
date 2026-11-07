import {
  ProjectId,
  type PullRequestSummary,
  SourceControlProviderKind,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { buildMenuItems } from "@t3tools/client-runtime/state/vcs";
import { threadPullRequestsOf } from "@t3tools/client-runtime/thread-pull-requests";
import { describe, expect, it } from "vite-plus/test";

import {
  knownPullRequestSummary,
  presentThreadLinkedPullRequests,
  rememberBounded,
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

  it("names a single link with its host's term", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(7)])?.accessibilityLabel).toBe(
      "#7 pull request open",
    );
    expect(
      presentThreadLinkedPullRequests([
        linkedPr(7, {
          host: "gitlab.com",
          repository: "t3tools/t3code",
          url: "https://gitlab.com/t3tools/t3code/-/merge_requests/7",
        }),
      ])?.accessibilityLabel,
    ).toBe("#7 merge request open");
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

  it("polls the stored reference before the server config loads", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        false,
      ),
    ).toEqual({ linkedPresentation: null, pullRequestRef: legacyRef });
  });

  it("uses snapshots without polling once the server config loads", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [linkedPr(3)], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        true,
      ),
    ).toMatchObject({ linkedPresentation: { number: 3 }, pullRequestRef: null });
  });

  it("does not revive a removed modern link from the compatibility reference", () => {
    expect(
      resolveThreadPrSource(
        { pullRequests: [], linkedPullRequest: legacyRef, branchPullRequest: branchRef },
        true,
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
        true,
      ),
    ).toMatchObject({ linkedPresentation: { number: 3, state: null }, pullRequestRef: null });
  });
});

describe("knownPullRequestSummary", () => {
  it("seeds from the newest summary of the same pull request, never another's", () => {
    const projectId = ProjectId.make("project");
    const link = linkedPr(7);
    const threads = [
      {
        projectId,
        pullRequests: [
          { ...link, snapshot: { ...link.snapshot!, updatedAt: "2026-09-08T00:00:00.000Z" } },
        ],
      },
    ];
    const listed: PullRequestSummary = {
      provider: SourceControlProviderKind.make("github"),
      projectId,
      repository: "t3tools/t3code",
      number: 7,
      title: "Listed title",
      url: "https://github.com/t3tools/t3code/pull/7",
      state: "open",
      headBranch: "change-7",
      baseBranch: "main",
      updatedAt: "2026-09-09T00:00:00.000Z",
    };
    const lookup = (host: string, number: number, summaries = [listed]) =>
      knownPullRequestSummary({ host, repository: "t3tools/t3code", number }, threads, summaries);

    expect(lookup("github.com", 7, [])?.title).toBe("Change 7");
    expect(lookup("github.com", 7)?.title).toBe("Listed title");
    expect(lookup("github.com", 8)).toBeUndefined();
    expect(lookup("gitlab.com", 7)).toBeUndefined();

    const sameVersion = { ...listed, updatedAt: "2026-09-08T00:00:00.000Z" };
    const syncedAt = Date.parse(link.snapshot!.syncedAt);
    expect(lookup("github.com", 7, [{ ...sameVersion, observedAt: syncedAt - 1 }])?.title).toBe(
      "Change 7",
    );
    expect(lookup("github.com", 7, [{ ...sameVersion, observedAt: syncedAt + 1 }])?.title).toBe(
      "Listed title",
    );
  });
});

describe("rememberBounded", () => {
  it("moves a re-answered entry to the newest slot and evicts the oldest past the limit", () => {
    let snapshots: ReadonlyMap<string, number> = new Map();
    snapshots = rememberBounded(snapshots, "a", 1, 2);
    snapshots = rememberBounded(snapshots, "b", 2, 2);
    snapshots = rememberBounded(snapshots, "a", 3, 2);
    snapshots = rememberBounded(snapshots, "c", 4, 2);
    expect([...snapshots]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
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
