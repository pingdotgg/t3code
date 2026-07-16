import type {
  GitStackedAction,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
} from "@t3tools/contracts";

/**
 * Fold the VCS-status stream's split local/remote results into the combined
 * status the UI + action logic expect. Remote may be absent (no upstream
 * resolved yet) — fall back to "no remote" defaults. Null until the first local.
 */
export function mergeVcsStatus(
  local: VcsStatusLocalResult | null,
  remote: VcsStatusRemoteResult | null,
): VcsStatusResult | null {
  if (!local) return null;
  return {
    ...local,
    hasUpstream: remote?.hasUpstream ?? false,
    aheadCount: remote?.aheadCount ?? 0,
    behindCount: remote?.behindCount ?? 0,
    pr: remote?.pr ?? null,
    ...(remote?.aheadOfDefaultCount !== undefined
      ? { aheadOfDefaultCount: remote.aheadOfDefaultCount }
      : {}),
  } as VcsStatusResult;
}

// Pure git quick-action + menu logic, ported from the web's
// GitActionsControl.logic.ts (buildMenuItems / resolveQuickAction). Given a
// folded VCS status + busy flag it decides the single recommended action label
// (e.g. "Commit", "Push & create PR", "View PR") and the contextual menu items.
// "PR" terminology is fixed (the TUI doesn't resolve provider-specific labels).

export type GitQuickAction =
  | { readonly kind: "run_action"; readonly label: string; readonly action: GitStackedAction; readonly disabled: false }
  | { readonly kind: "open_pr"; readonly label: string; readonly disabled: false }
  | { readonly kind: "open_publish"; readonly label: string; readonly disabled: false }
  | { readonly kind: "run_pull"; readonly label: string; readonly disabled: false }
  | { readonly kind: "show_hint"; readonly label: string; readonly disabled: true; readonly hint: string };

export interface GitMenuItem {
  readonly id: "commit" | "push" | "pr";
  readonly label: string;
  readonly disabled: boolean;
  /** The stacked action to run, or null for "View PR" (open the URL instead). */
  readonly action: GitStackedAction | null;
  /** Set for the "View PR" item — the PR URL to open. */
  readonly openUrl?: string;
}

export type GitPanelAction =
  | {
      readonly id: string;
      readonly label: string;
      readonly primary: boolean;
      readonly disabled: boolean;
      readonly hint?: string;
      readonly kind: "git";
      readonly action: GitStackedAction;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly primary: boolean;
      readonly disabled: boolean;
      readonly hint?: string;
      readonly kind: "pull";
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly primary: boolean;
      readonly disabled: boolean;
      readonly hint?: string;
      readonly kind: "url";
      readonly url: string;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly primary: boolean;
      readonly disabled: true;
      readonly hint: string;
      readonly kind: "unavailable";
    };

const COMMIT_BEARING = new Set<GitStackedAction>(["commit", "commit_push", "commit_push_pr"]);

/** Whether a stacked action creates a commit and therefore needs a message. */
export function gitActionNeedsCommitMessage(action: GitStackedAction): boolean {
  return COMMIT_BEARING.has(action);
}

/** The single most-relevant action for the current branch state. */
export function resolveGitQuickAction(
  status: VcsStatusResult | null,
  isBusy: boolean,
): GitQuickAction {
  if (isBusy) {
    return { kind: "show_hint", label: "Commit", disabled: true, hint: "Git action in progress." };
  }
  if (!status) {
    return { kind: "show_hint", label: "Commit", disabled: true, hint: "Git status is unavailable." };
  }
  if (!status.isRepo) {
    return {
      kind: "show_hint",
      label: "Initialize repository",
      disabled: true,
      hint: "Repository initialization is not available in the TUI yet.",
    };
  }

  const hasBranch = status.refName !== null;
  const hasChanges = status.hasWorkingTreeChanges;
  const hasOpenPr = status.pr?.state === "open";
  const isAhead = status.aheadCount > 0;
  const hasDefaultBranchDelta = (status.aheadOfDefaultCount ?? status.aheadCount) > 0;
  const isBehind = status.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const isDefaultRef = status.isDefaultRef;
  const hasPrimaryRemote = status.hasPrimaryRemote;

  if (!hasBranch) {
    return {
      kind: "show_hint",
      label: "Commit",
      disabled: true,
      hint: "Create and checkout a ref before pushing or opening a PR.",
    };
  }

  if (hasChanges) {
    if (!status.hasUpstream && !hasPrimaryRemote) {
      return { kind: "run_action", label: "Commit", action: "commit", disabled: false };
    }
    if (hasOpenPr || isDefaultRef) {
      return { kind: "run_action", label: "Commit & push", action: "commit_push", disabled: false };
    }
    return { kind: "run_action", label: "Commit, push & PR", action: "commit_push_pr", disabled: false };
  }

  if (!status.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) return { kind: "open_pr", label: "View PR", disabled: false };
      return { kind: "open_publish", label: "Publish repository", disabled: false };
    }
    if (!isAhead) {
      if (hasOpenPr) return { kind: "open_pr", label: "View PR", disabled: false };
      return { kind: "show_hint", label: "Push", disabled: true, hint: "No local commits to push." };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        kind: "run_action",
        label: "Push",
        action: isDefaultRef ? "commit_push" : "push",
        disabled: false,
      };
    }
    return { kind: "run_action", label: "Push & create PR", action: "create_pr", disabled: false };
  }

  if (isDiverged) {
    return {
      kind: "show_hint",
      label: "Sync ref",
      disabled: true,
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    };
  }

  if (isBehind) {
    return { kind: "run_pull", label: "Pull", disabled: false };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        kind: "run_action",
        label: "Push",
        action: isDefaultRef ? "commit_push" : "push",
        disabled: false,
      };
    }
    return { kind: "run_action", label: "Push & create PR", action: "create_pr", disabled: false };
  }

  if (hasOpenPr && status.hasUpstream) {
    return { kind: "open_pr", label: "View PR", disabled: false };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return { kind: "run_action", label: "Create PR", action: "create_pr", disabled: false };
  }

  return {
    kind: "show_hint",
    label: "Commit",
    disabled: true,
    hint: "Branch is up to date. No action needed.",
  };
}

