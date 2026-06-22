import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";

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
