import type {
  VcsPanelChangeGroup,
  VcsPanelStash,
  VcsPanelSnapshotResult,
} from "@t3tools/contracts";
import {
  mergePanelChangeGroups,
  panelBranchAttention as branchAttention,
  panelBranchHasUpstream as branchHasUpstream,
  panelBranchOperationCwd as branchOperationCwd,
  panelBranchSyncCounts as branchSyncCounts,
  panelBranchSyncState as branchSyncState,
  type BranchAttentionKind,
  type BranchSyncState,
  type PanelChangedFile,
} from "@t3tools/shared/sourceControl";

export {
  branchAttention,
  branchHasUpstream,
  branchOperationCwd,
  branchSyncCounts,
  branchSyncState,
};
export type { BranchSyncState, PanelChangedFile };

export type AttentionKind = BranchAttentionKind;

export type PanelFileDiffLoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly patch: string }
  | { readonly status: "error"; readonly message: string };

export function vcsPanelSnapshotFingerprint(cwd: string, snapshot: VcsPanelSnapshotResult): string {
  return `${cwd}\0${JSON.stringify(snapshot)}`;
}

export function stashIdentityKey(stash: VcsPanelStash): string {
  return stash.sha ? `sha:${stash.sha}` : `ref:${stash.refName}`;
}

export function beginPanelFileDiffLoad(
  current: PanelFileDiffLoadState | undefined,
  options: { readonly preserveLoaded?: boolean } = {},
): PanelFileDiffLoadState {
  if (options.preserveLoaded && current?.status === "loaded") return current;
  return { status: "loading" };
}

export function completePanelFileDiffLoad(
  current: PanelFileDiffLoadState | undefined,
  patch: string,
): PanelFileDiffLoadState {
  if (current?.status === "loaded" && current.patch === patch) return current;
  return { status: "loaded", patch };
}

export function failPanelFileDiffLoad(
  current: PanelFileDiffLoadState | undefined,
  message: string,
  options: { readonly preserveLoaded?: boolean } = {},
): PanelFileDiffLoadState {
  if (options.preserveLoaded && current?.status === "loaded") return current;
  return { status: "error", message };
}

export function mergeChangeGroups(groups: readonly VcsPanelChangeGroup[]): PanelChangedFile[] {
  return mergePanelChangeGroups(groups);
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
