import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { type ChangeRequestTerminology, sourceControlClients } from "../sourceControlClients.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export type GitActionIconName = "commit" | "push" | "pr";

export type GitDialogAction = "commit" | "push" | "create_pr";

export interface GitActionMenuItem {
  id: "commit" | "push" | "pr";
  label: string;
  disabled: boolean;
  icon: GitActionIconName;
  kind: "open_dialog" | "open_pr";
  dialogAction?: GitDialogAction;
}

export interface GitQuickAction {
  label: string;
  disabled: boolean;
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint";
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

export function changeRequestTerminologyFor(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest;
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !hasChanges &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
    hasBranch &&
    !hasOpenPr &&
    (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0 &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canOpenPr = !isBusy && hasOpenPr;

  return [
    {
      id: "commit",
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: !canCommit,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
    {
      id: "push",
      label: resolve(msg("Push", { $context: "verb, git action" })),
      disabled: !canPush,
      icon: "push",
      kind: "open_dialog",
      dialogAction: "push",
    },
    hasOpenPr
      ? {
          id: "pr",
          label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: !canOpenPr,
          icon: "pr",
          kind: "open_pr",
        }
      : {
          id: "pr",
          label: resolve(msg("Create {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  ];
}

export function secondaryGitMenuItems(
  items: ReadonlyArray<GitActionMenuItem>,
  quickAction: GitQuickAction,
): GitActionMenuItem[] {
  return items.filter((item) =>
    item.kind === "open_pr"
      ? quickAction.kind !== "open_pr"
      : item.dialogAction !== quickAction.action,
  );
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
  resolve: MFunctionType = mFallback,
): GitQuickAction {
  if (isBusy) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git action in progress.")),
    };
  }

  if (!gitStatus) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Git status is unavailable.")),
    };
  }

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const isDiverged = isAhead && isBehind;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (!hasBranch) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(
        msg(
          "{kind, select, pr {Create and checkout a branch before pushing or opening a PR.} mr {Create and checkout a branch before pushing or opening an MR.} generic {Create and checkout a branch before pushing or opening a change request.} other {Create and checkout a branch before pushing or opening {changeRequest}.}}",
          {
            kind: changeRequestKind(terminology),
            changeRequest: terminology.shortLabelWithArticle,
          },
        ),
      ),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasOriginRemote)) {
      return {
        label: resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: "commit",
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: resolve(msg("Commit & push")),
        disabled: false,
        kind: "run_action",
        action: "commit_push",
      };
    }
    return {
      label: resolve(msg("Commit, push & {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (hasOpenPr && !isAhead) {
        return {
          label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: false,
          kind: "open_pr",
        };
      }
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(
          msg(
            '{kind, select, pr {Add an "origin" remote before pushing or creating a PR.} mr {Add an "origin" remote before pushing or creating an MR.} generic {Add an "origin" remote before pushing or creating a change request.} other {Add an "origin" remote before pushing or creating {changeRequest}.}}',
            {
              kind: changeRequestKind(terminology),
              changeRequest: terminology.shortLabelWithArticle,
            },
          ),
        ),
      };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: false,
          kind: "open_pr",
        };
      }
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(msg("No local commits to push.")),
      };
    }
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: resolve(msg("Push & create {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (isDiverged) {
    return {
      label: resolve(msg("Sync branch")),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Branch has diverged from upstream. Rebase/merge first.")),
    };
  }

  if (isBehind) {
    return {
      label: resolve(msg("Pull", { $context: "verb, git action" })),
      disabled: false,
      kind: "run_pull",
    };
  }

  if (isAhead) {
    if (hasOpenPr || isDefaultBranch) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    }
    return {
      label: resolve(msg("Push & create {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "open_pr",
    };
  }

  if (hasDefaultBranchDelta && !isDefaultBranch) {
    return {
      label: resolve(msg("Create {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  return {
    label: resolve(msg("Commit", { $context: "verb, git action" })),
    disabled: true,
    kind: "show_hint",
    hint: resolve(msg("Branch is up to date. No action needed.")),
  };
}

export function getGitActionDisabledReason(
  input: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasOriginRemote: boolean;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote } = input;
  if (!item.disabled) return null;
  if (isBusy) return resolve(msg("Git action in progress."));
  if (!gitStatus) return resolve(msg("Git status is unavailable."));

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (item.id === "commit") {
    if (!hasChanges) {
      return resolve(msg("Worktree is clean. Make changes before committing."));
    }
    return resolve(msg("Commit is currently unavailable."));
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return resolve(msg("Detached HEAD: checkout a branch before pushing."));
    }
    if (hasChanges) {
      return resolve(msg("Commit or stash local changes before pushing."));
    }
    if (isBehind) {
      return resolve(msg("Branch is behind upstream. Pull/rebase before pushing."));
    }
    if (!gitStatus.hasUpstream && !hasOriginRemote) {
      return resolve(msg('Add an "origin" remote before pushing.'));
    }
    if (!isAhead) {
      return resolve(msg("No local commits to push."));
    }
    return resolve(msg("Push is currently unavailable."));
  }

  if (hasOpenPr) {
    return resolve(
      msg("View {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel }),
    );
  }
  if (!hasBranch) {
    return resolve(
      msg(
        "{kind, select, pr {Detached HEAD: checkout a branch before creating a PR.} mr {Detached HEAD: checkout a branch before creating an MR.} generic {Detached HEAD: checkout a branch before creating a change request.} other {Detached HEAD: checkout a branch before creating {changeRequest}.}}",
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if (!gitStatus.hasUpstream && !hasOriginRemote) {
    return resolve(
      msg(
        '{kind, select, pr {Add an "origin" remote before creating a PR.} mr {Add an "origin" remote before creating an MR.} generic {Add an "origin" remote before creating a change request.} other {Add an "origin" remote before creating {changeRequest}.}}',
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return resolve(
      msg(
        "{kind, select, pr {No local commits to include in a PR.} mr {No local commits to include in an MR.} generic {No local commits to include in a change request.} other {No local commits to include in {changeRequest}.}}",
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if (isBehind) {
    return resolve(
      msg(
        "{kind, select, pr {Branch is behind upstream. Pull/rebase before creating a PR.} mr {Branch is behind upstream. Pull/rebase before creating an MR.} generic {Branch is behind upstream. Pull/rebase before creating a change request.} other {Branch is behind upstream. Pull/rebase before creating {changeRequest}.}}",
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  return resolve(
    msg("Create {shortLabel} is currently unavailable.", { shortLabel: terminology.shortLabel }),
  );
}

/** Picks the whole sentence for the provider's term; English keeps `shortLabelWithArticle`. */
function changeRequestKind(
  terminology: ChangeRequestTerminology,
): "pr" | "mr" | "generic" | "other" {
  switch (terminology.shortLabelWithArticle) {
    case "a PR":
      return "pr";
    case "an MR":
      return "mr";
    case "a change request":
      return "generic";
    default:
      return "other";
  }
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  if (!isDefaultBranch) return false;
  return (
    action === "push" ||
    action === "create_pr" ||
    action === "commit_push" ||
    action === "commit_push_pr"
  );
}

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    terminology: ChangeRequestTerminology;
  },
  resolve: MFunctionType = mFallback,
): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const { shortLabel, shortLabelWithArticle } = input.terminology;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return {
        title: resolve(msg("Commit & push to default branch?")),
        description: resolve(
          msg(
            'This action will commit and push changes on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
            { branch: branchLabel },
          ),
        ),
        continueLabel: resolve(msg("Commit & push to {branch}", { branch: branchLabel })),
      };
    }
    return {
      title: resolve(msg("Push to default branch?")),
      description: resolve(
        msg(
          'This action will push local commits on "{branch}". You can continue on this branch or create a feature branch and run the same action there.',
          { branch: branchLabel },
        ),
      ),
      continueLabel: resolve(msg("Push to {branch}", { branch: branchLabel })),
    };
  }

  if (input.includesCommit) {
    return {
      title: resolve(
        msg("Commit, push & create {shortLabel} from default branch?", { shortLabel }),
      ),
      description: resolve(
        msg(
          '{kind, select, pr {This action will commit, push, and create a PR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will commit, push, and create an MR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will commit, push, and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will commit, push, and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
          {
            kind: changeRequestKind(input.terminology),
            changeRequest: shortLabelWithArticle,
            branch: branchLabel,
          },
        ),
      ),
      continueLabel: resolve(msg("Commit, push & create {shortLabel}", { shortLabel })),
    };
  }
  return {
    title: resolve(msg("Push & create {shortLabel} from default branch?", { shortLabel })),
    description: resolve(
      msg(
        '{kind, select, pr {This action will push local commits and create a PR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will push local commits and create an MR on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will push local commits and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will push local commits and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
        {
          kind: changeRequestKind(input.terminology),
          changeRequest: shortLabelWithArticle,
          branch: branchLabel,
        },
      ),
    ),
    continueLabel: resolve(msg("Push & create {shortLabel}", { shortLabel })),
  };
}
