import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { assert, describe, it } from "vite-plus/test";
import {
  buildMenuItems,
  canRewriteCommitMessages,
  isDuplicatePendingThreadBranchSync,
  requiresDefaultBranchConfirmation,
  requiresForcePushConfirmation,
  resolveChangesTotals,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
} from "./GitActionsControl.logic";

describe("canRewriteCommitMessages", () => {
  it("allows local commits ahead of an upstream", () => {
    assert.isTrue(canRewriteCommitMessages(status({ aheadCount: 2 })));
  });

  it("does not offer already-published upstream commits", () => {
    assert.isFalse(canRewriteCommitMessages(status({ aheadCount: 0, aheadOfDefaultCount: 3 })));
  });

  it("uses the default-branch delta when there is no upstream", () => {
    assert.isTrue(
      canRewriteCommitMessages(
        status({ hasUpstream: false, aheadCount: 0, aheadOfDefaultCount: 2 }),
      ),
    );
  });
});

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("when: ref is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseRef: "main",
          headRef: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "push", label: "Push" });
  });
});

describe("when: ref is clean, up to date, and has no open PR", () => {
  it("enables create PR when synced with upstream but ahead of default, even with local changes", () => {
    const syncedFeature = status({
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 1,
      pr: null,
    });

    const quick = resolveQuickAction(syncedFeature, false);
    assert.deepInclude(quick, {
      label: "Create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });

    const items = buildMenuItems(syncedFeature, false);
    assert.equal(items.find((item) => item.id === "pr")?.disabled, false);

    const dirtyFeature = { ...syncedFeature, hasWorkingTreeChanges: true };
    assert.equal(
      buildMenuItems(dirtyFeature, false).find((item) => item.id === "pr")?.disabled,
      false,
    );
  });
});

describe("when: on default ref without open PR", () => {
  it("resolveQuickAction opens the commit dialog when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepEqual(quick, {
      kind: "open_commit_dialog",
      label: "Commit",
      disabled: false,
    });
  });
});

describe("when: local changes are behind upstream", () => {
  it("keeps the commit action available without pushing, with or without an open PR", () => {
    const behind = status({ hasWorkingTreeChanges: true, behindCount: 2 });
    const commit = {
      label: "Commit",
      disabled: false,
      kind: "run_action",
      action: "commit",
    } as const;
    assert.deepEqual(resolveQuickAction(behind, false), commit);
    assert.deepEqual(
      resolveQuickAction(
        {
          ...behind,
          pr: {
            number: 13,
            title: "Open PR",
            url: "https://example.com/pr/13",
            baseRef: "main",
            headRef: "feature/test",
            state: "open",
          },
        },
        false,
      ),
      commit,
    );
  });
});

describe("when: HEAD is detached and there are local changes", () => {
  it("resolveQuickAction makes commit available", () => {
    const quick = resolveQuickAction(
      status({ refName: null, hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
    );

    assert.deepEqual(quick, {
      label: "Commit",
      disabled: false,
      kind: "run_action",
      action: "commit",
    });
  });
});

describe("when: ref has no upstream configured", () => {
  it("resolveQuickAction runs push and create PR when no upstream and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "create_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("resolveQuickAction publishes when no origin remote exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 2,
        pr: null,
      }),
      false,
      false,
      false,
    );
    assert.deepEqual(quick, {
      kind: "open_publish",
      label: "Publish repository",
      disabled: false,
    });
  });
});

describe("when: the ref is on GitLab", () => {
  const gitLab = {
    sourceControlProvider: {
      kind: SourceControlProviderKind.make("gitlab"),
      name: "GitLab",
      baseUrl: "https://gitlab.com",
    },
  };

  it("names merge requests in actions and the default-ref dialog", () => {
    const ahead = status({ ...gitLab, hasUpstream: false, aheadCount: 2 });
    assert.equal(resolveQuickAction(ahead, false).label, "Push & create MR");
    assert.equal(
      resolveQuickAction(status({ ...gitLab, hasWorkingTreeChanges: true }), false).label,
      "Commit, push & MR",
    );
    assert.equal(buildMenuItems(ahead, false).find((item) => item.id === "pr")?.label, "Create MR");

    const copy = resolveDefaultBranchActionDialogCopy({
      action: "create_pr",
      branchName: "main",
      includesCommit: false,
      terminology: sourceControlClients.get("gitlab").changeRequest,
    });
    assert.equal(copy.title, "Push & create MR from default ref?");
    assert.include(copy.description, "create a merge request on");
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default ref", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("create_pr", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
    assert.isFalse(requiresDefaultBranchConfirmation("push", false));
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("returns a branch update when live git status differs from stored thread metadata", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "feature/old-ref",
      gitStatus: status({ refName: "effect-atom" }),
    });

    assert.deepEqual(update, {
      branch: "effect-atom",
    });
  });

  it("returns null when git status is detached HEAD but the thread already has a ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "effect-atom",
      gitStatus: status({ refName: null }),
    });

    assert.equal(update, null);
  });

  it("does not regress a semantic thread ref back to a temporary worktree ref", () => {
    const update = resolveLiveThreadBranchUpdate({
      threadBranch: "t3code/github-query-rate-limit",
      gitStatus: status({ refName: "t3code/bda76797" }),
    });

    assert.equal(update, null);
  });
});

