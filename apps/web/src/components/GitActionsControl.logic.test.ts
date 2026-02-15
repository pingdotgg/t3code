import type { GitStatusResult } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  requiresDefaultBranchConfirmation,
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
    openPr: null,
    ...overrides,
  };
}

describe("when: branch is clean and has an open PR", () => {
  it("resolveQuickAction opens the existing PR", () => {
    const quick = resolveQuickAction(
      status({
        openPr: {
          number: 10,
          title: "Open PR",
          url: "https://example.com/pr/10",
          baseBranch: "main",
          headBranch: "feature/test",
        },
      }),
      false,
    );
    assert.deepInclude(quick, { kind: "open_pr", label: "Open PR", disabled: false });
  });

  it("buildMenuItems disables commit/push and enables open PR", () => {
    const items = buildMenuItems(
      status({
        openPr: {
          number: 11,
          title: "Existing PR",
          url: "https://example.com/pr/11",
          baseBranch: "main",
          headBranch: "feature/test",
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
        label: "Open PR",
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
        openPr: {
          number: 13,
          title: "Open PR",
          url: "https://example.com/pr/13",
          baseBranch: "main",
          headBranch: "feature/test",
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
        openPr: {
          number: 12,
          title: "Existing PR",
          url: "https://example.com/pr/12",
          baseBranch: "main",
          headBranch: "feature/test",
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
        label: "Open PR",
        disabled: false,
        icon: "pr",
        kind: "open_pr",
      },
    ]);
  });
});

describe("when: branch is clean, ahead, and has no open PR", () => {
  it("resolveQuickAction pushes and creates a PR", () => {
    const quick = resolveQuickAction(status({ aheadCount: 2, openPr: null }), false);
    assert.deepInclude(quick, {
      kind: "run_action",
      action: "commit_push_pr",
      label: "Push & create PR",
    });
  });

  it("buildMenuItems enables push and create PR, with commit disabled", () => {
    const items = buildMenuItems(status({ aheadCount: 2, openPr: null }), false);
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
      status({ aheadCount: 0, behindCount: 0, hasWorkingTreeChanges: false, openPr: null }),
      false,
    );
    assert.deepInclude(quick, { kind: "show_hint", label: "Commit", disabled: true });
  });

  it("buildMenuItems disables commit, push, and create PR", () => {
    const items = buildMenuItems(status({ aheadCount: 0, behindCount: 0, openPr: null }), false);
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
    const items = buildMenuItems(status({ behindCount: 1, openPr: null }), false);
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
      label: "Commit, push & create PR",
    });
  });

  it("resolveQuickAction returns commit and push when open PR exists", () => {
    const quick = resolveQuickAction(
      status({
        hasWorkingTreeChanges: true,
        openPr: {
          number: 16,
          title: "Existing PR",
          url: "https://example.com/pr/16",
          baseBranch: "main",
          headBranch: "feature/test",
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
      status({ branch: "main", aheadCount: 2, openPr: null }),
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
      label: "Commit, push & create PR",
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
  it("resolveQuickAction returns disabled commit state when clean and no commits are ahead", () => {
    const quick = resolveQuickAction(
      status({ hasUpstream: false, openPr: null, aheadCount: 0 }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
    });
  });

  it("resolveQuickAction remains disabled when clean, no upstream, and no local commits ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 0,
        openPr: {
          number: 14,
          title: "Existing PR",
          url: "https://example.com/pr/14",
          baseBranch: "main",
          headBranch: "feature/test",
        },
      }),
      false,
    );
    assert.deepInclude(quick, {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
    });
  });

  it("resolveQuickAction runs push when clean, no upstream, and local commits are ahead", () => {
    const quick = resolveQuickAction(
      status({
        hasUpstream: false,
        aheadCount: 1,
        openPr: {
          number: 15,
          title: "Existing PR",
          url: "https://example.com/pr/15",
          baseBranch: "main",
          headBranch: "feature/test",
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
    const items = buildMenuItems(
      status({ hasUpstream: false, openPr: null, aheadCount: 0 }),
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
  it("requires confirmation only for push actions on default branch", () => {
    assert.isFalse(requiresDefaultBranchConfirmation("commit", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push", true));
    assert.isTrue(requiresDefaultBranchConfirmation("commit_push_pr", true));
    assert.isFalse(requiresDefaultBranchConfirmation("commit_push", false));
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
