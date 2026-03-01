import { ThreadId, type GitBranch } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  deriveSyncedLocalBranch,
} from "./BranchToolbar.logic";

const branches: GitBranch[] = [
  {
    name: "main",
    current: true,
    isDefault: true,
    worktreePath: null,
  },
  {
    name: "feature/demo",
    current: false,
    isDefault: false,
    worktreePath: null,
  },
];

describe("deriveSyncedLocalBranch", () => {
  it("syncs to git current branch in local mode", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const result = deriveSyncedLocalBranch({
      activeThreadId: threadId,
      activeWorktreePath: null,
      envMode: "local",
      activeThreadBranch: "feature/demo",
      queryBranches: branches,
    });

    expect(result).toBe("main");
  });

  it("does not sync when creating a new worktree", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const result = deriveSyncedLocalBranch({
      activeThreadId: threadId,
      activeWorktreePath: null,
      envMode: "worktree",
      activeThreadBranch: "feature/demo",
      queryBranches: branches,
    });

    expect(result).toBeNull();
  });

  it("does not sync when thread already targets a worktree path", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const result = deriveSyncedLocalBranch({
      activeThreadId: threadId,
      activeWorktreePath: "/tmp/repo/worktrees/feature-demo",
      envMode: "local",
      activeThreadBranch: "feature/demo",
      queryBranches: branches,
    });

    expect(result).toBeNull();
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(
      deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo", "my-org/upstream"),
    ).toBe("feature/demo");
  });

  it("returns the original name when ref is malformed", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
    expect(deriveLocalBranchNameFromRemoteRef("/feature/demo")).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local branch exists", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: GitBranch[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("dedupes remote refs for remotes whose names contain slashes", () => {
    const input: GitBranch[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "feature/demo",
    ]);
  });

  it("dedupes remote refs when git tracks with first-slash local naming", () => {
    const input: GitBranch[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((branch) => branch.name)).toEqual([
      "upstream/feature",
    ]);
  });
});
