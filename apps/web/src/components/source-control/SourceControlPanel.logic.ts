import type { VcsPanelSnapshotResult, VcsRef } from "@t3tools/contracts";

export type BranchSyncState = "fetch" | "pull" | "push" | "publish" | "diverged";

export type AttentionKind = "conflicts" | "diverged" | "behind" | "unpushed" | "dirty" | "stale";

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
