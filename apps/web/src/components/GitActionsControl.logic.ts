import type {
  GitRunStackedActionResult,
  GitStackedAction,
  PullRequestChangeBreakdown,
  ReviewDiffPreviewSource,
  VcsStatusResult,
} from "@t3tools/contracts";
import { summarizeChangedFiles } from "@t3tools/shared/changedFileKind";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { resolveVcsTerminology, type VcsTerminology } from "@t3tools/shared/vcs";
import { msg } from "gt-react";
import { m, type MessageResolver } from "../i18n/messages";
import { changeRequestTermKind } from "./pullRequest/changeRequestTerm";
import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  changeRequestTerminologyFor,
  resolveDefaultBranchActionDialogCopy as sharedDefaultBranchActionDialogCopy,
  type DefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
  type GitDialogAction,
  vcsActionLabelText,
} from "@t3tools/client-runtime/state/vcs";

export {
  requiresDefaultBranchConfirmation,
  type DefaultBranchConfirmableAction,
  type GitActionIconName,
} from "@t3tools/client-runtime/state/vcs";

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
  kind: "run_action" | "run_pull" | "open_publish" | "open_pr" | "show_hint";
  action?: GitStackedAction;
  hint?: string;
}

export interface GitActionProgressPresentation {
  readonly status: string;
  readonly output: string | null;
  readonly startedAtMs: number | null;
}

export interface GitActionResultToastTiming {
  readonly timeout: 0;
  readonly dismissAfterVisibleMs: number | null;
}

export const GIT_ACTION_SUCCESS_VISIBLE_MS = 10_000;

export function resolveGitActionResultToastTiming(
  type: "error" | "success",
): GitActionResultToastTiming {
  return {
    timeout: 0,
    dismissAfterVisibleMs: type === "success" ? GIT_ACTION_SUCCESS_VISIBLE_MS : null,
  };
}

export function resolveGitActionProgressPresentation(
  input: {
    readonly isRunning: boolean;
    readonly operation: string | null;
    readonly currentLabel: string | null;
    readonly hookName?: string | null;
    readonly lastOutputLine: string | null;
    readonly phaseStartedAtMs: number | null;
    readonly hookStartedAtMs: number | null;
  },
  resolve: MessageResolver = m,
): GitActionProgressPresentation | null {
  if (
    !input.isRunning ||
    (input.operation !== "run_change_request" && input.operation !== "pull")
  ) {
    return null;
  }

  const currentLabel = input.currentLabel?.trim();
  const output = input.lastOutputLine?.trim();
  const isPull = input.operation === "pull";
  return {
    status:
      currentLabel && currentLabel !== "Running source control action"
        ? (vcsActionLabelText({ currentLabel, hookName: input.hookName ?? null }, resolve) ??
          currentLabel)
        : isPull
          ? resolve(msg("Pulling latest changes..."))
          : resolve(msg("Starting source control action...")),
    output: !isPull && output ? output : null,
    startedAtMs: isPull
      ? input.phaseStartedAtMs
      : (input.hookStartedAtMs ?? input.phaseStartedAtMs),
  };
}

