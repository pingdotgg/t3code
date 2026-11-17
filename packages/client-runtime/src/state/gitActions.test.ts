import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vite-plus/test";

import { DEFAULT_VCS_TERMINOLOGY, getVcsTerminology } from "@t3tools/shared/vcs";

import {
  buildMenuItems,
  getGitActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
} from "./gitActions.ts";
import { sourceControlClients } from "../sourceControlClients.ts";

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
  it.each([
    { kind: "github", shortLabel: "PR", article: "a" },
    { kind: "gitlab", shortLabel: "MR", article: "an" },
  ])("uses $shortLabel for $kind change requests", ({ kind, shortLabel, article }) => {
    const repository = status({
      sourceControlProvider: {
        kind: SourceControlProviderKind.make(kind),
        name: kind,
        baseUrl: `https://${kind}.com`,
      },
    });
    assert.equal(
      resolveQuickAction({ ...repository, aheadCount: 1 }, false).label,
      `Push & create ${shortLabel}`,
    );
    const requestItem = buildMenuItems(repository, false).find((item) => item.id === "pr");
    assert.isDefined(requestItem);
    assert.equal(requestItem.label, `Create ${shortLabel}`);
    assert.equal(
      getGitActionDisabledReason({
        item: requestItem,
        gitStatus: repository,
        isBusy: false,
        hasPrimaryRemote: true,
      }),
      `No local commits to include in ${article} ${shortLabel}.`,
    );
    assert.equal(
      resolveDefaultBranchActionDialogCopy({
        action: "commit_push_pr",
        branchName: "main",
        includesCommit: true,
        terminology: sourceControlClients.get(SourceControlProviderKind.make(kind)).changeRequest,
      }).continueLabel,
      `Commit, push & create ${shortLabel}`,
    );
  });
  it("explains a disabled request using the default-branch delta and behind state", () => {
    const item = {
      id: "pr",
      label: "Pull request",
      disabled: true,
      icon: "pr",
      kind: "open_dialog",
    } as const;
    const reason = (gitStatus: VcsStatusResult) =>
      getGitActionDisabledReason({ item, gitStatus, isBusy: false, hasPrimaryRemote: true });
    assert.equal(
      reason(status({ aheadCount: 0, aheadOfDefaultCount: 3, behindCount: 1 })),
      "Branch is behind upstream. Pull/rebase before creating a pull request.",
    );
    assert.equal(
      reason(status({ aheadCount: 3, aheadOfDefaultCount: 0 })),
      "No local commits to include in a PR.",
    );
  });
  it("gates the change-request item on aheadOfDefaultCount, not aheadCount", () => {
    const items = buildMenuItems(status({ aheadCount: 0, aheadOfDefaultCount: 3 }), false);
    assert.isFalse(items.find((item) => item.id === "pr")?.disabled);
  });

  it("offers creating a PR after the feature branch has been fully pushed", () => {
    const pushed = status({ aheadCount: 0, behindCount: 0, aheadOfDefaultCount: 1 });
    assert.containSubset(resolveQuickAction(pushed, false), {
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });
    assert.isTrue(resolveQuickAction({ ...pushed, isDefaultRef: true }, false, true).disabled);
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
    assert.equal(quick.hint, 'Add an "origin" remote before pushing or creating a PR.');
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
    assert.equal(getVcsTerminology("unknown"), DEFAULT_VCS_TERMINOLOGY);
    assert.equal(getVcsTerminology(null), DEFAULT_VCS_TERMINOLOGY);
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
