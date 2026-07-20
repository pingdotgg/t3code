import { EnvironmentId, type VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  deriveWorkspaceOptions,
  resolveEnvironmentOptionLabel,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveEnvModeLabel,
  resolveMainCheckoutTarget,
  resolveWorkspaceSelection,
  resolveBranchToolbarValue,
  shouldIncludeBranchPickerItem,
  withActiveWorkspaceFallback,
} from "./BranchToolbar.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("deriveWorkspaceOptions", () => {
  it("combines the default branch with the local main checkout", () => {
    const refs: VcsRef[] = [
      {
        name: "main",
        current: true,
        isDefault: true,
        worktreePath: "/repo",
      },
      {
        name: "feature/one",
        current: false,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/one",
      },
      {
        name: "feature/one-alias",
        current: false,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/one",
      },
    ];

    expect(deriveWorkspaceOptions(refs, "/repo")).toEqual({
      mainCheckout: null,
      existingWorktrees: [
        {
          branch: "feature/one",
          label: "feature/one",
          path: "/repo/.t3/worktrees/one",
          isProjectCheckout: false,
        },
      ],
    });
  });

  it("promotes a separate default-branch worktree to the main checkout option", () => {
    const refs: VcsRef[] = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/current",
      },
      {
        name: "main",
        current: false,
        isDefault: true,
        worktreePath: "/repo",
      },
      {
        name: "feature/other",
        current: false,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/other",
      },
    ];

    expect(deriveWorkspaceOptions(refs, "/repo/.t3/worktrees/current", "/repo")).toEqual({
      mainCheckout: {
        branch: "main",
        label: "main",
        path: "/repo",
        isProjectCheckout: false,
      },
      existingWorktrees: [
        {
          branch: "feature/current",
          label: "feature/current",
          path: "/repo/.t3/worktrees/current",
          isProjectCheckout: true,
        },
        {
          branch: "feature/other",
          label: "feature/other",
          path: "/repo/.t3/worktrees/other",
          isProjectCheckout: false,
        },
      ],
    });
  });

  it("uses checkout metadata when the default branch is not checked out", () => {
    const refs: VcsRef[] = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/current",
      },
      {
        name: "feature/main-checkout",
        current: false,
        isDefault: false,
        worktreePath: "/repo",
      },
      { name: "main", current: false, isDefault: true, worktreePath: null },
    ];

    expect(deriveWorkspaceOptions(refs, "/repo/.t3/worktrees/current", "/repo")).toMatchObject({
      mainCheckout: {
        branch: "feature/main-checkout",
        path: "/repo",
      },
    });
  });

  it("does not duplicate the project checkout when its current branch is not the default", () => {
    const refs: VcsRef[] = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: "/repo",
      },
      {
        name: "main",
        current: false,
        isDefault: true,
        worktreePath: null,
      },
      {
        name: "feature/other",
        current: false,
        isDefault: false,
        worktreePath: "/repo/.t3/worktrees/other",
      },
    ];

    expect(deriveWorkspaceOptions(refs, "/repo")).toEqual({
      mainCheckout: null,
      existingWorktrees: [
        {
          branch: "feature/other",
          label: "feature/other",
          path: "/repo/.t3/worktrees/other",
          isProjectCheckout: false,
        },
      ],
    });
  });
});

describe("resolveWorkspaceSelection", () => {
  const projectCheckout = {
    branch: "t3code/current",
    label: "t3code/current",
    path: "/repo/worktrees/current",
    isProjectCheckout: true,
  };
  const mainCheckout = {
    branch: "main",
    label: "main",
    path: "/repo",
    isProjectCheckout: false,
  };

  it("keeps New worktree selected when the registered project is a linked worktree", () => {
    expect(
      resolveWorkspaceSelection({
        effectiveEnvMode: "worktree",
        activeWorktreePath: null,
        mainCheckout,
        existingWorktrees: [projectCheckout],
      }),
    ).toMatchObject({
      isMainCheckout: false,
      selectedExistingWorktree: undefined,
      value: "worktree",
      label: "New worktree",
    });
  });

  it("selects the registered project checkout only in local mode", () => {
    expect(
      resolveWorkspaceSelection({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        mainCheckout,
        existingWorktrees: [projectCheckout],
      }),
    ).toMatchObject({
      selectedExistingWorktree: projectCheckout,
      value: `existing:${projectCheckout.path}`,
      label: "t3code/current",
    });
  });

  it("normalizes workspace paths when resolving the active selection", () => {
    expect(
      resolveWorkspaceSelection({
        effectiveEnvMode: "local",
        activeWorktreePath: "C:\\repo\\worktrees\\current\\",
        mainCheckout,
        existingWorktrees: [{ ...projectCheckout, path: "C:/repo/worktrees/current" }],
      }),
    ).toMatchObject({
      label: "t3code/current",
      value: "existing:C:/repo/worktrees/current",
    });
  });

  it("treats Windows drive-letter paths as case-insensitive", () => {
    expect(
      resolveWorkspaceSelection({
        effectiveEnvMode: "local",
        activeWorktreePath: "C:/Repo/worktrees/current",
        mainCheckout: { ...mainCheckout, path: "c:/repo" },
        existingWorktrees: [{ ...projectCheckout, path: "c:/repo/worktrees/current" }],
      }),
    ).toMatchObject({
      label: "t3code/current",
      value: "existing:c:/repo/worktrees/current",
    });
  });
});

