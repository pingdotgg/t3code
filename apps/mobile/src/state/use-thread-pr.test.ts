import { ProjectId, type ThreadPullRequestLink, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  presentThreadLinkedPullRequests,
  presentThreadPr,
  resolveThreadPrSource,
} from "./thread-pr-presentation";

const pullRequest: NonNullable<VcsStatusResult["pr"]> = {
  number: 3774,
  title: "Desktop-style pull request indicator",
  url: "https://github.com/t3tools/t3code/pull/3774",
  baseRef: "main",
  headRef: "codex/desktop-style-pr-indicator",
  state: "merged",
};

describe("presentThreadPr", () => {
  it("uses the compact pull request number label without a hash prefix", () => {
    expect(presentThreadPr(pullRequest, undefined)).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 pull request merged",
      textClassName: "text-adaptive-violet-600-400",
    });
  });

  it("uses merge-request terminology for GitLab", () => {
    expect(
      presentThreadPr(pullRequest, {
        kind: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      }),
    ).toMatchObject({
      label: "3774",
      accessibilityLabel: "#3774 merge request merged",
    });
  });

  it("uses gray for draft pull requests", () => {
    expect(
      presentThreadPr({ ...pullRequest, state: "open", isDraft: true }, undefined),
    ).toMatchObject({
      accessibilityLabel: "#3774 pull request draft",
      textClassName: "text-foreground-muted",
    });
  });
});

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
  it("renders unsynced links with neutral pending status", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(1, { snapshot: null })])).toMatchObject({
      number: 1,
      label: "1",
      state: null,
      textClassName: "text-foreground-muted",
      accessibilityLabel: "#1 pull request status pending",
    });
  });

  it("counts unrelated links without labelling them a stack", () => {
    expect(presentThreadLinkedPullRequests([linkedPr(1), linkedPr(2)])).toMatchObject({
      kind: "pull-request",
      label: "2 PRs",
      others: 1,
      state: null,
      isDraft: false,
      textClassName: "text-foreground-muted",
      accessibilityLabel: "2 linked pull requests",
    });
  });

  it.each([
    ["closed", false, "closed", false],
    ["open", true, "open", true],
    ["open", true, "open", false],
    ["closed", false, "open", false],
    ["merged", false, "merged", false],
    ["closed", false, "merged", false],
  ] as const)(
    "keeps the linked total neutral for %s (draft %s) and %s (draft %s)",
    (firstState, firstDraft, secondState, secondDraft) => {
      const first = linkedPr(1);
      const second = linkedPr(2);
      expect(
        presentThreadLinkedPullRequests([
          { ...first, snapshot: { ...first.snapshot!, state: firstState, isDraft: firstDraft } },
          {
            ...second,
            snapshot: { ...second.snapshot!, state: secondState, isDraft: secondDraft },
          },
        ]),
      ).toMatchObject({
        label: "2 PRs",
        state: null,
        isDraft: false,
        textClassName: "text-foreground-muted",
        accessibilityLabel: "2 linked pull requests",
      });
    },
  );

  it.each([false, true])(
    "keeps three closed PRs and their replacements neutral, pending snapshot: %s",
    (pending) => {
      const links = Array.from({ length: 6 }, (_, index) => {
        const link = linkedPr(index + 1);
        return {
          ...link,
          snapshot:
            pending && index === 5
              ? null
              : {
                  ...link.snapshot!,
                  state: index < 3 ? ("closed" as const) : ("open" as const),
                  headBranch: `change-${index % 3}`,
                },
        };
      });

      expect(presentThreadLinkedPullRequests(links)).toMatchObject({
        kind: "pull-request",
        label: "6 PRs",
        state: null,
        isDraft: false,
        textClassName: "text-foreground-muted",
        accessibilityLabel: "6 linked pull requests",
      });
    },
  );

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

  it("hides dismissed stack members", () => {
    expect(
      presentThreadLinkedPullRequests([linkedPr(1, { source: "stack-dismissed" })]),
    ).toBeNull();
  });

  it("retains merged state from the persisted snapshot", () => {
    const link = linkedPr(1);
    expect(
      presentThreadLinkedPullRequests([
        { ...link, snapshot: { ...link.snapshot!, state: "merged" } },
      ]),
    ).toMatchObject({ state: "merged", textClassName: "text-adaptive-violet-600-400" });
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

  it("keeps the legacy reference for a server without either capability", () => {
    expect(resolveThreadPrSource({ pullRequests: [], linkedPullRequest: legacyRef }, {})).toEqual({
      linkedPresentation: null,
      pullRequestRef: legacyRef,
    });
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
