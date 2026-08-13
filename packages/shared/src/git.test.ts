import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
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

  it("normalizes a UUID-shaped random callback to the canonical 8-hex form", () => {
    expect(buildTemporaryWorktreeBranchName(() => "f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12")).toBe(
      `${WORKTREE_BRANCH_PREFIX}/f4ae4e0e`,
    );
  });

  it("matches legacy UUID-shaped temporary worktree refs from older mobile builds", () => {
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-b4f2-9cf0aa54ab12`),
    ).toBe(true);
  });

  it("rejects UUID-shaped refs that are not RFC 4122 v4", () => {
    // version nibble is not 4
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-1d48-b4f2-9cf0aa54ab12`),
    ).toBe(false);
    // variant nibble is not [89ab]
    expect(
      isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/f4ae4e0e-f971-4d48-c4f2-9cf0aa54ab12`),
    ).toBe(false);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  const localStatus = (refName: string): VcsStatusLocalResult => ({
    isRepo: true,
    sourceControlProvider: {
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
  });

  const remoteStatus = (
    refName: string,
    number: number,
    aheadCount: number,
  ): VcsStatusRemoteResult => ({
    hasUpstream: true,
    aheadCount,
    behindCount: number,
    aheadOfDefaultCount: aheadCount + number,
    pr: {
      number,
      title: `PR for ${refName}`,
      url: `https://github.com/t3tools/t3code/pull/${number}`,
      baseRef: "main",
      headRef: refName,
      state: "open",
    },
  });

  const withRemoteRef = (
    event: VcsStatusStreamEvent,
    remoteRefName: string,
  ): VcsStatusStreamEvent =>
    ({
      ...event,
      remoteRefName,
    }) as VcsStatusStreamEvent;

  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
      remoteStatusKnown: true,
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
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
      remoteStatusKnown: true,
    });
  });

  it("exposes remote data only when it is bound to the observed local ref", () => {
    const refA = "feature/a";
    const refB = "feature/b";
    const remoteA = remoteStatus(refA, 101, 3);
    const refreshedRemoteA = remoteStatus(refA, 102, 4);
    const remoteB = remoteStatus(refB, 202, 1);

    let status = applyGitStatusStreamEvent(
      null,
      withRemoteRef(
        {
          _tag: "snapshot",
          local: localStatus(refA),
          remote: remoteA,
        },
        refA,
      ),
    );
    status = applyGitStatusStreamEvent(
      status,
      withRemoteRef({ _tag: "remoteUpdated", remote: refreshedRemoteA }, refA),
    );

    expect(status).toMatchObject({
      refName: refA,
      aheadCount: refreshedRemoteA.aheadCount,
      behindCount: refreshedRemoteA.behindCount,
      pr: refreshedRemoteA.pr,
      remoteStatusKnown: true,
    });

    status = applyGitStatusStreamEvent(status, {
      _tag: "localUpdated",
      local: localStatus(refB),
    });

    expect(status).toMatchObject({
      refName: refB,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
      remoteStatusKnown: false,
    });

    status = applyGitStatusStreamEvent(
      status,
      withRemoteRef({ _tag: "remoteUpdated", remote: remoteA }, refA),
    );

    expect(status).toMatchObject({
      refName: refB,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
      remoteStatusKnown: false,
    });

    status = applyGitStatusStreamEvent(
      status,
      withRemoteRef({ _tag: "remoteUpdated", remote: remoteB }, refB),
    );

    expect(status).toMatchObject({
      refName: refB,
      aheadCount: remoteB.aheadCount,
      behindCount: remoteB.behindCount,
      aheadOfDefaultCount: remoteB.aheadOfDefaultCount,
      pr: remoteB.pr,
      remoteStatusKnown: true,
    });
  });

  it("treats a same-ref null remote result as known", () => {
    const refName = "feature/no-pr";
    const status = applyGitStatusStreamEvent(
      applyGitStatusStreamEvent(
        null,
        withRemoteRef(
          {
            _tag: "snapshot",
            local: localStatus(refName),
            remote: remoteStatus(refName, 303, 2),
          },
          refName,
        ),
      ),
      withRemoteRef({ _tag: "remoteUpdated", remote: null }, refName),
    );

    expect(status).toMatchObject({
      refName,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
      remoteStatusKnown: true,
    });
  });

  it("clears null-ref remote state when a repository becomes a non-repository", () => {
    const detachedLocal: VcsStatusLocalResult = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    const nonRepositoryLocal: VcsStatusLocalResult = {
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    };
    const current = applyGitStatusStreamEvent(null, {
      _tag: "snapshot",
      local: detachedLocal,
      remote: remoteStatus("detached", 404, 5),
      remoteRefName: null,
    });

    const afterRepositoryLoss = applyGitStatusStreamEvent(current, {
      _tag: "localUpdated",
      local: nonRepositoryLocal,
    });
    expect(afterRepositoryLoss).toEqual({
      ...nonRepositoryLocal,
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
      remoteStatusKnown: false,
    });
    expect(
      applyGitStatusStreamEvent(afterRepositoryLoss, {
        _tag: "remoteUpdated",
        remote: remoteStatus("detached", 405, 6),
        remoteRefName: null,
      }),
    ).toBe(afterRepositoryLoss);
  });
});
