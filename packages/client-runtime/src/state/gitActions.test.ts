import type { VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";
import { GIT_VCS_TERMINOLOGY, getVcsTerminology } from "@t3tools/shared/vcs";

import { buildMenuItems, getGitActionDisabledReason, resolveQuickAction } from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function reason(gitStatus: VcsStatusResult, id: "commit" | "push" | "pr") {
  const item = buildMenuItems(gitStatus, false).find((entry) => entry.id === id)!;
  return getGitActionDisabledReason({ item, gitStatus, isBusy: false, hasOriginRemote: true });
}

describe("upstream mobile Git action parity", () => {
  it("requires a clean worktree before pushing", () => {
    const dirty = status({ hasWorkingTreeChanges: true, aheadCount: 1 });
    assert.deepEqual(
      buildMenuItems(dirty, false).map(({ id, disabled }) => ({ id, disabled })),
      [
        { id: "commit", disabled: false },
        { id: "push", disabled: true },
        { id: "pr", disabled: false },
      ],
    );
    assert.equal(reason(dirty, "push"), "Commit or stash local changes before pushing.");
  });

  it("keeps all three menu items without a remote", () => {
    const local = status({ hasUpstream: false, hasWorkingTreeChanges: true });
    assert.deepEqual(
      buildMenuItems(local, false, false).map(({ id, disabled }) => ({ id, disabled })),
      [
        { id: "commit", disabled: false },
        { id: "push", disabled: true },
        { id: "pr", disabled: true },
      ],
    );
    assert.deepEqual(resolveQuickAction(local, false, false, false), {
      label: "Commit",
      disabled: false,
      kind: "run_action",
      action: "commit",
    });
  });

  it("keeps the View PR menu and quick action for an open PR", () => {
    const open = status({
      pr: {
        number: 42,
        title: "Feature",
        url: "https://example.com/pr/42",
        state: "open",
        baseRef: "main",
        headRef: "feature/test",
      },
    });
    assert.deepEqual(buildMenuItems(open, false)[2], {
      id: "pr",
      label: "View PR",
      disabled: false,
      icon: "pr",
      kind: "open_pr",
    });
    assert.deepEqual(resolveQuickAction(open, false), {
      label: "View PR",
      disabled: false,
      kind: "open_pr",
    });
    assert.equal(buildMenuItems(open, true)[2]?.disabled, true);
  });

  it("does not add a Create PR quick action on synced branches", () => {
    assert.deepEqual(resolveQuickAction(status({ aheadOfDefaultCount: 3 }), false), {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. No action needed.",
    });
  });

  it("retains upstream Git copy, including checkout spelling", () => {
    assert.equal(reason(status(), "commit"), "Worktree is clean. Make changes before committing.");
    assert.equal(
      reason(status({ refName: null }), "push"),
      "Detached HEAD: checkout a branch before pushing.",
    );
    assert.equal(
      resolveQuickAction(status({ refName: null }), false).hint,
      "Create and checkout a branch before pushing or opening a PR.",
    );
    assert.equal(
      resolveQuickAction(status({ aheadCount: 1, behindCount: 1 }), false).label,
      "Sync branch",
    );
    assert.equal(
      resolveQuickAction(status({ hasUpstream: false }), false, false, false).hint,
      'Add an "origin" remote before pushing or creating a PR.',
    );
    assert.equal(getVcsTerminology("git"), GIT_VCS_TERMINOLOGY);
    assert.equal(getVcsTerminology("unknown"), GIT_VCS_TERMINOLOGY);
    assert.equal(getVcsTerminology(null), GIT_VCS_TERMINOLOGY);
  });
});

describe("Jujutsu-only additions", () => {
  it("uses bookmark and workspace terminology", () => {
    const jj = status({ vcs: { kind: "jj" } });
    assert.equal(reason(jj, "commit"), "Workspace is clean. Make changes before committing.");
    assert.equal(
      resolveQuickAction({ ...jj, refName: null }, false).hint,
      "No bookmark here: create one before pushing or opening a PR.",
    );
    assert.equal(resolveQuickAction(jj, true).hint, "Jujutsu action in progress.");
  });

  it("blocks every action and surfaces the unsupported reason", () => {
    const message = "jj 0.40.0 is older than the supported 0.46.0.";
    const unsupported = status({
      hasWorkingTreeChanges: true,
      vcs: { kind: "jj", unsupportedReason: message },
    });
    assert.deepEqual(
      buildMenuItems(unsupported, false).map((item) => item.disabled),
      [true, true, true],
    );
    assert.deepEqual(resolveQuickAction(unsupported, false), {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: message,
    });
    assert.equal(reason(unsupported, "commit"), message);
  });
});
