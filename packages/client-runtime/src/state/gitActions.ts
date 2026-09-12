import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "@t3tools/shared/sourceControl";
import {
  DEFAULT_VCS_TERMINOLOGY,
  resolveVcsTerminology,
  resolveVcsUnsupportedReason,
  type VcsTerminology,
} from "@t3tools/shared/vcs";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_publish" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface DefaultBranchActionDialogCopy {
  title: string;
  description: string;
  continueLabel: string;
}

export type DefaultBranchConfirmableAction =
  | "push"
  | "create_pr"
  | "commit_push"
  | "commit_push_pr";

export type GitActionRequestInput = Pick<
  GitRunStackedActionInput,
  "action" | "commitMessage" | "featureBranch" | "filePaths"
>;

function resolveChangeRequestTerminology(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return gitStatus?.sourceControlProvider
    ? getChangeRequestTerminology(gitStatus.sourceControlProvider)
    : DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}

/** jj has no detached HEAD, so the "you are not on a ref" hint is phrased per system. */
export function noRefHint(gitStatus: VcsStatusResult, vcs: VcsTerminology, tail: string): string {
  return gitStatus.vcs?.kind === "jj"
    ? `No ${vcs.refNoun} here: create one before ${tail}.`
    : `Detached HEAD: check out a ${vcs.refNoun} before ${tail}.`;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = resolveChangeRequestTerminology(gitStatus);
  // An unusable VCS blocks every action, the same way a run in flight does.
  const blocked = isBusy || resolveVcsUnsupportedReason(gitStatus) !== null;

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !blocked && hasChanges;
  const canPush =
    !blocked &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !blocked &&
    hasBranch &&
    !hasChanges &&
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: "Commit",
    disabled: !canCommit,
    icon: "commit",
    kind: "open_dialog",
    dialogAction: "commit",
  };

  if (!hasPrimaryRemote) {
    return [commitItem];
  }

  const pushItem: GitActionMenuItem = {
    id: "push",
    label: "Push",
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  };

  // An open change request is surfaced by the standalone attribution row, so
  // the menu offers no change-request entry at all while one is open.
  if (hasOpenPr) {
    return [commitItem, pushItem];
  }

  return [
    commitItem,
    pushItem,
    {
      id: "pr",
      label: `Create ${terminology.shortLabel}`,
      disabled: !canCreatePr,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    },
  ];
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
  canPublish = false,
): GitQuickAction {
  const vcs = resolveVcsTerminology(gitStatus);

  if (isBusy) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `${vcs.systemName} action in progress.`,
    };
  }

  if (!gitStatus) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `${vcs.systemName} status is unavailable.`,
    };
  }

  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null) {
    return { label: "Commit", disabled: true, kind: "show_hint", hint: unsupportedReason };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = resolveChangeRequestTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint:
        gitStatus.vcs?.kind === "jj"
          ? `No ${vcs.refNoun} here: create one before pushing or opening a ${terminology.singular}.`
          : `Create and check out a ${vcs.refNoun} before pushing or opening a ${terminology.singular}.`,
    };
  }

  if (hasChanges) {
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    }
    if (hasOpenPr || isDefaultRef) {
      return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    }
    return {
      label: `Commit, push & ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (canPublish) {
        return {
          label: "Publish repository",
          disabled: false,
          kind: "open_publish",
        };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: `Add an "origin" remote before pushing or creating a ${terminology.singular}.`,
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: "Commit",
          disabled: true,
          kind: "show_hint",
          hint: `${vcs.refNounTitle} is up to date. No action needed.`,
        };
      }
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: "No local commits to push.",
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: `Sync ${vcs.refNoun}`,
      disabled: true,
      kind: "show_hint",
      hint: `${vcs.refNounTitle} has diverged from upstream. Rebase/merge first.`,
    };
  }

  if (isBehind) {
    return {
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultRef) {
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: `Push & create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  // An open change request is surfaced by the standalone attribution row in the
  // details panel, so the action button rests in its disabled up-to-date state.
  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `${vcs.refNounTitle} is up to date. No action needed.`,
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: `Create ${terminology.shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: `${vcs.refNounTitle} is up to date. No action needed.`,
  };
}

export function getGitActionDisabledReason(input: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
}): string | null {
  const { item, gitStatus, isBusy, hasPrimaryRemote } = input;
  const vcs = resolveVcsTerminology(gitStatus);
  if (!item.disabled) return null;
  if (isBusy) return `${vcs.systemName} action in progress.`;
  if (!gitStatus) return `${vcs.systemName} status is unavailable.`;

  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null) return unsupportedReason;

  const terminology = resolveChangeRequestTerminology(gitStatus);
  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;

  if (item.id === "commit") {
    if (!hasChanges) {
      return `The ${vcs.workingTreeNoun} is clean. Make changes before committing.`;
    }
    return "Commit is currently unavailable.";
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return noRefHint(gitStatus, vcs, "pushing");
    }
    if (hasChanges) {
      return "Commit or stash local changes before pushing.";
    }
    if (isBehind) {
      return `${vcs.refNounTitle} is behind upstream. Pull/rebase before pushing.`;
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return 'Add an "origin" remote before pushing.';
    }
    if (!isAhead) {
      return "No local commits to push.";
    }
    return "Push is currently unavailable.";
  }

  if (hasOpenPr) {
    return `View ${terminology.shortLabel} is currently unavailable.`;
  }
  if (!hasBranch) {
    return noRefHint(gitStatus, vcs, `creating a ${terminology.singular}`);
  }
  if (hasChanges) {
    return `Commit local changes before creating a ${terminology.singular}.`;
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return `Add an "origin" remote before creating a ${terminology.singular}.`;
  }
  if (!isAhead) {
    return `No local commits to include in a ${terminology.singular}.`;
  }
  if (isBehind) {
    return `${vcs.refNounTitle} is behind upstream. Pull/rebase before creating a ${terminology.singular}.`;
  }
  return `Create ${terminology.shortLabel} is currently unavailable.`;
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultRef: boolean,
): boolean {
  if (!isDefaultRef) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  terminology?: ChangeRequestTerminology;
  vcsTerminology?: VcsTerminology;
}): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const vcs = input.vcsTerminology ?? DEFAULT_VCS_TERMINOLOGY;
  const suffix = ` on "${branchLabel}". You can continue on this ${vcs.refNoun} or create a feature ${vcs.refNoun} and run the same action there.`;
  const terminology = input.terminology ?? DEFAULT_CHANGE_REQUEST_TERMINOLOGY;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: `Commit & push to default ${vcs.refNoun}?`,
        description: `This action will commit and push changes${suffix}`,
        continueLabel: `Commit & push to ${branchLabel}`,
      };
    }
    return {
      title: `Push to default ${vcs.refNoun}?`,
      description: `This action will push local commits${suffix}`,
      continueLabel: `Push to ${branchLabel}`,
    };
  }

  if (input.includesCommit) {
    return {
      title: `Commit, push & create ${terminology.shortLabel} from default ${vcs.refNoun}?`,
      description: `This action will commit, push, and create a ${terminology.singular}${suffix}`,
      continueLabel: `Commit, push & create ${terminology.shortLabel}`,
    };
  }
  return {
    title: `Push & create ${terminology.shortLabel} from default ${vcs.refNoun}?`,
    description: `This action will push local commits and create a ${terminology.singular}${suffix}`,
    continueLabel: `Push & create ${terminology.shortLabel}`,
  };
}
