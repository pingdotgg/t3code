import type { GitBranch, VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeRemoteBranchesWithLocalMatches,
  formatCurrentVcsRefNames,
  getCurrentVcsRefNames,
  deriveLocalBranchNameFromRemoteRef,
  resolveDraftEnvModeAfterBranchChange,
  resolveBranchToolbarState,
  resolveBranchToolbarValue,
} from "./BranchToolbar.logic";

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base branch before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a branch already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarValue", () => {
  it("defaults new-worktree mode to current git branch when no explicit base branch is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base branch", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out branch when not selecting a new worktree base", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });
});

describe("getCurrentVcsRefNames", () => {
  it("returns the current git branch name", () => {
    const refs: VcsRef[] = [
      {
        name: "main",
        kind: "branch",
        current: true,
        isDefault: true,
        workspacePath: null,
      },
      {
        name: "origin/main",
        kind: "remoteBranch",
        current: false,
        isDefault: true,
        remoteName: "origin",
        workspacePath: null,
      },
    ];

    expect(getCurrentVcsRefNames({ backend: "git", refs })).toEqual(["main"]);
  });

  it("returns sorted current jj base bookmarks", () => {
    const refs: VcsRef[] = [
      {
        name: "release/1.2",
        kind: "bookmark",
        current: true,
        isDefault: false,
        workspacePath: null,
      },
      {
        name: "main",
        kind: "bookmark",
        current: true,
        isDefault: true,
        workspacePath: null,
      },
      {
        name: "main@origin",
        kind: "remoteBookmark",
        current: false,
        isDefault: true,
        remoteName: "origin",
        workspacePath: null,
      },
    ];

    expect(getCurrentVcsRefNames({ backend: "jj", refs })).toEqual(["main", "release/1.2"]);
  });
});

describe("formatCurrentVcsRefNames", () => {
  it("formats a single current ref name", () => {
    expect(formatCurrentVcsRefNames(["main"])).toBe("main");
  });

  it("formats multiple current ref names", () => {
    expect(formatCurrentVcsRefNames(["main", "release/1.2"])).toBe("main, release/1.2");
  });

  it("returns null when there are no current ref names", () => {
    expect(formatCurrentVcsRefNames([])).toBeNull();
  });
});

describe("resolveBranchToolbarState", () => {
  it("prefers the explicit jj thread bookmark over inferred bookmarks", () => {
    expect(
      resolveBranchToolbarState({
        backend: "jj",
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentRefNames: ["main"],
      }),
    ).toEqual({
      displayValue: "feature/base",
      selectedValue: "feature/base",
    });
  });

  it("uses a single inferred jj bookmark for display and selection", () => {
    expect(
      resolveBranchToolbarState({
        backend: "jj",
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentRefNames: ["main"],
      }),
    ).toEqual({
      displayValue: "main",
      selectedValue: "main",
    });
  });

  it("shows multiple inferred jj bookmarks without selecting one", () => {
    expect(
      resolveBranchToolbarState({
        backend: "jj",
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentRefNames: ["main", "release/1.2"],
      }),
    ).toEqual({
      displayValue: "main, release/1.2",
      selectedValue: null,
    });
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
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