/** The contextual Commit / Push / Create-or-View-PR menu for the actions list. */
export function buildGitMenuItems(
  status: VcsStatusResult | null,
  isBusy: boolean,
): GitMenuItem[] {
  if (!status) return [];

  const hasBranch = status.refName !== null;
  const hasChanges = status.hasWorkingTreeChanges;
  const hasOpenPr = status.pr?.state === "open";
  const isBehind = status.behindCount > 0;
  const hasDefaultBranchDelta = (status.aheadOfDefaultCount ?? status.aheadCount) > 0;
  const canPushWithoutUpstream = status.hasPrimaryRemote && !status.hasUpstream;
  const hasRemoteReady = status.hasUpstream || canPushWithoutUpstream;

  const canCommit = !isBusy && hasChanges;
  const canPush = !isBusy && hasBranch && !isBehind && status.aheadCount > 0 && hasRemoteReady;
  const canCreatePr =
    !isBusy && hasBranch && !hasChanges && !hasOpenPr && hasDefaultBranchDelta && !isBehind && hasRemoteReady;
  const canOpenPr = !isBusy && hasOpenPr;

  const commitItem: GitMenuItem = {
    id: "commit",
    label: "Commit",
    disabled: !canCommit,
    action: "commit",
  };
  if (!status.hasPrimaryRemote) return [commitItem];

  const prItem: GitMenuItem = hasOpenPr
    ? { id: "pr", label: "View PR", disabled: !canOpenPr, action: null, openUrl: status.pr?.url }
    : { id: "pr", label: "Create PR", disabled: !canCreatePr, action: "create_pr" };

  return [
    commitItem,
    { id: "push", label: "Push", disabled: !canPush, action: "push" },
    prItem,
  ];
}

function menuItemDisabledHint(
  item: GitMenuItem,
  status: VcsStatusResult,
  isBusy: boolean,
): string | undefined {
  if (!item.disabled) return undefined;
  if (isBusy) return "A git action is already in progress.";
  if (item.id === "commit") return "No uncommitted changes.";
  if (item.id === "push") {
    if (status.behindCount > 0) return "Pull or rebase before pushing.";
    if (status.refName === null) return "Checkout a branch before pushing.";
    if (!status.hasPrimaryRemote) return "Publish the repository before pushing.";
    return "No local commits to push.";
  }
  if (status.behindCount > 0) return "Pull or rebase before creating a PR.";
  if (status.hasWorkingTreeChanges) return "Commit changes before creating a PR.";
  return "No commits are ready for a PR.";
}

/**
 * Build the complete, keyboard-navigable source-control panel action list.
 * This keeps mouse and keyboard activation on the same action model.
 */
export function buildGitPanelActions(
  status: VcsStatusResult | null,
  isBusy: boolean,
): GitPanelAction[] {
  const quick = resolveGitQuickAction(status, isBusy);
  const actions: GitPanelAction[] = [];

  if (quick.kind === "run_action") {
    actions.push({
      id: "quick",
      label: quick.label,
      primary: true,
      disabled: false,
      kind: "git",
      action: quick.action,
    });
  } else if (quick.kind === "run_pull") {
    actions.push({
      id: "quick",
      label: quick.label,
      primary: true,
      disabled: false,
      kind: "pull",
    });
  } else if (quick.kind === "open_pr" && status?.pr) {
    actions.push({
      id: "quick",
      label: quick.label,
      primary: true,
      disabled: false,
      kind: "url",
      url: status.pr.url,
      hint: "Ctrl-click the link, or press Enter to copy it.",
    });
  } else if (quick.kind === "open_publish") {
    actions.push({
      id: "quick",
      label: quick.label,
      primary: true,
      disabled: true,
      kind: "unavailable",
      hint: "Repository publishing is not available in the TUI yet.",
    });
  } else if (quick.kind === "show_hint") {
    actions.push({
      id: "quick",
      label: quick.label,
      primary: true,
      disabled: true,
      kind: "unavailable",
      hint: quick.hint,
    });
  } else {
    actions.push({
      id: "quick",
      label: quick.label,
      primary: true,
      disabled: true,
      kind: "unavailable",
      hint: "Pull request link is unavailable.",
    });
  }

  if (!status || !status.isRepo) return actions;
  for (const item of buildGitMenuItems(status, isBusy)) {
    if (item.openUrl) {
      const hint = item.disabled
        ? menuItemDisabledHint(item, status, isBusy)
        : "Ctrl-click the link, or press Enter to copy it.";
      actions.push({
        id: `menu-${item.id}`,
        label: item.label,
        primary: false,
        disabled: item.disabled,
        kind: "url",
        url: item.openUrl,
        ...(hint === undefined ? {} : { hint }),
      });
    } else if (item.action) {
      const hint = menuItemDisabledHint(item, status, isBusy);
      actions.push({
        id: `menu-${item.id}`,
        label: item.label,
        primary: false,
        disabled: item.disabled,
        kind: "git",
        action: item.action,
        ...(hint === undefined ? {} : { hint }),
      });
    }
  }
  return actions;
}
