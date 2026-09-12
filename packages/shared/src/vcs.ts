import type { VcsDriverKind, VcsStatusLocalResult } from "@t3tools/contracts";

export interface VcsTerminology {
  readonly systemName: string;
  readonly refNoun: string;
  readonly refNounPlural: string;
  readonly refNounTitle: string;
  readonly workspaceNoun: string;
  readonly workspaceNounTitle: string;
  readonly workspaceNounPlural: string;
  /** "commit" | "change" */
  readonly changeNoun: string;
  readonly changeNounTitle: string;
  /** What to call "the tree you are editing": "working tree" | "working copy" */
  readonly workingTreeNoun: string;
  readonly workingTreeNounTitle: string;
  /** What to call "no ref here": "checkout" | "working copy" */
  readonly currentRefFallback: string;
}

export const GIT_VCS_TERMINOLOGY: VcsTerminology = {
  systemName: "Git",
  refNoun: "branch",
  refNounPlural: "branches",
  refNounTitle: "Branch",
  workspaceNoun: "worktree",
  workspaceNounTitle: "Worktree",
  workspaceNounPlural: "worktrees",
  changeNoun: "commit",
  changeNounTitle: "Commit",
  workingTreeNoun: "working tree",
  workingTreeNounTitle: "Working tree",
  currentRefFallback: "checkout",
};

export const JJ_VCS_TERMINOLOGY: VcsTerminology = {
  systemName: "Jujutsu",
  refNoun: "bookmark",
  refNounPlural: "bookmarks",
  refNounTitle: "Bookmark",
  workspaceNoun: "workspace",
  workspaceNounTitle: "Workspace",
  workspaceNounPlural: "workspaces",
  changeNoun: "change",
  changeNounTitle: "Change",
  workingTreeNoun: "working copy",
  workingTreeNounTitle: "Working copy",
  currentRefFallback: "working copy",
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
