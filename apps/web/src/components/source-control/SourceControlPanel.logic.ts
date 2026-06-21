import type {
  VcsPanelBranchCommitsInput,
  VcsPanelBranchCommitsResult,
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsRef,
} from "@t3tools/contracts";

export type BranchCommitListKind = NonNullable<VcsPanelBranchCommitsInput["kind"]>;

export type BranchSyncState = "fetch" | "pull" | "push" | "publish" | "diverged";

export type AttentionKind = "conflicts" | "diverged" | "behind" | "unpushed" | "dirty" | "stale";

export interface PanelChangedFile extends VcsPanelFileChange {
  readonly hasStagedChanges: boolean;
  readonly hasUnstagedChanges: boolean;
  readonly hasConflicts: boolean;
}

function mergedFileStatus(
  statuses: ReadonlySet<VcsPanelFileChange["status"]>,
): VcsPanelFileChange["status"] {
  if (statuses.has("conflicted")) return "conflicted";
  if (statuses.has("deleted")) return "deleted";
  if (statuses.has("renamed")) return "renamed";
  if (statuses.has("copied")) return "copied";
  if (statuses.has("added")) return "added";
  if (statuses.has("untracked")) return "untracked";
  return "modified";
}

export function mergeChangeGroups(groups: readonly VcsPanelChangeGroup[]): PanelChangedFile[] {
  const files = new Map<
    string,
    {
      originalPath: string | null;
      statuses: Set<VcsPanelFileChange["status"]>;
      insertions: number;
      deletions: number;
      hasStagedChanges: boolean;
      hasUnstagedChanges: boolean;
      hasConflicts: boolean;
    }
  >();

  for (const group of groups) {
    for (const file of group.files) {
      const existing = files.get(file.path) ?? {
        originalPath: file.originalPath,
        statuses: new Set<VcsPanelFileChange["status"]>(),
        insertions: 0,
        deletions: 0,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasConflicts: false,
      };
      existing.originalPath ??= file.originalPath;
      existing.statuses.add(file.status);
      // The compact working-tree row shows aggregate staged + unstaged churn,
      // not a de-duplicated net diff against HEAD.
      existing.insertions += file.insertions;
      existing.deletions += file.deletions;
      existing.hasStagedChanges ||= group.kind === "staged";
      existing.hasUnstagedChanges ||= group.kind === "unstaged";
      existing.hasConflicts ||= group.kind === "conflicts";
      files.set(file.path, existing);
    }
  }

  return [...files.entries()]
    .map(([path, file]) => ({
      path,
      originalPath: file.originalPath,
      status: mergedFileStatus(file.statuses),
      insertions: file.insertions,
      deletions: file.deletions,
      hasStagedChanges: file.hasStagedChanges,
      hasUnstagedChanges: file.hasUnstagedChanges,
      hasConflicts: file.hasConflicts,
    }))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

function appendUniqueCommits(
  existing: VcsPanelBranchDetails["commits"],
  incoming: VcsPanelBranchCommitsResult["commits"],
): VcsPanelBranchDetails["commits"] {
  const seen = new Set(existing.map((commit) => commit.sha));
  const merged = [...existing];
  for (const commit of incoming) {
    if (seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    merged.push(commit);
  }
  return merged;
}

export function mergeBranchCommitPage(
  current: ReadonlyMap<string, VcsPanelBranchDetails>,
  input: {
    readonly detailsKey: string;
    readonly details: VcsPanelBranchDetails;
    readonly kind: BranchCommitListKind;
    readonly page: VcsPanelBranchCommitsResult;
  },
): ReadonlyMap<string, VcsPanelBranchDetails> {
  const currentDetails = current.get(input.detailsKey);
  if (currentDetails && currentDetails.baseRef !== input.details.baseRef) return current;

  const nextDetails = currentDetails ?? input.details;
  let merged: VcsPanelBranchDetails;
  switch (input.kind) {
    case "ahead":
      merged = {
        ...nextDetails,
        aheadCommits: appendUniqueCommits(nextDetails.aheadCommits, input.page.commits),
        aheadCommitsRemaining: input.page.remaining,
      };
      break;
    case "behind":
      merged = {
        ...nextDetails,
        behindCommits: appendUniqueCommits(nextDetails.behindCommits, input.page.commits),
        behindCommitsRemaining: input.page.remaining,
      };
      break;
    case "compare-history":
      merged = {
        ...nextDetails,
        compareCommits: appendUniqueCommits(nextDetails.compareCommits, input.page.commits),
        compareCommitsRemaining: input.page.remaining,
      };
      break;
    case "history":
      merged = {
        ...nextDetails,
        commits: appendUniqueCommits(nextDetails.commits, input.page.commits),
        commitsRemaining: input.page.remaining,
      };
      break;
  }
  const next = new Map(current);
  if (input.detailsKey === merged.name || input.detailsKey === merged.fullRefName) {
    next.set(merged.fullRefName, merged);
    next.set(merged.name, merged);
  } else {
    next.set(input.detailsKey, merged);
  }
  return next;
}

export function formatRelativeDate(
  value: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const elapsedMs = now - time;
  if (elapsedMs <= 0) return "just now";
  if (elapsedMs < 60_000) return "just now";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks === 1) return "last week";
  if (days < 30) return `${weeks} weeks ago`;
  const months = Math.min(11, Math.floor(days / 30));
  if (days < 365) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function remoteBranchName(remoteRef: string, snapshot: VcsPanelSnapshotResult): string {
  const normalized = remoteRef.trim();
  const remote = snapshot.remotes
    .toSorted((left, right) => right.name.length - left.name.length)
    .find((candidate) => normalized.startsWith(`${candidate.name}/`));
  if (remote) return normalized.slice(remote.name.length + 1);

  const separatorIndex = normalized.indexOf("/");
  return separatorIndex >= 0 ? normalized.slice(separatorIndex + 1) : normalized;
}

export function branchSyncCounts(
  branch: VcsRef,
  snapshot: VcsPanelSnapshotResult,
): { readonly aheadCount: number; readonly behindCount: number } {
  if (branch.current) {
    return {
      aheadCount: snapshot.status.aheadCount,
      behindCount: snapshot.status.behindCount,
    };
  }
  return {
    aheadCount: branch.aheadCount ?? 0,
    behindCount: branch.behindCount ?? 0,
  };
}

export function branchHasUpstream(branch: VcsRef, snapshot: VcsPanelSnapshotResult): boolean {
  const upstreamName = branch.upstreamName?.trim();
  if (!upstreamName) return branch.current && snapshot.status.hasUpstream;
  return remoteBranchName(upstreamName, snapshot) === branch.name;
}

export function branchSyncState(branch: VcsRef, snapshot: VcsPanelSnapshotResult): BranchSyncState {
  const hasUpstream = branchHasUpstream(branch, snapshot);
  const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
  if (!hasUpstream) return "publish";
  if (aheadCount > 0 && behindCount > 0) return "diverged";
  if (behindCount > 0) return "pull";
  if (aheadCount > 0) return "push";
  return "fetch";
}

export function branchAttention(branch: VcsRef, snapshot: VcsPanelSnapshotResult): AttentionKind {
  const hasUpstream = branchHasUpstream(branch, snapshot);
  const { aheadCount, behindCount } = branchSyncCounts(branch, snapshot);
  if (!hasUpstream) return "unpushed";
  if (aheadCount > 0 && behindCount > 0) return "diverged";
  if (behindCount > 0) return "behind";
  if (aheadCount > 0) return "unpushed";
  return "stale";
}
