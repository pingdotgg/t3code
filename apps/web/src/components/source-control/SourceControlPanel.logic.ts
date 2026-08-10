import type {
  EnvironmentId,
  LocalApi,
  VcsPanelChangeGroup,
  VcsPanelStash,
  VcsPanelSnapshotResult,
  VcsRef,
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

export type PanelRefreshMode = "full" | "working-tree";

export function confirmSourceControlPanelMutation(
  confirm: LocalApi["dialogs"]["confirm"],
  message: string,
): Promise<boolean> {
  return confirm(message, { variant: "destructive" });
}

export interface SourceControlEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly cwd: string;
  readonly connected: boolean;
}

export interface FederatedSourceControlTarget extends SourceControlEnvironmentCandidate {
  readonly active: boolean;
  readonly worktreePath: string | null;
}

export function isFederatedSourceControlTargetExpanded(
  target: Pick<FederatedSourceControlTarget, "active" | "environmentId">,
  expandedEnvironmentIds: ReadonlySet<EnvironmentId>,
): boolean {
  return target.active || expandedEnvironmentIds.has(target.environmentId);
}

export function resolveFederatedSourceControlTargets(input: {
  readonly activeEnvironmentId: EnvironmentId;
  readonly activeCwd: string;
  readonly activeWorktreePath: string | null;
  readonly candidates: readonly SourceControlEnvironmentCandidate[];
}): FederatedSourceControlTarget[] {
  const targetByEnvironmentId = new Map<EnvironmentId, FederatedSourceControlTarget>();
  for (const candidate of input.candidates) {
    if (!candidate.connected || targetByEnvironmentId.has(candidate.environmentId)) continue;
    const active = candidate.environmentId === input.activeEnvironmentId;
    targetByEnvironmentId.set(candidate.environmentId, {
      ...candidate,
      active,
      cwd: active ? input.activeCwd : candidate.cwd,
      worktreePath: active ? input.activeWorktreePath : null,
    });
  }

  return [...targetByEnvironmentId.values()].toSorted((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

export async function drainPanelRefreshQueue(options: {
  readonly initialMode: PanelRefreshMode;
  readonly clearQueuedMode: () => void;
  readonly readQueuedMode: () => PanelRefreshMode | null;
  readonly run: (mode: PanelRefreshMode) => Promise<void>;
  readonly onError: (error: unknown) => void;
}): Promise<void> {
  let mode = options.initialMode;
  while (true) {
    options.clearQueuedMode();
    try {
      await options.run(mode);
    } catch (error) {
      options.onError(error);
    }
    const queuedMode = options.readQueuedMode();
    if (queuedMode === null) return;
    mode = queuedMode;
  }
}

export type PanelActionResult =
  | { readonly status: "success" }
  | { readonly status: "failure"; readonly error: unknown };

export function panelActionError(
  result: PanelActionResult | null,
  reconcileError: unknown,
): unknown {
  return result?.status === "failure" ? result.error : reconcileError;
}

export async function runPanelActionAndReconcile(options: {
  readonly action: () => Promise<void>;
  readonly reconcile: () => Promise<void>;
}): Promise<PanelActionResult> {
  const result = await options.action().then(
    () => ({ status: "success" }) as const,
    (error: unknown) => ({ status: "failure", error }) as const,
  );
  await options.reconcile();
  return result;
}

export function beginPanelAction(runningActionKeys: Set<string>, actionKey: string): boolean {
  if (runningActionKeys.has(actionKey)) return false;
  runningActionKeys.add(actionKey);
  return true;
}

export function beginPanelDetailRequest(requestsByKey: Map<string, number>, key: string): number {
  const requestId = (requestsByKey.get(key) ?? 0) + 1;
  requestsByKey.set(key, requestId);
  return requestId;
}

export function isLatestPanelDetailRequest(
  requestsByKey: ReadonlyMap<string, number>,
  key: string,
  requestId: number,
): boolean {
  return requestsByKey.get(key) === requestId;
}

export function branchIsCheckedOut(branch: VcsRef | undefined): boolean {
  return branch?.current === true || branch?.worktreePath != null;
}

export function namedBranchOperationCwd(
  branches: readonly VcsRef[],
  branchName: string,
  fallbackCwd: string,
): string {
  const branch = branches.find((candidate) => candidate.name === branchName);
  return branch ? branchOperationCwd(branch, fallbackCwd) : fallbackCwd;
}

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