describe("withActiveWorkspaceFallback", () => {
  it("keeps an active worktree visible while refs are unavailable", () => {
    expect(
      withActiveWorkspaceFallback(
        { mainCheckout: null, existingWorktrees: [] },
        {
          activeWorktreePath: "/repo/.t3/worktrees/current",
          activeBranch: "feature/current",
          projectWorkspaceRoot: "/repo/.t3/worktrees/current",
        },
      ),
    ).toEqual({
      mainCheckout: null,
      existingWorktrees: [
        {
          branch: "feature/current",
          label: "feature/current",
          path: "/repo/.t3/worktrees/current",
          isProjectCheckout: true,
        },
      ],
    });
  });
});

describe("resolveMainCheckoutTarget", () => {
  it("uses the branch currently checked out in the main project checkout", () => {
    const refs: VcsRef[] = [
      {
        name: "feature/current",
        current: true,
        isDefault: false,
        worktreePath: "/repo",
      },
      { name: "main", current: false, isDefault: true, worktreePath: null },
    ];

    expect(resolveMainCheckoutTarget(refs, "/repo", "/repo")).toEqual({
      branch: "feature/current",
      path: null,
    });
  });

  it("returns the external main checkout for a registered linked worktree", () => {
    const refs: VcsRef[] = [
      {
        name: "feature/linked",
        current: true,
        isDefault: false,
        worktreePath: "/repo/worktrees/linked",
      },
      {
        name: "feature/main-checkout",
        current: false,
        isDefault: false,
        worktreePath: "/repo",
      },
    ];

    expect(resolveMainCheckoutTarget(refs, "/repo/worktrees/linked", "/repo")).toEqual({
      branch: "feature/main-checkout",
      path: "/repo",
    });
  });
});

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

  it("keeps new-worktree mode when selecting a base ref before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
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
  it("defaults new-worktree mode to current git ref when no explicit base ref is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base ref", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out ref when not selecting a new worktree base", () => {
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

describe("resolveEnvironmentOptionLabel", () => {
  it("prefers the primary environment's machine label", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Julius's Mac mini",
        savedLabel: "Local environment",
      }),
    ).toBe("Julius's Mac mini");
  });

  it("falls back to 'This device' for generic primary labels", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Local environment",
        savedLabel: "Local",
      }),
    ).toBe("This device");
  });

  it("keeps configured labels for non-primary environments", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: remoteEnvironmentId,
        runtimeLabel: null,
        savedLabel: "Build box",
      }),
    ).toBe("Build box");
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("treats draft threads already attached to a worktree as current-checkout mode", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps explicit new-worktree mode for draft threads without a worktree path", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });
});

describe("resolveEnvModeLabel", () => {
  it("uses explicit workspace labels", () => {
    expect(resolveEnvModeLabel("local")).toBe("Main checkout");
    expect(resolveEnvModeLabel("worktree")).toBe("New worktree");
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
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
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

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: VcsRef[] = [
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

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local ref exists", () => {
    const input: VcsRef[] = [
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

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
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

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default ref in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("keeps the synthetic create-ref item visible for arbitrary ref input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__create_new_branch__:feature/demo",
        normalizedQuery: "feature/demo",
        createBranchItemValue: "__create_new_branch__:feature/demo",
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });

  it("still filters ordinary ref items by query text", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "main",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(false);
  });
});
