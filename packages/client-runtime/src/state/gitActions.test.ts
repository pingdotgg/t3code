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

describe("the folded web behaviour", () => {
  it("gates the change-request item on aheadOfDefaultCount, not aheadCount", () => {
    const items = buildMenuItems(status({ aheadCount: 0, aheadOfDefaultCount: 3 }), false);
    assert.isFalse(items.find((item) => item.id === "pr")?.disabled);
  });

  it("offers only the commit item when the repository has no primary remote", () => {
    const items = buildMenuItems(
      status({ hasWorkingTreeChanges: true, hasUpstream: false }),
      false,
      false,
    );
    assert.deepEqual(
      items.map((item) => item.id),
      ["commit"],
    );
  });

  it("keeps push available while the working tree is dirty", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, aheadCount: 1 }), false);
    assert.isFalse(items.find((item) => item.id === "push")?.disabled);
  });
});

describe("the publish quick action", () => {
  const remoteless = status({ hasUpstream: false, hasPrimaryRemote: false, aheadCount: 1 });

  it("opens the publish flow only when the surface can publish", () => {
    assert.equal(resolveQuickAction(remoteless, false, false, false, true).kind, "open_publish");
  });

  it("never publishes by default, so mobile gets a hint instead of a dead button", () => {
    const quick = resolveQuickAction(remoteless, false, false, false);
    assert.equal(quick.kind, "show_hint");
    assert.isTrue(quick.disabled);
    assert.equal(quick.hint, 'Add an "origin" remote before pushing or creating a pull request.');
  });
});

describe("VCS terminology", () => {
  const jj = { kind: "jj" } as const;

  it("keeps Git nouns when the status carries no vcs field", () => {
    assert.equal(
      resolveQuickAction(status({ refName: null }), false).hint,
      "Create and check out a branch before pushing or opening a pull request.",
    );
    assert.equal(
      getGitActionDisabledReason({
        item: { id: "push", label: "Push", disabled: true, icon: "push", kind: "open_dialog" },
        gitStatus: status({ refName: null }),
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      "Detached HEAD: check out a branch before pushing.",
    );
    assert.equal(getVcsTerminology("unknown"), GIT_VCS_TERMINOLOGY);
    assert.equal(getVcsTerminology(null), GIT_VCS_TERMINOLOGY);
  });

  it("swaps to bookmark and change nouns under jj", () => {
    assert.equal(
      resolveQuickAction(status({ refName: null, vcs: jj }), false).hint,
      "No bookmark here: create one before pushing or opening a pull request.",
    );
    assert.equal(resolveQuickAction(status({ vcs: jj }), true).hint, "Jujutsu action in progress.");
    assert.equal(
      getGitActionDisabledReason({
        item: { id: "push", label: "Push", disabled: true, icon: "push", kind: "open_dialog" },
        gitStatus: status({ refName: null, vcs: jj }),
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      "No bookmark here: create one before pushing.",
    );
    assert.equal(
      getGitActionDisabledReason({
        item: {
          id: "commit",
          label: "Commit",
          disabled: true,
          icon: "commit",
          kind: "open_dialog",
        },
        gitStatus: status({ vcs: jj }),
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      "The working copy is clean. Make changes before committing.",
    );
  });
});

describe("an unsupported VCS", () => {
  const unsupported = status({
    hasWorkingTreeChanges: true,
    vcs: { kind: "jj", unsupportedReason: "jj 0.40.0 is older than the supported 0.42.0." },
  });

  it("disables every menu item", () => {
    assert.deepEqual(
      buildMenuItems(unsupported, false).map((item) => item.disabled),
      [true, true, true],
    );
  });

  it("surfaces the reason as the quick action hint", () => {
    const quick = resolveQuickAction(unsupported, false);
    assert.isTrue(quick.disabled);
    assert.equal(quick.hint, "jj 0.40.0 is older than the supported 0.42.0.");
  });

  it("surfaces the reason as the per-item disabled reason", () => {
    assert.equal(
      getGitActionDisabledReason({
        item: {
          id: "commit",
          label: "Commit",
          disabled: true,
          icon: "commit",
          kind: "open_dialog",
        },
        gitStatus: unsupported,
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      "jj 0.40.0 is older than the supported 0.42.0.",
    );
  });
});