export function formatGitActionElapsed(
  startedAtMs: number | null,
  nowMs: number,
  resolve: MessageResolver = m,
): string | null {
  if (startedAtMs === null) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
  if (elapsedSeconds < 60) {
    return resolve(msg("{seconds}s", { seconds: elapsedSeconds }));
  }

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return resolve(msg("{minutes}m {seconds}s", { minutes, seconds }));
}

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasPrimaryRemote = true,
  resolve: MessageResolver = m,
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const terminology = changeRequestTerminologyFor(gitStatus);

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isBehind = gitStatus.behindCount > 0;
  const hasDefaultBranchDelta = (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0;
  const canPushWithoutUpstream = hasPrimaryRemote && !gitStatus.hasUpstream;
  const canCommit = !isBusy && hasChanges;
  const canPush =
    !isBusy &&
    hasBranch &&
    !isBehind &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !isBusy &&
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

  if (hasOpenPr) {
    return [commitItem, pushItem];
  }

  return [
    commitItem,
    pushItem,
    {
      id: "pr",
      label: resolve(
        msg("Create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: !canCreatePr,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    },
  ];
}

export function getMenuActionDisabledReason(
  {
    item,
    gitStatus,
    isBusy,
    hasPrimaryRemote,
  }: {
    item: GitActionMenuItem;
    gitStatus: VcsStatusResult | null;
    isBusy: boolean;
    hasPrimaryRemote: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  if (!item.disabled) return null;
  if (isBusy) return resolve(msg("Git action in progress."));
  if (!gitStatus) return resolve(msg("Git status is unavailable."));

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = changeRequestTerminologyFor(gitStatus);
  const vcs = resolveVcsTerminology(gitStatus);

  if (item.id === "commit") {
    if (!hasChanges) {
      return vcs.systemName === "Jujutsu"
        ? resolve(
            msg("{workspaceNounTitle} is clean. Make changes before committing.", {
              workspaceNounTitle: vcs.workspaceNounTitle,
            }),
          )
        : resolve(msg("Worktree is clean. Make changes before committing."));
    }
    return resolve(msg("Commit is currently unavailable."));
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return vcs.systemName === "Jujutsu"
        ? resolve(msg("Check out a {refNoun} before pushing.", { refNoun: vcs.refNoun }))
        : resolve(msg("Detached HEAD: check out a branch before pushing."));
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
    return vcs.systemName === "Jujutsu"
      ? resolve(
          msg("Check out a {refNoun} before creating a {singular}.", {
            refNoun: vcs.refNoun,
            singular: terminology.singular,
          }),
        )
      : resolve(
          msg(
            "Detached HEAD: check out a branch before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
            { term: changeRequestTermKind(terminology) },
          ),
        );
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return resolve(
      msg(
        'Add an "origin" remote before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.',
        { term: changeRequestTermKind(terminology) },
      ),
    );
  }
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0) {
    return resolve(
      msg(
        "No local commits to include in a {term, select, mr {merge request} cr {change request} other {pull request}}.",
        { term: changeRequestTermKind(terminology) },
      ),
    );
  }
  if (isBehind) {
    return vcs.systemName === "Jujutsu"
      ? resolve(
          msg("{refNounTitle} is behind upstream. Pull/rebase before creating a {singular}.", {
            refNounTitle: vcs.refNounTitle,
            singular: terminology.singular,
          }),
        )
      : resolve(
          msg(
            "Branch is behind upstream. Pull/rebase before creating a {term, select, mr {merge request} cr {change request} other {pull request}}.",
            { term: changeRequestTermKind(terminology) },
          ),
        );
  }
  return resolve(
    msg(
      "Create {term, select, mr {merge request} cr {change request} other {pull request}} is currently unavailable.",
      { term: changeRequestTermKind(terminology) },
    ),
  );
}

export function hasUsableGitMenuContent(input: {
  readonly menuItems: readonly GitActionMenuItem[];
  readonly canWriteSourceControl: boolean;
  readonly canPublishRepository: boolean;
  readonly hasNotice: boolean;
}): boolean {
  return (
    input.canPublishRepository ||
    input.hasNotice ||
    (input.canWriteSourceControl && input.menuItems.some((item) => !item.disabled))
  );
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultRef = false,
  hasPrimaryRemote = true,
  canPublishRepository = false,
  resolve: MessageResolver = m,
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
  const vcs = resolveVcsTerminology(gitStatus);

  if (!hasBranch) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint:
        vcs.systemName === "Jujutsu"
          ? resolve(
              msg("Create and check out a {refNoun} before pushing or opening a {singular}.", {
                refNoun: vcs.refNoun,
                singular: terminology.singular,
              }),
            )
          : resolve(
              msg(
                "Create and checkout a ref before pushing or opening a {term, select, mr {merge request} cr {change request} other {pull request}}.",
                { term: changeRequestTermKind(terminology) },
              ),
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
      label: resolve(
        msg("Commit, push & {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }

  if (!gitStatus.hasUpstream) {
    if (!hasPrimaryRemote) {
      if (hasOpenPr && !isAhead) {
        return {
          label: resolve(msg("View {shortLabel}", { shortLabel: terminology.shortLabel })),
          disabled: false,
          kind: "open_pr",
        };
      }
      return canPublishRepository
        ? { label: resolve(msg("Publish repository")), disabled: false, kind: "open_publish" }
        : {
            label: resolve(msg("Publish repository")),
            disabled: true,
            kind: "show_hint",
            hint: resolve(msg("Publishing is unavailable here.")),
          };
    }
    if (!isAhead) {
      if (hasOpenPr) {
        return {
          label: resolve(msg("Commit", { $context: "verb, git action" })),
          disabled: true,
          kind: "show_hint",
          hint: resolve(msg("Branch is up to date. No action needed.")),
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
      label: resolve(
        msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
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
          : resolve(msg("Sync ref")),
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
      label: resolve(msg("Pull")),
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
      label: resolve(
        msg("Push & create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }

  if (hasOpenPr && gitStatus.hasUpstream) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: true,
      kind: "show_hint",
      hint: resolve(msg("Branch is up to date. No action needed.")),
    };
  }

  if (hasDefaultBranchDelta && !isDefaultRef) {
    return {
      label: resolve(
        msg("Create {term, select, mr {MR} cr {change request} other {PR}}", {
          term: changeRequestTermKind(terminology),
        }),
      ),
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

export function resolveDefaultBranchActionDialogCopy(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    includesCommit: boolean;
    terminology?: ChangeRequestTerminology;
    vcsTerminology?: VcsTerminology;
  },
  resolve: MessageResolver = m,
): DefaultBranchActionDialogCopy {
  return sharedDefaultBranchActionDialogCopy(input, resolve);
}

/** The server names a feature branch from the commit it makes, so the action must commit changes. */
export function resolveFeatureBranchUnavailableReason(
  input: {
    action: DefaultBranchConfirmableAction;
    branchName: string;
    hasWorkingTreeChanges: boolean;
  },
  resolve: MessageResolver = m,
): string | null {
  if (!input.hasWorkingTreeChanges) {
    return resolve(
      msg(
        "There are no changes to commit, so a feature branch can't be named. Create a branch yourself or continue on {branch}.",
        { branch: input.branchName },
      ),
    );
  }
  if (input.action === "push" || input.action === "create_pr") {
    return resolve(
      msg(
        "This action doesn't commit your changes, so a feature branch can't be named. Create a branch yourself or continue on {branch}.",
        { branch: input.branchName },
      ),
    );
  }
  return null;
}

export function resolveThreadBranchUpdate(
  result: GitRunStackedActionResult,
): { branch: string } | null {
  if (result.branch.status !== "created" || !result.branch.name) {
    return null;
  }

  return {
    branch: result.branch.name,
  };
}

export function resolveThreadBranchMetadataPatch(
  branch: string | null,
  expectedBranch: string | null,
): {
  branch: string | null;
  expectedBranch: string | null;
} {
  return { branch, expectedBranch };
}

export function resolveLiveThreadBranchUpdate(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  worktreeBranchPrefix?: string | undefined;
}): { branch: string | null } | null {
  if (!input.gitStatus) {
    return null;
  }

  if (input.gitStatus.refName === null && input.threadBranch !== null) {
    return null;
  }

  if (input.threadBranch === input.gitStatus.refName) {
    return null;
  }

  if (
    input.threadBranch !== null &&
    input.gitStatus.refName !== null &&
    !isTemporaryWorktreeBranch(input.threadBranch, input.worktreeBranchPrefix) &&
    isTemporaryWorktreeBranch(input.gitStatus.refName, input.worktreeBranchPrefix)
  ) {
    return null;
  }

  return {
    branch: input.gitStatus.refName,
  };
}

export type ChangesLineTotals = {
  readonly insertions: number;
  readonly deletions: number;
  /** Ref the counts compare against; `null` means they are uncommitted changes against HEAD. */
  readonly baseRef: string | null;
  /** `null` when the selected totals carry no per-file stats. */
  readonly breakdown: PullRequestChangeBreakdown;
};

// `branchChanges ?? workingTree` treats `{0,0}` as present, so a zero branch total hid a dirty
// working tree and the Changes row read +0 while Diff still showed the work.
// The Diff panel's branch comparison wins when it has file stats, so a remembered base or
// hidden whitespace reads the same in the row as in the panel.
export function resolveChangesTotals(
  status: VcsStatusResult | null | undefined,
  branchPreview?: ReviewDiffPreviewSource | null,
): ChangesLineTotals | null {
  if (branchPreview?.files) {
    let insertions = 0;
    let deletions = 0;
    for (const file of branchPreview.files) {
      insertions += file.additions;
      deletions += file.deletions;
    }
    return {
      insertions,
      deletions,
      baseRef: branchPreview.baseRef,
      breakdown: summarizeChangedFiles(branchPreview.files),
    };
  }
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = { ...status.workingTree, baseRef: null };
  const selected =
    branch && (branch.insertions > 0 || branch.deletions > 0)
      ? branch
      : tree.insertions > 0 || tree.deletions > 0
        ? tree
        : (branch ?? tree);
  return {
    insertions: selected.insertions,
    deletions: selected.deletions,
    baseRef: selected.baseRef,
    breakdown:
      selected === tree
        ? summarizeChangedFiles(
            tree.files.map((file) => ({
              path: file.path,
              additions: file.insertions,
              deletions: file.deletions,
            })),
          )
        : null,
  };
}
