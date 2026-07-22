import type { VcsStatusRemoteResult, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("https://github.com/T3Tools/T3Code.git")).toBe(
      "github.com/t3tools/t3code",
    );
    expect(normalizeGitRemoteUrl("ssh://git@github.com/T3Tools/T3Code")).toBe(
      "github.com/t3tools/t3code",
    );
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/T3Tools/platform/T3Code.git")).toBe(
      "gitlab.com/t3tools/platform/t3code",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:T3Tools/T3Code.git"),
    ).toBe("T3Tools/T3Code");
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/T3Tools/T3Code.git"),
    ).toBe("T3Tools/T3Code");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(
      isTemporaryWorktreeBranch(
        buildTemporaryWorktreeBranchName((byteLength) => {
          expect(byteLength).toBe(4);
          return "DEADBEEF";
        }),
      ),
    ).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  const localStatus = {
    isRepo: true as const,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/demo",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  };

  it("keeps an initial snapshot pending until remote lookup completes", () => {
    expect(
      applyGitStatusStreamEvent(null, {
        _tag: "snapshot",
        local: localStatus,
        remote: null,
      }),
    ).toMatchObject({
      refName: "feature/demo",
      statusRefName: null,
      pr: null,
      changeRequestLookup: { _tag: "pending" },
    });
  });

  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      statusRefName: null,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
      changeRequestLookup: { _tag: "succeeded" },
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      statusRefName: null,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
      changeRequestLookup: { _tag: "succeeded" },
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      statusRefName: "feature/demo",
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
      changeRequestLookup: { _tag: "succeeded" },
    };

    const remote: VcsStatusRemoteResult = {
      statusRefName: "feature/demo",
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
      changeRequestLookup: { _tag: "succeeded" },
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
      changeRequestLookup: { _tag: "succeeded" },
    });
  });

  it("clears remote state when a local update switches branches", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/old",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      statusRefName: "feature/old",
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: {
        number: 12,
        title: "Old branch PR",
        url: "https://example.com/pr/12",
        baseRef: "main",
        headRef: "feature/old",
        state: "open",
      },
      changeRequestLookup: { _tag: "succeeded" },
    };

    expect(
      applyGitStatusStreamEvent(current, {
        _tag: "localUpdated",
        local: { ...current, refName: "feature/new" },
      }),
    ).toMatchObject({
      refName: "feature/new",
      statusRefName: null,
      pr: null,
      changeRequestLookup: { _tag: "pending" },
    });
  });

  it("ignores a late remote update calculated for a previous branch", () => {
    const current: VcsStatusResult = {
      ...localStatus,
      refName: "feature/new",
      statusRefName: null,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
      changeRequestLookup: { _tag: "pending" },
    };

    expect(
      applyGitStatusStreamEvent(current, {
        _tag: "remoteUpdated",
        remote: {
          statusRefName: "feature/old",
          hasUpstream: true,
          aheadCount: 1,
          behindCount: 0,
          pr: {
            number: 12,
            title: "Old branch PR",
            url: "https://example.com/pr/12",
            baseRef: "main",
            headRef: "feature/old",
            state: "open",
          },
          changeRequestLookup: { _tag: "succeeded" },
        },
      }),
    ).toEqual(current);
  });
});
