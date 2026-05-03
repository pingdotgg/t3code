import type { VcsDriverKind } from "@t3tools/contracts";

export interface VcsTerms {
  readonly systemName: string;
  readonly repositoryNoun: string;
  readonly refNoun: string;
  readonly refNounPlural: string;
  readonly currentRefFallback: string;
}

export interface VcsActionPresentation {
  readonly supportsGitWorkflowActions: boolean;
  readonly unsupportedGitWorkflowDescription: string;
}

const gitLikeTerms: VcsTerms = {
  systemName: "Git",
  repositoryNoun: "repository",
  refNoun: "branch",
  refNounPlural: "branches",
  currentRefFallback: "checkout",
};

const unknownTerms: VcsTerms = {
  systemName: "VCS",
  repositoryNoun: "repository",
  refNoun: "ref",
  refNounPlural: "refs",
  currentRefFallback: "checkout",
};

export function resolveVcsTerms(kind: VcsDriverKind | null | undefined): VcsTerms {
  if (kind === "jj") {
    return {
      systemName: "JJ",
      repositoryNoun: "workspace",
      refNoun: "bookmark",
      refNounPlural: "bookmarks",
      currentRefFallback: "working copy",
    };
  }

  if (kind === "git") {
    return gitLikeTerms;
  }

  return unknownTerms;
}

export function resolveVcsActionPresentation(
  kind: VcsDriverKind | null | undefined,
): VcsActionPresentation {
  const terms = resolveVcsTerms(kind);
  const supportsGitWorkflowActions = kind === undefined || kind === null || kind === "git";

  return {
    supportsGitWorkflowActions,
    unsupportedGitWorkflowDescription: `Git commit, push, and PR actions are not available for this ${terms.systemName} ${terms.repositoryNoun}.`,
  };
}
