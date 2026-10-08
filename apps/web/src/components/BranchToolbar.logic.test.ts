import { type VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";
import {
  buildBranchPickerItems,
  resolveNewRefBase,
  resolveWorkspacePickerItems,
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchTriggerLabel,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveBranchToolbarPrBranch,
  resolveLocalCheckoutBranchMismatch,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
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

describe("resolveBranchToolbarPrBranch", () => {
  it("hides PR state while an optimistic branch switch is in flight", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: "feature/current",
        resolvedActiveBranch: "feature/next",
      }),
    ).toBeNull();
  });
});

describe("resolveLocalCheckoutBranchMismatch", () => {
  it("detects when a local thread is associated with a different branch than the checkout", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toEqual({
      threadBranch: "feature/thread",
      currentBranch: "feature/current",
    });
  });

  it("ignores dedicated worktrees because their checkout is already thread-scoped", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.t3/worktrees/feature-thread",
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("keeps a server thread in worktree mode while its worktree is still being created", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
        preparingWorktree: true,
      }),
    ).toBe("worktree");
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
      }),
    ).toBe("local");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
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
        activeProjectCwd: "/repo/nested-checkout/packages/app",
        activeProjectCheckoutRoot: "/repo/nested-checkout",
        activeWorktreePath: null,
        refName: { isDefault: true, worktreePath: "/repo" },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: "/repo",
      reuseExistingWorktree: true,
    });
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
    // A subdirectory project's own checkout is reported at the repository root.
    // The checkout root is undefined until the project's status loads.
    for (const [activeProjectCwd, activeWorktreePath, activeProjectCheckoutRoot] of [
      ["/repo", "/repo/.t3/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", "/repo/.t3/worktrees/feature-a", "/repo"],
      ["/repo/packages/app", null, "/repo"],
      ["/repo/packages/app", "/repo/.t3/worktrees/feature-a", undefined],
      ["/repo/packages/app", null, undefined],
    ] as const) {
      expect(
        resolveBranchSelectionTarget({
          activeProjectCwd,
          activeProjectCheckoutRoot,
          activeWorktreePath,
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
    }
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

  it("surfaces an existing ref matching the sanitized query", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "new-branch",
        normalizedQuery: "new branch",
        createBranchItemValue: null,
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });
});

describe("sanitizeNewRefName", () => {
  it("collapses a run of whitespace into a single dash", () => {
    expect(sanitizeNewRefName("new   branch")).toBe("new-branch");
  });

  it("replaces tabs, which git rejects just like spaces", () => {
    expect(sanitizeNewRefName("new\tbranch")).toBe("new-branch");
  });

  it("preserves whitespace that git accepts", () => {
    expect(sanitizeNewRefName("new\u00a0branch")).toBe("new\u00a0branch");
    expect(sanitizeNewRefName("new\u2009branch")).toBe("new\u2009branch");
  });

  it("does not collapse dashes the user typed", () => {
    expect(sanitizeNewRefName("new - branch")).toBe("new---branch");
    expect(sanitizeNewRefName("foo--bar")).toBe("foo--bar");
  });
});

describe("explicit worktree branch", () => {
  it("shows an explicit worktree branch with its origin base", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: "development",
        resolvedActiveBranchIsRemote: false,
        startFromOrigin: true,
        worktreeBranch: "jm/indiv/juh/ehrungen",
      }),
    ).toBe("jm/indiv/juh/ehrungen from development (remote)");
  });

});

describe("worktree branch reuse label", () => {
  it("shows an available branch directly when the worktree will reuse it", () => {
    expect(resolveBranchTriggerLabel({
      activeWorktreePath: null,
      effectiveEnvMode: "worktree",
      resolvedActiveBranch: "jm/bugfix/existing",
      resolvedActiveBranchIsRemote: false,
      startFromOrigin: false,
      reuseSelectedBranch: true,
    })).toBe("jm/bugfix/existing");
  });
});

