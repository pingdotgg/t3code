import type { GitStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  requiresDefaultBranchConfirmation,
  resolveAutoFeatureBranchName,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
  summarizeGitResult,
} from "./GitActionsControl.logic";

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    branch: "feature/test",
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

describe("when: branch is clean and has an open PR", () => {
  it("resolveQuickAction opens the existing PR", () => {
    const quick = resolveQuickAction(
      status({
        pr: {
          number: 10,
          title: "Open PR",
          url: "https://example.com/pr/10",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "open_pr", label: "View PR", disabled: false });
  });

  it("buildMenuItems disables commit/push and enables open PR", () => {
    const items = buildMenuItems(
      status({
        pr: {
          number: 11,
          title: "Existing PR",
          url: "https://example.com/pr/11",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: actions are busy", () => {
  it("resolveQuickAction returns running disabled state", () => {
    const quick = resolveQuickAction(status(), true);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git action in progress.",
    });
  });

  it("buildMenuItems disables all actions", () => {
    const items = buildMenuItems(status(), true);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: git status is unavailable", () => {
  it("resolveQuickAction returns unavailable disabled state", () => {
    const quick = resolveQuickAction(null, false);
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Git status is unavailable.",
    });
  });

  it("buildMenuItems returns no menu items", () => {
    const items = buildMenuItems(null, false);
    assert.deepEqual(items, []);
  });
});

describe("when: branch is clean, ahead, and has an open PR", () => {
  it("resolveQuickAction prefers push", () => {
    const quick = resolveQuickAction(
      status({
        aheadCount: 3,
        pr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "run_action", action: "commit_push", label: "Push" });
  });

  it("buildMenuItems enables push and keeps open PR available", () => {
    const items = buildMenuItems(
      status({
        aheadCount: 2,
        pr: {
          number: 12,
          title: "Existing PR",
          url: "https://example.com/pr/12",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "View PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: branch is clean, ahead, and has no open PR", () => {
  it("resolveQuickAction pushes and creates a PR", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, pr: null }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Push & create PR",
    });
  });

  it("buildMenuItems enables push and create PR, with commit disabled", () => {
    const items = buildMenuItems(status({ aheadCount: 2, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: branch is clean, up to date, and has no open PR", () => {
  it("resolveQuickAction returns disabled no-action state", () => {
    const quick = resolveQuickAction(
      status({ aheadCount: 0, behindCount: 0, hasWorkingTreeChanges: false, pr: null }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems disables commit, push, and create PR", () => {
    const items = buildMenuItems(status({ aheadCount: 0, behindCount: 0, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: branch is behind upstream", () => {
  it("resolveQuickAction returns pull", () => {
    const quick = resolveQuickAction(status({ behindCount: 2 }), false);
    assert.deepInclude(quick, { kind: "run_pull", label: "Pull", disabled: false });
  });

  it("buildMenuItems disables push and create PR", () => {
    const items = buildMenuItems(status({ behindCount: 1, pr: null }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: branch has diverged from upstream", () => {
  it("resolveQuickAction returns a disabled sync hint", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, behindCount: 1 }), false);
    assert.deepEqual(quick, {
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    });
  });
});

describe("when: working tree has local changes", () => {
  it("resolveQuickAction returns commit, push, and create PR", () => {
    const quick = resolveQuickAction(status({ hasWorkingTreeChanges: true }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, push & PR",
    });
  });

  it("resolveQuickAction returns commit and push when open PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        pr: {
          number: 16,
          title: "Existing PR",
          url: "https://example.com/pr/16",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Commit & push",
    });
  });

  it("buildMenuItems enables commit and disables push and PR", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: on default branch without open PR", () => {
  it("resolveQuickAction returns commit and push when local changes exist", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", hasWorkingTreeChanges: true }),
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

  it("resolveQuickAction returns push when branch is ahead", () => {
    const quick = resolveQuickAction(
      status({ branch: "main", aheadCount: 2, pr: null }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });
});

describe("when: working tree has local changes and branch is behind upstream", () => {
  it("resolveQuickAction still prefers commit, push, and create PR", () => {
    const quick = resolveQuickAction(
      status({ hasWorkingTreeChanges: true, behindCount: 1 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Commit, push & PR",
    });
  });

  it("buildMenuItems enables commit and keeps push and PR disabled", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, behindCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: false,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: HEAD is detached and there are no local changes", () => {
  it("resolveQuickAction shows detached head hint", () => {
    const quick = resolveQuickAction(
      status({ branch: null, hasWorkingTreeChanges: false, hasUpstream: false }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems keeps commit, push, and PR disabled", () => {
    const items = buildMenuItems(status({ branch: null, hasWorkingTreeChanges: false }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("when: branch has no upstream configured", () => {
  it("resolveQuickAction is disabled when clean, no upstream, and no local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({ hasUpstream: false, pr: null, aheadCount: 0 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction opens PR when clean, no upstream, no local commits are ahead, and PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        pr: {
          number: 14,
          title: "Existing PR",
          url: "https://example.com/pr/14",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "open_pr",
      label: "View PR",
      disabled: false,
    });
  });

  it("resolveQuickAction runs push when clean, no upstream, and local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        pr: {
          number: 15,
          title: "Existing PR",
          url: "https://example.com/pr/15",
          baseBranch: "main",
          headBranch: "feature/test",
          state: "open",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems disables push and create PR when no commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 0 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

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
      action: "commit_push_pr",
      label: "Push & create PR",
      disabled: false,
    });
  });

  it("buildMenuItems enables create PR when no upstream and commits are ahead", () => {
    const items = buildMenuItems(status({ hasUpstream: false, pr: null, aheadCount: 2 }), false);
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: false,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: false,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });

  it("resolveQuickAction is disabled on default branch when no upstream exists and no commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        branch: "main",
        hasUpstream: false,
        aheadCount: 0,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Push",
      hint: "No local commits to push.",
      disabled: true,
    });
  });

  it("resolveQuickAction uses push-only on default branch when no upstream exists and commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        branch: "main",
        hasUpstream: false,
        aheadCount: 1,
        pr: null,
      }),
      false,
      true,
    );
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push",
      label: "Push",
      disabled: false,
    });
  });

  it("buildMenuItems still disables push and create PR when branch is behind", () => {
    const items = buildMenuItems(
      status({
        hasUpstream: false,
        behindCount: 1,
        aheadCount: 0,
        pr: null,
      }),
      false,
    );
    assert.deepEqual(items, [
      {
        id: "commit",
        label: "Commit",
        disabled: true,
        icon: "commit",
        kind: "open_dialog",
        dialogAction: "commit",
      },
      {
        id: "push",
        label: "Push",
        disabled: true,
        icon: "push",
        kind: "open_dialog",
        dialogAction: "push",
      },
      {
        id: "pr",
        label: "Create PR",
        disabled: true,
        icon: "pr",
        kind: "open_dialog",
        dialogAction: "create_pr",
      },
    ]);
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("requires confirmation for push actions on default branch", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
  });
});

describe("resolveDefaultBranchActionDialogCopy", () => {
  it("uses push-only copy when pushing without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push to default branch?",
      description:
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push to main",
    });
  });

  it("uses push-and-pr copy when creating a PR without a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: false,
    });

    assert.deepEqual(copy, {
      title: "Push & create PR from default branch?",
      description:
        'This action will push local commits and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push & create PR",
    });
  });

  it("keeps commit copy when the action includes a commit", () => {
    const copy = resolveDefaultBranchActionDialogCopy({
      action: "commit_push_pr",
      branchName: "main",
      includesCommit: true,
    });

    assert.deepEqual(copy, {
      title: "Commit, push & create PR from default branch?",
      description:
        'This action will commit, push, and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Commit, push & create PR",
    });
  });
});

describe("buildGitActionProgressStages", () => {
  it("shows only push progress when push-only is forced", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      forcePushOnly: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test..."]);
  });

  it("skips commit stages for create-pr flow when push-only is forced", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push_pr",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      forcePushOnly: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, ["Pushing to origin/feature/test...", "Creating PR..."]);
  });

  it("includes commit stages for commit+push when working tree is dirty", () => {
    const stages = buildGitActionProgressStages({
      action: "commit_push",
      hasCustomCommitMessage: false,
      hasWorkingTreeChanges: true,
      pushTarget: "origin/feature/test",
    });
    assert.deepEqual(stages, [
      "Generating commit message...",
      "Committing...",
      "Pushing to origin/feature/test...",
    ]);
  });
});

describe("summarizeGitResult", () => {
  it("returns commit-focused toast for commit action", () => {
    const result = summarizeGitResult({
      action: "commit",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "0123456789abcdef",
        subject: "feat: add optimistic UI for git action button",
      },
      push: { status: "skipped_not_requested" },
      pr: { status: "skipped_not_requested" },
    });

    assert.deepEqual(result, {
      title: "Committed 0123456",
      description: "feat: add optimistic UI for git action button",
    });
  });

  it("returns push-focused toast for push action", () => {
    const result = summarizeGitResult({
      action: "commit_push",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "abcdef0123456789",
        subject: "fix: tighten quick action tooltip hover handling",
      },
      push: {
        status: "pushed",
        branch: "foo",
        upstreamBranch: "origin/foo",
      },
      pr: { status: "skipped_not_requested" },
    });

    assert.deepEqual(result, {
      title: "Pushed abcdef0 to origin/foo",
      description: "fix: tighten quick action tooltip hover handling",
    });
  });

  it("returns PR-focused toast for created PR action", () => {
    const result = summarizeGitResult({
      action: "commit_push_pr",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "feat: ship github shortcuts",
      },
      push: {
        status: "pushed",
        branch: "foo",
      },
      pr: {
        status: "created",
        number: 42,
        title: "feat: ship github shortcuts and improve PR CTA in success toast",
      },
    });

    assert.deepEqual(result, {
      title: "Created PR #42",
      description: "feat: ship github shortcuts and improve PR CTA in success toast",
    });
  });

  it("truncates long description text", () => {
    const result = summarizeGitResult({
      action: "commit_push_pr",
      branch: { status: "skipped_not_requested" },
      commit: {
        status: "created",
        commitSha: "89abcdef01234567",
        subject: "short subject",
      },
      push: { status: "pushed", branch: "foo" },
      pr: {
        status: "created",
        number: 99,
        title:
          "feat: this title is intentionally extremely long so we can validate that toast descriptions are truncated with an ellipsis suffix",
      },
    });

    assert.deepEqual(result, {
      title: "Created PR #99",
      description: "feat: this title is intentionally extremely long so we can validate t...",
    });
  });
});

describe("resolveAutoFeatureBranchName", () => {
  it("uses semantic preferred branch names when available", () => {
    const branch = resolveAutoFeatureBranchName(["main", "feature/other"], "fix toast copy");
    assert.equal(branch, "feature/fix-toast-copy");
  });

  it("normalizes preferred names that already include a branch namespace", () => {
    const branch = resolveAutoFeatureBranchName(["main"], "feature/refine-toolbar-actions");
    assert.equal(branch, "feature/refine-toolbar-actions");
  });

  it("increments suffix when the preferred branch name already exists", () => {
    const branch = resolveAutoFeatureBranchName(
      ["main", "feature/fix-toast-copy", "feature/fix-toast-copy-2"],
      "fix toast copy",
    );
    assert.equal(branch, "feature/fix-toast-copy-3");
  });

  it("treats existing branch names as case-insensitive for collision checks", () => {
    const branch = resolveAutoFeatureBranchName(["Feature/Ticket-1"], "feature/ticket-1");
    assert.equal(branch, "feature/ticket-1-2");
  });

  it("falls back to feature/update when no preferred name is provided", () => {
    const branch = resolveAutoFeatureBranchName(["main"]);
    assert.equal(branch, "feature/update");
  });
});
