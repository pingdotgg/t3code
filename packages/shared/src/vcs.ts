import type { VcsDriverKind, VcsStatusLocalResult } from "@t3tools/contracts";

export interface VcsTerminology {
  readonly systemName: string;
  readonly refNoun: string;
  readonly refNounPlural: string;
  readonly refNounTitle: string;
  readonly refNounPluralTitle: string;
  readonly workspaceNoun: string;
  readonly workspaceNounTitle: string;
  readonly workspaceNounPlural: string;
  /** "commit" | "change" */
  readonly changeNoun: string;
  readonly changeNounTitle: string;
  /** What to call "the tree you are editing": "working tree" | "working copy" */
  readonly workingTreeNoun: string;
  readonly workingTreeNounTitle: string;
  readonly workingTreeDiffLabel: string;
  readonly refSwitchChangesDescription: string;
  /** What to call "no ref here": "checkout" | "working copy" */
  readonly currentRefFallback: string;
  readonly genericRefNoun: string;
  readonly genericRefNounPlural: string;
  readonly repositoryAdjective: string;
  readonly noRefLabel: string;
  readonly noRefDisplay: string;
  readonly defaultRefLabel: string;
  readonly hooksNotice: string | null;
  readonly dirtyPushHint: string;
  readonly cleanCommitHint: string;
  readonly noRefHint: (tail: string, surface?: "web" | "mobile") => string;
  readonly quickNoRefHint: (changeRequest: string, surface?: "web" | "mobile") => string;
  readonly noRefActionsNotice: (changeRequest: string) => string;
  readonly changeOnNewRefLabel: string;
  readonly featureCheckoutLabel: (surface?: "web" | "mobile") => string;
  readonly preserveReviewSectionTitles: boolean;
  readonly supportsCleanupBaseBranch: boolean;
}

export const GIT_VCS_TERMINOLOGY: VcsTerminology = {
  systemName: "Git",
  refNoun: "branch",
  refNounPlural: "branches",
  refNounTitle: "Branch",
  refNounPluralTitle: "Branches",
  workspaceNoun: "worktree",
  workspaceNounTitle: "Worktree",
  workspaceNounPlural: "worktrees",
  changeNoun: "commit",
  changeNounTitle: "Commit",
  workingTreeNoun: "working tree",
  workingTreeNounTitle: "Working tree",
  workingTreeDiffLabel: "Uncommitted",
  refSwitchChangesDescription:
    "You have uncommitted changes. They'll carry over to the other branch, or block the switch if they conflict.",
  currentRefFallback: "checkout",
  genericRefNoun: "ref",
  genericRefNounPlural: "refs",
  repositoryAdjective: "git",
  noRefLabel: "Detached HEAD",
  noRefDisplay: "(detached HEAD)",
  defaultRefLabel: "Default branch",
  hooksNotice: null,
  dirtyPushHint: "Commit or stash local changes before pushing.",
  cleanCommitHint: "Worktree is clean. Make changes before committing.",
  noRefHint: (tail, surface = "mobile") =>
    surface === "web"
      ? `Detached HEAD: check out a branch before ${tail}.`
      : `Detached HEAD: checkout a branch before ${tail}.`,
  quickNoRefHint: (changeRequest, surface = "mobile") =>
    `Create and checkout a ${surface === "web" ? "ref" : "branch"} before pushing or opening a ${changeRequest}.`,
  noRefActionsNotice: () =>
    "Detached HEAD: create and check out a branch to enable push and pull request actions.",
  changeOnNewRefLabel: "Commit on new branch",
  featureCheckoutLabel: (surface = "web") =>
    surface === "web" ? "Check out feature branch & continue" : "Feature branch & continue",
  preserveReviewSectionTitles: false,
  supportsCleanupBaseBranch: true,
};

export const JJ_VCS_TERMINOLOGY: VcsTerminology = {
  systemName: "Jujutsu",
  refNoun: "bookmark",
  refNounPlural: "bookmarks",
  refNounTitle: "Bookmark",
  refNounPluralTitle: "Bookmarks",
  workspaceNoun: "workspace",
  workspaceNounTitle: "Workspace",
  workspaceNounPlural: "workspaces",
  changeNoun: "change",
  changeNounTitle: "Change",
  workingTreeNoun: "working copy",
  workingTreeNounTitle: "Working copy",
  workingTreeDiffLabel: "Working copy",
  refSwitchChangesDescription:
    "You have working copy changes. They'll stay in the current change when you switch bookmarks. The switch may be refused if it would leave that change without a bookmark.",
  currentRefFallback: "working copy",
  genericRefNoun: "bookmark",
  genericRefNounPlural: "bookmarks",
  repositoryAdjective: "Jujutsu",
  noRefLabel: "No bookmark",
  noRefDisplay: "(no bookmark)",
  defaultRefLabel: "Warning: default bookmark",
  hooksNotice: "Jujutsu does not run Git hooks.",
  dirtyPushHint: "Commit local changes before pushing.",
  cleanCommitHint: "The working copy is clean. Make changes before committing.",
  noRefHint: (tail) => `No bookmark here: create one before ${tail}.`,
  quickNoRefHint: (changeRequest) =>
    `No bookmark here: create one before pushing or opening a ${changeRequest}.`,
  noRefActionsNotice: (changeRequest) =>
    `No bookmark here: create one before enabling push and ${changeRequest} actions.`,
  changeOnNewRefLabel: "Change on new bookmark",
  featureCheckoutLabel: () => "Check out feature bookmark",
  preserveReviewSectionTitles: true,
  supportsCleanupBaseBranch: false,
};

export const DEFAULT_VCS_TERMINOLOGY = GIT_VCS_TERMINOLOGY;

/** `null`/`undefined`/`"unknown"` resolve to Git terms so a transient status never flips copy. */
export function getVcsTerminology(kind: VcsDriverKind | null | undefined): VcsTerminology {
  return kind === "jj" ? JJ_VCS_TERMINOLOGY : GIT_VCS_TERMINOLOGY;
}

/** The accessor every client surface uses; mirrors `resolveChangeRequestTerminology`. */
export function resolveVcsTerminology(
  status: Pick<VcsStatusLocalResult, "vcs"> | null | undefined,
): VcsTerminology {
  return getVcsTerminology(status?.vcs?.kind);
}

/** Present only when the workspace's VCS is detected but unusable. */
export function resolveVcsUnsupportedReason(
  status: Pick<VcsStatusLocalResult, "vcs"> | null | undefined,
): string | null {
  return status?.vcs?.unsupportedReason ?? null;
}

/** Unknown status retains the original controls; only an explicit unsupported reason blocks them. */
export function supportsVcsActions(
  status: Pick<VcsStatusLocalResult, "vcs"> | null | undefined,
): boolean {
  return resolveVcsUnsupportedReason(status) === null;
}