describe("buildBranchPickerItems", () => {
  it("offers the pasted new ref before existing refs that only match by substring", () => {
    const query = "jm/indiv/verwaltung/mitarbeiterstatistik-fix-date-cutoff";
    const createBranchItemValue = `__create_new_branch__:${query}`;
    const matchingRef = `serverinsta${query}`;
    const items = buildBranchPickerItems({
      branchNames: [matchingRef],
      createBranchItemValue,
      hasExactBranchMatch: false,
      checkoutPullRequestItemValue: null,
    }).filter((itemValue) =>
      shouldIncludeBranchPickerItem({
        itemValue,
        normalizedQuery: query,
        createBranchItemValue,
        checkoutPullRequestItemValue: null,
      }),
    );
    expect(items).toEqual([createBranchItemValue, matchingRef]);
    expect(sanitizeNewRefName(query)).toBe(query);
  });

  it("keeps exact existing refs selectable without offering duplicate creation", () => {
    expect(
      buildBranchPickerItems({
        branchNames: ["feature/current"],
        createBranchItemValue: "__create_new_branch__:feature/current",
        hasExactBranchMatch: true,
        checkoutPullRequestItemValue: null,
      }),
    ).toEqual(["feature/current"]);
  });

  it("keeps pull-request checkout first and only lists refs when choosing a base", () => {
    expect(
      buildBranchPickerItems({
        branchNames: ["feature/123"],
        createBranchItemValue: "__create_new_branch__:123",
        hasExactBranchMatch: false,
        checkoutPullRequestItemValue: "__checkout_pull_request__:123",
      }),
    ).toEqual(["__checkout_pull_request__:123", "__create_new_branch__:123", "feature/123"]);
    expect(
      buildBranchPickerItems({
        branchNames: ["main", "feature/current"],
        createBranchItemValue: null,
        hasExactBranchMatch: false,
        checkoutPullRequestItemValue: null,
      }),
    ).toEqual(["main", "feature/current"]);
  });
});

describe("resolveNewRefBase", () => {
  it("defaults to the repository default instead of the checked-out feature branch", () => {
    expect(
      resolveNewRefBase(
        [
          { name: "feature/current", isDefault: false },
          { name: "main", isDefault: true },
        ],
        "feature/current",
      ),
    ).toBe("main");
  });

  it("uses a remote-only default ref and honors nonstandard defaults", () => {
    expect(
      resolveNewRefBase(
        [
          { name: "main", isDefault: false },
          { name: "origin/trunk", isDefault: true },
        ],
        "feature/current",
      ),
    ).toBe("origin/trunk");
  });

  it("prefers main or master when the repository has no default-ref metadata", () => {
    expect(
      resolveNewRefBase(
        [
          { name: "master", isDefault: false },
          { name: "main", isDefault: false },
        ],
        "feature/current",
      ),
    ).toBe("main");
    expect(resolveNewRefBase([{ name: "master", isDefault: false }], "feature/current")).toBe(
      "master",
    );
  });

  it("falls back to the current checkout, including detached HEAD", () => {
    expect(resolveNewRefBase([], "trunk")).toBe("trunk");
    expect(resolveNewRefBase([], null)).toBe("HEAD");
  });
});

describe("resolveWorkspacePickerItems", () => {
  const worktrees = [{ path: "/repo" }, { path: "/worktrees/b" }, { path: "/worktrees/a" }];

  it("puts the selected folder first, then creation, then other folders", () => {
    const items = resolveWorkspacePickerItems({
      activeWorktreePath: "/worktrees/b",
      projectCwd: "/repo",
      effectiveEnvMode: "local",
      worktrees,
    });
    expect(items.map((item) => item.value)).toEqual([
      "worktree:/worktrees/b",
      "worktree",
      "worktree:/repo",
      "worktree:/worktrees/a",
    ]);
    expect(items[0]?.label).toBe("b");
    expect(items[1]?.label).toBe("New worktree");
  });

  it("shows new worktree once when creation is selected", () => {
    expect(
      resolveWorkspacePickerItems({
        activeWorktreePath: null,
        projectCwd: "/repo",
        effectiveEnvMode: "worktree",
        worktrees,
      }).map((item) => item.value),
    ).toEqual(["worktree", "worktree:/repo", "worktree:/worktrees/a", "worktree:/worktrees/b"]);
  });

  it("names the project checkout and keeps a selected folder absent from discovery", () => {
    expect(
      resolveWorkspacePickerItems({
        activeWorktreePath: null,
        projectCwd: "/repo",
        effectiveEnvMode: "local",
        worktrees,
      })[0],
    ).toEqual({ value: "worktree:/repo", path: "/repo", label: "repo" });
    expect(
      resolveWorkspacePickerItems({
        activeWorktreePath: "/worktrees/missing",
        projectCwd: "/repo",
        effectiveEnvMode: "local",
        worktrees: [],
      }).map((item) => item.value),
    ).toEqual(["worktree:/worktrees/missing", "worktree"]);
  });
});
