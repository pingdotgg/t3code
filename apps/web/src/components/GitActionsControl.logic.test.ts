import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import { assert, describe, it } from "vite-plus/test";
import {
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
} from "./GitActionsControl.logic";

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
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ refName: "main", hasWorkingTreeChanges: true }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
      disabled: false,
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