describe("isDuplicatePendingThreadBranchSync", () => {
  const pending = {
    threadId: "thread-a",
    expectedBranch: "feature/old-ref",
    branch: "feature/current-ref",
  };

  it("suppresses the same branch compare-and-set while it is pending", () => {
    assert.equal(isDuplicatePendingThreadBranchSync(pending, { ...pending }), true);
  });

  it("allows a new target, source branch, or thread to synchronize", () => {
    assert.equal(
      isDuplicatePendingThreadBranchSync(pending, {
        ...pending,
        branch: "feature/new-ref",
      }),
      false,
    );
    assert.equal(
      isDuplicatePendingThreadBranchSync(pending, {
        ...pending,
        expectedBranch: "feature/intervening-ref",
      }),
      false,
    );
    assert.equal(
      isDuplicatePendingThreadBranchSync(pending, {
        ...pending,
        threadId: "thread-b",
      }),
      false,
    );
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("increments suffix when the preferred ref name already exists", () => {
    const ref = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(ref, "feature/fix-toast-copy-3");
  });

  it("treats existing ref names as case-insensitive for collision checks", () => {
    const ref = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(ref, "feature/ticket-1-2");
  });
});

describe("resolveChangesTotals", () => {
  it("does not let an empty branchChanges hide a dirty working tree", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          hasWorkingTreeChanges: true,
          branchChanges: { baseRef: "main", insertions: 0, deletions: 0 },
          workingTree: {
            files: [{ path: "a.ts", insertions: 5, deletions: 1 }],
            insertions: 5,
            deletions: 1,
          },
        }),
      ),
      { insertions: 5, deletions: 1 },
    );
  });

  it("keeps non-zero branchChanges over the working tree", () => {
    assert.deepEqual(
      resolveChangesTotals(
        status({
          branchChanges: { baseRef: "origin/master", insertions: 20, deletions: 3 },
          workingTree: {
            files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
            insertions: 1,
            deletions: 0,
          },
        }),
      ),
      { insertions: 20, deletions: 3, baseRef: "origin/master" },
    );
  });

  it("falls back to the working tree when branchChanges is omitted", () => {
    assert.deepInclude(
      resolveChangesTotals(
        status({
          workingTree: {
            files: [{ path: "a.ts", insertions: 2, deletions: 0 }],
            insertions: 2,
            deletions: 0,
          },
        }),
      ),
      { insertions: 2, deletions: 0 },
    );
  });
});

describe("when: ref has diverged from upstream", () => {
  const divergedStatus = status({ aheadCount: 2, behindCount: 1 });

  it("makes the force-push dialog the primary action", () => {
    const quick = resolveQuickAction(divergedStatus, false);
    assert.deepEqual(quick, {
      label: "Push",
      disabled: false,
      kind: "open_push_dialog",
    });
  });

  it("enables Push in the action menu", () => {
    const push = buildMenuItems(divergedStatus, false).find((item) => item.id === "push");
    assert.deepInclude(push, { disabled: false, dialogAction: "push" });
  });

  it("requires force-push confirmation only for a clean divergent upstream", () => {
    assert.isTrue(requiresForcePushConfirmation(divergedStatus));
    assert.isFalse(
      requiresForcePushConfirmation(
        status({ aheadCount: 2, behindCount: 1, hasWorkingTreeChanges: true }),
      ),
    );
    assert.isFalse(requiresForcePushConfirmation(status({ aheadCount: 0, behindCount: 1 })));
  });

  it("keeps Push disabled while the divergent worktree is dirty", () => {
    const push = buildMenuItems(
      status({ aheadCount: 2, behindCount: 1, hasWorkingTreeChanges: true }),
      false,
    ).find((item) => item.id === "push");
    assert.deepInclude(push, { disabled: true });
  });
});
