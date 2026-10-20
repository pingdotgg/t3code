import type {
  GitRunStackedActionInput,
  GitStackedAction,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  DEFAULT_VCS_TERMINOLOGY,
  resolveVcsTerminology,
  resolveVcsUnsupportedReason,
  type VcsTerminology,
} from "@t3tools/shared/vcs";
import { sourceControlClients, type ChangeRequestTerminology } from "../sourceControlClients.ts";

export type GitActionSurface = "web" | "mobile";
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
  kind: "run_action" | "run_pull" | "open_pr" | "open_publish" | "show_hint";
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

export function buildMenuItems(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  hasOriginRemote = true,
  surface: GitActionSurface = "mobile",
): GitActionMenuItem[] {
  if (!gitStatus) return [];
  const blocked = isBusy || resolveVcsUnsupportedReason(gitStatus) !== null;
  const hasBranch = gitStatus.refName !== null;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const canPushWithoutUpstream = hasOriginRemote && !gitStatus.hasUpstream;
  const canPush =
    !blocked &&
    hasBranch &&
    (surface === "web" || !gitStatus.hasWorkingTreeChanges) &&
    gitStatus.behindCount === 0 &&
    gitStatus.aheadCount > 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const canCreatePr =
    !blocked &&
    hasBranch &&
    !hasOpenPr &&
    (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0 &&
    gitStatus.behindCount === 0 &&
    (gitStatus.hasUpstream || canPushWithoutUpstream);
  const items: GitActionMenuItem[] = [
    {
      id: "commit",
      label: "Commit",
      disabled: blocked || !gitStatus.hasWorkingTreeChanges,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    },
  ];
  if (surface === "web" && !hasOriginRemote) return items;
  items.push({
    id: "push",
    label: "Push",
    disabled: !canPush,
    icon: "push",
    kind: "open_dialog",
    dialogAction: "push",
  });
  if (surface === "web" && hasOpenPr) return items;
  const shortLabel =
    surface === "web"
      ? sourceControlClients.get(gitStatus.sourceControlProvider?.kind).changeRequest.shortLabel
      : "PR";
  items.push(
    hasOpenPr
      ? { id: "pr", label: "View PR", disabled: blocked, icon: "pr", kind: "open_pr" }
      : {
          id: "pr",
          label: `Create ${shortLabel}`,
          disabled: !canCreatePr,
          icon: "pr",
          kind: "open_dialog",
          dialogAction: "create_pr",
        },
  );
  return items;
}

export function resolveQuickAction(
  gitStatus: VcsStatusResult | null,
  isBusy: boolean,
  isDefaultBranch = false,
  hasOriginRemote = true,
  surface: GitActionSurface = "mobile",
): GitQuickAction {
  const vcs = resolveVcsTerminology(gitStatus);
  if (isBusy)
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `${vcs.systemName} action in progress.`,
    };
  if (!gitStatus)
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: `${vcs.systemName} status is unavailable.`,
    };
  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null)
    return { label: "Commit", disabled: true, kind: "show_hint", hint: unsupportedReason };
  const terminology = sourceControlClients.get(gitStatus.sourceControlProvider?.kind).changeRequest;
  const shortLabel = surface === "web" ? terminology.shortLabel : "PR";
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const resting: GitQuickAction = {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: `${vcs.refNounTitle} is up to date. No action needed.`,
  };
  if (gitStatus.refName === null)
    return {
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: vcs.quickNoRefHint(surface === "web" ? terminology.singular : "PR", surface),
    };
  if (gitStatus.hasWorkingTreeChanges) {
    if (!gitStatus.hasUpstream && !hasOriginRemote)
      return { label: "Commit", disabled: false, kind: "run_action", action: "commit" };
    if (hasOpenPr || isDefaultBranch)
      return { label: "Commit & push", disabled: false, kind: "run_action", action: "commit_push" };
    return {
      label: `Commit, push & ${shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    };
  }
  if (!gitStatus.hasUpstream) {
    if (!hasOriginRemote) {
      if (surface === "web")
        return { label: "Publish repository", disabled: false, kind: "open_publish" };
      if (hasOpenPr && !isAhead) return { label: "View PR", disabled: false, kind: "open_pr" };
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: 'Add an "origin" remote before pushing or creating a PR.',
      };
    }
    if (!isAhead) {
      if (hasOpenPr)
        return surface === "web" ? resting : { label: "View PR", disabled: false, kind: "open_pr" };
      return {
        label: "Push",
        disabled: true,
        kind: "show_hint",
        hint: `No local ${vcs.changeNoun}s to push.`,
      };
    }
  } else {
    if (isAhead && isBehind)
      return {
        label: `Sync ${surface === "web" ? vcs.genericRefNoun : vcs.refNoun}`,
        disabled: true,
        kind: "show_hint",
        hint: `${vcs.refNounTitle} has diverged from upstream. Rebase/merge first.`,
      };
    if (isBehind) return { label: "Pull", disabled: false, kind: "run_pull" };
  }
  if (isAhead) {
    if (hasOpenPr || isDefaultBranch)
      return {
        label: "Push",
        disabled: false,
        kind: "run_action",
        action: isDefaultBranch ? "commit_push" : "push",
      };
    return {
      label: `Push & create ${shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  }
  if (hasOpenPr && gitStatus.hasUpstream)
    return surface === "web" ? resting : { label: "View PR", disabled: false, kind: "open_pr" };
  if (
    surface === "web" &&
    (gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0 &&
    !isDefaultBranch
  )
    return {
      label: `Create ${shortLabel}`,
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    };
  return resting;
}

export function getGitActionDisabledReason(input: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasOriginRemote: boolean;
  surface?: GitActionSurface;
}): string | null {
  const { item, gitStatus, isBusy, hasOriginRemote, surface = "mobile" } = input;
  const vcs = resolveVcsTerminology(gitStatus);
  if (!item.disabled) return null;
  if (isBusy) return `${vcs.systemName} action in progress.`;
  if (!gitStatus) return `${vcs.systemName} status is unavailable.`;
  const unsupportedReason = resolveVcsUnsupportedReason(gitStatus);
  if (unsupportedReason !== null) return unsupportedReason;
  const terminology = sourceControlClients.get(gitStatus.sourceControlProvider?.kind).changeRequest;
  const request = surface === "web" ? `a ${terminology.singular}` : "a PR";
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  if (item.id === "commit")
    return !hasChanges
      ? surface === "web"
        ? vcs.cleanCommitHint
        : `${vcs.workspaceNounTitle} is clean. Make changes before committing.`
      : "Commit is currently unavailable.";
  if (item.id === "push") {
    if (gitStatus.refName === null) return vcs.noRefHint("pushing", surface);
    if (hasChanges) return vcs.dirtyPushHint;
    if (gitStatus.behindCount > 0)
      return `${vcs.refNounTitle} is behind upstream. Pull/rebase before pushing.`;
    if (!gitStatus.hasUpstream && !hasOriginRemote) return 'Add an "origin" remote before pushing.';
    if (gitStatus.aheadCount <= 0) return `No local ${vcs.changeNoun}s to push.`;
    return "Push is currently unavailable.";
  }
  if (surface === "mobile" && gitStatus.pr?.state === "open")
    return "View PR is currently unavailable.";
  if (gitStatus.refName === null) return vcs.noRefHint(`creating ${request}`, surface);
  if (!gitStatus.hasUpstream && !hasOriginRemote)
    return `Add an "origin" remote before creating ${request}.`;
  if ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) <= 0)
    return `No local ${vcs.changeNoun}s to include in ${request}.`;
  if (gitStatus.behindCount > 0)
    return `${vcs.refNounTitle} is behind upstream. Pull/rebase before creating ${request}.`;
  return `Create ${surface === "web" ? terminology.singular : "PR"} is currently unavailable.`;
}

