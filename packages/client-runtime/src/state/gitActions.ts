import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import { sourceControlClients, type ChangeRequestTerminology } from "../sourceControlClients.ts";
import {
  DEFAULT_VCS_TERMINOLOGY,
  resolveVcsTerminology,
  resolveVcsUnsupportedReason,
  type VcsTerminology,
} from "@t3tools/shared/vcs";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

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

export function changeRequestTerminologyFor(
  gitStatus: VcsStatusResult | null,
): ChangeRequestTerminology {
  return sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest;
}

/** jj has no detached HEAD, so the "you are not on a ref" hint is phrased per system. */
function noRefHint(
  gitStatus: VcsStatusResult,
  vcs: VcsTerminology,
  tail: string,
  resolve: MFunctionType,
): string {
  return gitStatus.vcs?.kind === "jj"
    ? resolve(msg("No {refNoun} here: create one before {tail}.", { refNoun: vcs.refNoun, tail }))
    : resolve(
        msg("Detached HEAD: check out a {refNoun} before {tail}.", { refNoun: vcs.refNoun, tail }),
      );
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
  resolve: MFunctionType = mFallback,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);
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
    !hasOpenPr &&
    hasDefaultBranchDelta &&
    !isBehind &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);

  const commitItem: GitActionMenuItem = {
    id: "commit",
    label: resolve(msg("Commit", { $context: "verb, git action" })),
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
    label: resolve(msg("Push", { $context: "verb, git action" })),
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
      label: resolve(msg("Create {shortLabel}", { shortLabel: terminology.shortLabel })),
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
  resolve: MFunctionType = mFallback,
): GitQuickAction {
  const vcs = resolveVcsTerminology(gitStatus);

  if (isBusy) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint:
        vcs.systemName === "Git"
          ? resolve(msg("Git action in progress."))
          : resolve(msg("{systemName} action in progress.", { systemName: vcs.systemName })),
    };
  }

  if (!gitStatus) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint:
        vcs.systemName === "Jujutsu"
          ? resolve(msg("{systemName} status is unavailable.", { systemName: vcs.systemName }))
          : resolve(msg("Git status is unavailable.")),
    };
  }

  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: unsupportedReason,
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
      hint:
        gitStatus.vcs?.kind === "jj"
          ? resolve(
              msg("No {refNoun} here: create one before pushing or opening a {singular}.", {
                refNoun: vcs.refNoun,
                singular: terminology.singular,
              }),
            )
          : resolve(
              msg("Create and check out a {refNoun} before pushing or opening a {singular}.", {
                refNoun: vcs.refNoun,
                singular: terminology.singular,
              }),
            ),
    };
  }

  if (hasChanges) {
    if (isBehind || (!gitStatus.hasUpstream && !hasPrimaryRemote)) {
      return {
        label: resolve(msg("Commit", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: "commit",
      };
    }
    if (hasOpenPr || isDefaultRef) {
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
    if (!hasPrimaryRemote) {
      if (canPublish) {
        return {
          label: resolve(msg("Publish repository")),
          disabled: false,
          kind: "open_publish",
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
          label: resolve(msg("Commit", { $context: "verb, git action" })),
          disabled: true,
          kind: "show_hint",
          hint: resolve(
            msg("{refNounTitle} is up to date. No action needed.", {
              refNounTitle: vcs.refNounTitle,
            }),
          ),
        };
      }
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: true,
        kind: "show_hint",
        hint: resolve(msg("No local commits to push.")),
      };
    }
    if (hasOpenPr || isDefaultRef) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
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
      label:
        vcs.systemName === "Jujutsu"
          ? resolve(msg("Sync {refNoun}", { refNoun: vcs.refNoun }))
          : resolve(msg("Sync branch")),
      disabled: true,
      kind: "show_hint",
      hint:
        vcs.systemName === "Jujutsu"
          ? resolve(
              msg("{refNounTitle} has diverged from upstream. Rebase/merge first.", {
                refNounTitle: vcs.refNounTitle,
              }),
            )
          : resolve(msg("Branch has diverged from upstream. Rebase/merge first.")),
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
    if (hasOpenPr || isDefaultRef) {
      return {
        label: resolve(msg("Push", { $context: "verb, git action" })),
        disabled: false,
        kind: "run_action",
        action: isDefaultRef ? "commit_push" : "push",
      };
    }
    return {
      label: resolve(msg("Push & create {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  // An open change request is surfaced by the standalone attribution row in the
  // details panel, so the action button rests in its disabled up-to-date state.
  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(
        msg("{refNounTitle} is up to date. No action needed.", { refNounTitle: vcs.refNounTitle }),
      ),
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
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
    hint:
      vcs.systemName === "Jujutsu"
        ? resolve(
            msg("{refNounTitle} is up to date. No action needed.", {
              refNounTitle: vcs.refNounTitle,
            }),
          )
        : resolve(msg("Branch is up to date. No action needed.")),
  };
}

export function getGitActionDisabledReason(
  input: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasPrimaryRemote: boolean;
  },
  resolve: MFunctionType = mFallback,
): string | null {
  const { item, gitStatus, isBusy, hasPrimaryRemote } = input;
  const vcs = resolveVcsTerminology(gitStatus);
  if (!item.disabled) return null;
  if (isBusy) return `${vcs.systemName} action in progress.`;
  if (!gitStatus) return `${vcs.systemName} status is unavailable.`;

  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null) return unsupportedReason;

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);

  if (item.id === "commit") {
    if (!hasChanges) {
      return vcs.systemName === "Jujutsu"
        ? resolve(
            msg("The {workingTreeNoun} is clean. Make changes before committing.", {
              workingTreeNoun: vcs.workingTreeNoun,
            }),
          )
        : resolve(msg("Worktree is clean. Make changes before committing."));
    }
    return resolve(msg("Commit is currently unavailable."));
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return noRefHint(gitStatus, vcs, "pushing", resolve);
    }
    if (hasChanges) {
      return resolve(msg("Commit or stash local changes before pushing."));
    }
    if (isBehind) {
      return vcs.systemName === "Jujutsu"
        ? resolve(
            msg("{refNounTitle} is behind upstream. Pull/rebase before pushing.", {
              refNounTitle: vcs.refNounTitle,
            }),
          )
        : resolve(msg("Branch is behind upstream. Pull/rebase before pushing."));
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return resolve(msg('Add an "origin" remote before pushing.'));
    }
    if (!isAhead) {
      return resolve(msg("No local commits to push."));
    }
    return resolve(msg("Push is currently unavailable."));
  }

  if (!hasBranch) {
    return noRefHint(gitStatus, vcs, `creating a ${terminology.singular}`, resolve);
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return resolve(
      msg(
        '{kind, select, pr {Add an "origin" remote before creating a PR.} mr {Add an "origin" remote before creating an MR.} generic {Add an "origin" remote before creating a change request.} other {Add an "origin" remote before creating {changeRequest}.}}',
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if (!hasDefaultBranchDelta) {
    return resolve(
      msg(
        "{kind, select, pr {No local commits to include in a PR.} mr {No local commits to include in an MR.} generic {No local commits to include in a change request.} other {No local commits to include in {changeRequest}.}}",
        { kind: changeRequestKind(terminology), changeRequest: terminology.shortLabelWithArticle },
      ),
    );
  }
  if (isBehind) {
    return resolve(
      msg("{refNounTitle} is behind upstream. Pull/rebase before creating a {singular}.", {
        refNounTitle: vcs.refNounTitle,
        singular: terminology.singular,
      }),
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

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    terminology?: ChangeRequestTerminology;
    vcsTerminology?: VcsTerminology;
  },
  resolve: MFunctionType = mFallback,
): DefaultBranchActionDialogCopy {
  const branchLabel = input.branchName;
  const vcs = input.vcsTerminology ?? DEFAULT_VCS_TERMINOLOGY;
  const terminology = input.terminology ?? sourceControlClients.get(undefined).changeRequest;
  const { shortLabel, shortLabelWithArticle } = terminology;

  if (input.action === "push" || input.action === "commit_push") {
    if (input.includesCommit) {
      return vcs.systemName === "Jujutsu"
        ? {
            title: resolve(msg("Commit & push to default {refNoun}?", { refNoun: vcs.refNoun })),
            description: resolve(
              msg(
                'This action will commit and push changes on "{branchLabel}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
                { branchLabel },
              ),
            ),
            continueLabel: resolve(msg("Commit & push to {branch}", { branch: branchLabel })),
          }
        : {
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
    return vcs.systemName === "Jujutsu"
      ? {
          title: resolve(msg("Push to default {refNoun}?", { refNoun: vcs.refNoun })),
          description: resolve(
            msg(
              'This action will push local commits on "{branchLabel}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
              { branchLabel },
            ),
          ),
          continueLabel: resolve(msg("Push to {branch}", { branch: branchLabel })),
        }
      : {
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
    return vcs.systemName === "Jujutsu"
      ? {
          title: resolve(
            msg("Commit, push & create {shortLabel} from default {refNoun}?", {
              shortLabel: terminology.shortLabel,
              refNoun: vcs.refNoun,
            }),
          ),
          description: resolve(
            msg(
              'This action will commit, push, and create {shortLabelWithArticle} on "{branchLabel}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
              { shortLabelWithArticle: terminology.shortLabelWithArticle, branchLabel },
            ),
          ),
          continueLabel: resolve(
            msg("Commit, push & create {shortLabel}", { shortLabel: terminology.shortLabel }),
          ),
        }
      : {
          title: resolve(
            msg("Commit, push & create {shortLabel} from default branch?", { shortLabel }),
          ),
          description: resolve(
            msg(
              '{kind, select, pr {This action will commit, push, and create a pull request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will commit, push, and create a merge request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will commit, push, and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will commit, push, and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
              {
                kind: changeRequestKind(terminology),
                changeRequest: shortLabelWithArticle,
                branch: branchLabel,
              },
            ),
          ),
          continueLabel: resolve(msg("Commit, push & create {shortLabel}", { shortLabel })),
        };
  }
  return vcs.systemName === "Jujutsu"
    ? {
        title: resolve(
          msg("Push & create {shortLabel} from default {refNoun}?", {
            shortLabel: terminology.shortLabel,
            refNoun: vcs.refNoun,
          }),
        ),
        description: resolve(
          msg(
            'This action will push local commits and create {shortLabelWithArticle} on "{branchLabel}". You can continue on this bookmark or create a feature bookmark and run the same action there.',
            { shortLabelWithArticle: terminology.shortLabelWithArticle, branchLabel },
          ),
        ),
        continueLabel: resolve(
          msg("Push & create {shortLabel}", { shortLabel: terminology.shortLabel }),
        ),
      }
    : {
        title: resolve(msg("Push & create {shortLabel} from default branch?", { shortLabel })),
        description: resolve(
          msg(
            '{kind, select, pr {This action will push local commits and create a pull request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} mr {This action will push local commits and create a merge request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} generic {This action will push local commits and create a change request on "{branch}". You can continue on this branch or create a feature branch and run the same action there.} other {This action will push local commits and create {changeRequest} on "{branch}". You can continue on this branch or create a feature branch and run the same action there.}}',
            {
              kind: changeRequestKind(terminology),
              changeRequest: shortLabelWithArticle,
              branch: branchLabel,
            },
          ),
        ),
        continueLabel: resolve(msg("Push & create {shortLabel}", { shortLabel })),
      };
}
