import type {
  EnvironmentId,
  ThreadId,
  VcsPanelBranchDetails,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsPanelStashDetails,
} from "@t3tools/contracts";

import type { PanelFileDiffLoadState } from "./SourceControlPanel.logic";

export type SourceControlSectionKey = "work" | "remotes";

export interface CachedSourceControlPanelState {
  readonly snapshot: VcsPanelSnapshotResult | null;
  readonly snapshotFingerprint: string | null;
  readonly collapsed: ReadonlySet<SourceControlSectionKey>;
  readonly sectionWeights: Record<SourceControlSectionKey, number>;
  readonly expandedTree: ReadonlySet<string>;
  readonly collapsedDefaultTree: ReadonlySet<string>;
  readonly branchDetailsByRef: ReadonlyMap<string, VcsPanelBranchDetails>;
  readonly compareBaseOverrides: ReadonlyMap<string, string>;
  readonly stashDetailsByKey: ReadonlyMap<string, VcsPanelStashDetails>;
  readonly expandedFileDiffs: ReadonlySet<string>;
  readonly fileDiffsByKey: ReadonlyMap<string, PanelFileDiffLoadState>;
  readonly enrichedWorkingTreeFilesByPath: ReadonlyMap<string, VcsPanelFileChange>;
  readonly hiddenWorkingTreePaths: ReadonlySet<string>;
  readonly selectedChangePaths: ReadonlySet<string>;
  readonly selectedWorktreeChangePaths: ReadonlyMap<string, ReadonlySet<string>>;
}

const PANEL_STATE_CACHE_LIMIT = 24;
const sourceControlPanelStateCache = new Map<string, CachedSourceControlPanelState>();

export function sourceControlPanelStateCacheKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
}): string {
  return `${input.environmentId}:${input.threadId}:${input.cwd}:${input.worktreePath ?? ""}`;
}

function cloneReadonlySet<T>(value: ReadonlySet<T>): ReadonlySet<T> {
  return new Set(value);
}

function cloneStringSetMap(
  value: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map([...value].map(([key, set]) => [key, new Set(set)]));
}

function cacheableFileDiffs(
  value: ReadonlyMap<string, PanelFileDiffLoadState>,
): ReadonlyMap<string, PanelFileDiffLoadState> {
  return new Map([...value].filter(([, state]) => state.status !== "loading"));
}

function cacheableExpandedFileDiffs(
  expanded: ReadonlySet<string>,
  fileDiffsByKey: ReadonlyMap<string, PanelFileDiffLoadState>,
): ReadonlySet<string> {
  return new Set([...expanded].filter((key) => fileDiffsByKey.has(key)));
}

function cloneCachedSourceControlPanelState(
  value: CachedSourceControlPanelState,
): CachedSourceControlPanelState {
  const fileDiffsByKey = cacheableFileDiffs(value.fileDiffsByKey);
  return {
    snapshot: value.snapshot,
    snapshotFingerprint: value.snapshotFingerprint,
    collapsed: cloneReadonlySet(value.collapsed),
    sectionWeights: { ...value.sectionWeights },
    expandedTree: cloneReadonlySet(value.expandedTree),
    collapsedDefaultTree: cloneReadonlySet(value.collapsedDefaultTree),
    branchDetailsByRef: new Map(value.branchDetailsByRef),
    compareBaseOverrides: new Map(value.compareBaseOverrides),
    stashDetailsByKey: new Map(value.stashDetailsByKey),
    expandedFileDiffs: cacheableExpandedFileDiffs(value.expandedFileDiffs, fileDiffsByKey),
    fileDiffsByKey,
    enrichedWorkingTreeFilesByPath: new Map(value.enrichedWorkingTreeFilesByPath),
    hiddenWorkingTreePaths: cloneReadonlySet(value.hiddenWorkingTreePaths),
    selectedChangePaths: cloneReadonlySet(value.selectedChangePaths),
    selectedWorktreeChangePaths: cloneStringSetMap(value.selectedWorktreeChangePaths),
  };
}

export function readCachedSourceControlPanelState(
  key: string,
): CachedSourceControlPanelState | null {
  const cached = sourceControlPanelStateCache.get(key);
  return cached ? cloneCachedSourceControlPanelState(cached) : null;
}

export function writeCachedSourceControlPanelState(
  key: string,
  value: CachedSourceControlPanelState,
): void {
  sourceControlPanelStateCache.delete(key);
  sourceControlPanelStateCache.set(key, cloneCachedSourceControlPanelState(value));
  while (sourceControlPanelStateCache.size > PANEL_STATE_CACHE_LIMIT) {
    const oldestKey = sourceControlPanelStateCache.keys().next().value;
    if (oldestKey === undefined) break;
    sourceControlPanelStateCache.delete(oldestKey);
  }
}