export function requiresDefaultBranchConfirmation(
  action: GitStackedAction,
  isDefaultBranch: boolean,
): boolean {
  return (
    isDefaultBranch &&
    (action === "push" ||
      action === "create_pr" ||
      action === "commit_push" ||
      action === "commit_push_pr")
  );
}
export function resolveDefaultBranchActionDialogCopy(input: {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  vcsTerminology?: VcsTerminology;
  terminology?: ChangeRequestTerminology;
  surface?: GitActionSurface;
}): DefaultBranchActionDialogCopy {
  const vcs = input.vcsTerminology ?? DEFAULT_VCS_TERMINOLOGY;
  const web = input.surface === "web";
  const ref = web ? vcs.genericRefNoun : vcs.refNoun;
  const terminology = input.terminology ?? sourceControlClients.get(undefined).changeRequest;
  const shortLabel = web ? terminology.shortLabel : "PR";
  const request = web ? `a ${terminology.singular}` : "a PR";
  const suffix = ` on "${input.branchName}". You can continue on this ${ref} or create a feature ${ref} and run the same action there.`;
  if (input.action === "push" || input.action === "commit_push")
    return input.includesCommit
      ? {
          title: `Commit & push to default ${ref}?`,
          description: `This action will commit and push changes${suffix}`,
          continueLabel: `Commit & push to ${input.branchName}`,
        }
      : {
          title: `Push to default ${ref}?`,
          description: `This action will push local ${vcs.changeNoun}s${suffix}`,
          continueLabel: `Push to ${input.branchName}`,
        };
  return input.includesCommit
    ? {
        title: `Commit, push & create ${shortLabel} from default ${ref}?`,
        description: `This action will commit, push, and create ${request}${suffix}`,
        continueLabel: `Commit, push & create ${shortLabel}`,
      }
    : {
        title: `Push & create ${shortLabel} from default ${ref}?`,
        description: `This action will push local ${vcs.changeNoun}s and create ${request}${suffix}`,
        continueLabel: `Push & create ${shortLabel}`,
      };
}

export function resolveFeatureBranchUnavailableReason(input: {
  branchName: string;
  hasWorkingTreeChanges: boolean;
  vcsTerminology?: VcsTerminology;
}): string | null {
  if (input.hasWorkingTreeChanges) return null;
  const vcs = input.vcsTerminology ?? DEFAULT_VCS_TERMINOLOGY;
  return `There are no changes to commit, so a feature ${vcs.refNoun} can't be named. Create a ${vcs.refNoun} yourself or continue on ${input.branchName}.`;
}
