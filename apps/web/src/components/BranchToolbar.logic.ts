import type { GitBranch, VcsRef } from "@t3tools/contracts";

export type EnvMode = "local" | "worktree";

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  return activeWorktreePath || (!hasServerThread && draftThreadEnvMode === "worktree")
    ? "worktree"
    : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadBranch, currentGitBranch } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

export function getCurrentVcsRefNames(input: {
  backend: "git" | "jj";
  refs: ReadonlyArray<VcsRef>;
}): ReadonlyArray<string> {
  const names = input.refs
    .filter((ref) => {
      if (!ref.current) return false;
      if (input.backend === "jj") {
        return ref.kind === "bookmark";
      }
      return ref.kind === "branch";
    })
    .map((ref) => ref.name);

  return [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
}

export function formatCurrentVcsRefNames(names: ReadonlyArray<string>): string | null {
  return names.length > 0 ? names.join(", ") : null;
}

export function resolveBranchToolbarState(input: {
  backend: "git" | "jj";
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentRefNames: ReadonlyArray<string>;
}): {
  displayValue: string | null;
  selectedValue: string | null;
} {
  if (input.backend === "git") {
    const currentGitBranch = input.currentRefNames[0] ?? null;
    const resolvedValue = resolveBranchToolbarValue({
      envMode: input.envMode,
      activeWorktreePath: input.activeWorktreePath,
      activeThreadBranch: input.activeThreadBranch,
      currentGitBranch,
    });
    return {
      displayValue: resolvedValue,
      selectedValue: resolvedValue,
    };
  }

  const inferredDisplayValue = formatCurrentVcsRefNames(input.currentRefNames);
  return {
    displayValue: input.activeThreadBranch ?? inferredDisplayValue,
    selectedValue:
      input.activeThreadBranch ?? (input.currentRefNames.length === 1 ? input.currentRefNames[0]! : null),
  };
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const bookmarkSeparatorIndex = branchName.lastIndexOf("@");
  if (bookmarkSeparatorIndex > 0) {
    return branchName.slice(0, bookmarkSeparatorIndex);
  }
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
  }

  return [...candidates];
}

type BranchToolbarRef = VcsRef | GitBranch;

function toRefKind(ref: BranchToolbarRef): VcsRef["kind"] {
  if ("kind" in ref) {
    return ref.kind;
  }
  return ref.isRemote ? "remoteBranch" : "branch";
}

export function dedupeRemoteBranchesWithLocalMatches<T extends BranchToolbarRef>(
  branches: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const localBranchNames = new Set(
    branches
      .filter((branch) => {
        const kind = toRefKind(branch);
        return kind === "branch" || kind === "bookmark";
      })
      .map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    const kind = toRefKind(branch);
    if (kind !== "remoteBranch" && kind !== "remoteBookmark") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}
