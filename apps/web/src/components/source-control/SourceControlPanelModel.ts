import type {
  VcsPanelBranchDetails,
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelFileDiffInput,
  VcsPanelRemote,
  VcsPanelSnapshotResult,
  VcsPanelStash,
  VcsPanelWorktreeChangeSet,
  VcsRef,
} from "@t3tools/contracts";
import type { MouseEvent as ReactMouseEvent } from "react";

import type {
  AttentionKind,
  PanelChangedFile,
  PanelFileDiffLoadState,
} from "./SourceControlPanel.logic";
import { branchHasUpstream, stashIdentityKey } from "./SourceControlPanel.logic";
import type { SourceControlSectionKey } from "./SourceControlPanelCache";

export type FileDiffSource = NonNullable<VcsPanelFileDiffInput["source"]>;
export type FileDiffLoadState = PanelFileDiffLoadState;

export interface WorkingTreeChangeSetView {
  readonly id: string;
  readonly label: string;
  readonly cwd: string;
  readonly branchName: string | null;
  readonly worktreePath: string | null;
  readonly current: boolean;
  readonly changeGroups: readonly VcsPanelChangeGroup[];
  readonly files: readonly PanelChangedFile[];
  readonly selectedPaths: ReadonlySet<string>;
  readonly activity: number;
}

export type SectionKey = SourceControlSectionKey;

export const SECTION_ORDER: readonly SectionKey[] = ["work", "remotes"];
export const SECTION_TITLES: Record<SectionKey, string> = {
  work: "Actionable",
  remotes: "Remotes",
};
export const DEFAULT_SECTION_WEIGHTS: Record<SectionKey, number> = {
  work: 3,
  remotes: 1.4,
};
export const COLLAPSED_SECTION_HEIGHT = 32;
export const MIN_SECTION_WEIGHT = 0.35;
export const COMMIT_PAGE_SIZE = 10;
export const WORKING_FILE_PREFETCH_MARGIN = 600;

const ENRICHMENT_KEY_SEPARATOR = "\0";
const readableDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Source control action failed.";
}

export function sourceControlPanelError(
  refreshError: string | null,
  mutationError: string | null,
): string | null {
  return mutationError ?? refreshError;
}

export function applyWorkingTreeFileEnrichment(
  groups: readonly VcsPanelChangeGroup[],
  targetCwd: string,
  enrichedFilesByPath: ReadonlyMap<string, VcsPanelFileChange>,
  hiddenPaths: ReadonlySet<string>,
): VcsPanelChangeGroup[] {
  if (enrichedFilesByPath.size === 0 && hiddenPaths.size === 0) {
    return groups.map((group) => ({ ...group, files: [...group.files] }));
  }
  return groups.map((group) => {
    if (group.kind !== "unstaged") return { ...group, files: [...group.files] };
    const seenPaths = new Set<string>();
    const files = group.files.flatMap((file) => {
      const key = enrichmentFileKey(targetCwd, file.path);
      if (hiddenPaths.has(key)) return [];
      const enrichedFile = enrichedFilesByPath.get(key) ?? file;
      seenPaths.add(enrichedFile.path);
      return [enrichedFile];
    });
    for (const [key, enrichedFile] of enrichedFilesByPath) {
      const parsed = splitEnrichmentFileKey(key);
      if (parsed.cwd !== targetCwd) continue;
      if (seenPaths.has(enrichedFile.path) || hiddenPaths.has(key)) continue;
      files.push(enrichedFile);
    }
    return {
      ...group,
      files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  });
}

export function shouldEnrichWorkingTreeFile(file: PanelChangedFile): boolean {
  return file.hasUnstagedChanges && (file.status === "untracked" || file.status === "deleted");
}

export function enrichmentFileKey(cwd: string, path: string): string {
  return `${cwd}${ENRICHMENT_KEY_SEPARATOR}${path}`;
}

export function splitEnrichmentFileKey(key: string): {
  readonly cwd: string;
  readonly path: string;
} {
  const separatorIndex = key.indexOf(ENRICHMENT_KEY_SEPARATOR);
  if (separatorIndex < 0) return { cwd: "", path: key };
  return {
    cwd: key.slice(0, separatorIndex),
    path: key.slice(separatorIndex + ENRICHMENT_KEY_SEPARATOR.length),
  };
}

export function isActionForced(event: ReactMouseEvent): boolean {
  return event.shiftKey;
}

export function shouldFetchBeforePull(event: ReactMouseEvent): boolean {
  return event.altKey;
}

export function commitUndoActionKey(branchName: string, sha?: string): string {
  return sha ? `commit-undo:${branchName}:${sha}` : `branch-undo-latest:${branchName}`;
}

export function treeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function formatReadableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return readableDateFormatter.format(new Date(time));
}

export function sumFiles(files: readonly VcsPanelFileChange[]) {
  return files.reduce(
    (total, file) => ({
      insertions: total.insertions + file.insertions,
      deletions: total.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
}

export function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part) return part;
  }
  return path;
}

export function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

export function renameOriginalPathForFile(
  file: Pick<VcsPanelFileChange, "originalPath" | "status">,
): string | undefined {
  return file.status === "renamed" && file.originalPath ? file.originalPath : undefined;
}

export function operationPathsForFile(
  file: Pick<VcsPanelFileChange, "path" | "originalPath" | "status">,
): string[] {
  const originalPath = renameOriginalPathForFile(file);
  return uniquePaths(originalPath ? [file.path, originalPath] : [file.path]);
}

export function worktreeChangeSetId(
  changeSet: Pick<VcsPanelWorktreeChangeSet, "worktreePath">,
): string {
  return `worktree:${changeSet.worktreePath}`;
}

export function changeSetAttention(files: readonly PanelChangedFile[]): AttentionKind {
  return files.some((file) => file.hasConflicts)
    ? "conflicts"
    : files.length > 0
      ? "dirty"
      : "stale";
}

export function commitCountLabel(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`;
}

export function stashBranchName(stash: VcsPanelStash): string | null {
  return /^(?:WIP\s+)?on\s+([^:]+):/i.exec(stash.message)?.[1]?.trim() ?? null;
}

export function branchActivityTimestamp(branch: {
  readonly lastActivityAt?: string | null | undefined;
}): number {
  if (!branch.lastActivityAt) return 0;
  const time = Date.parse(branch.lastActivityAt);
  return Number.isFinite(time) ? time : 0;
}

export function mapBranchDetails(
  details: readonly VcsPanelBranchDetails[],
): ReadonlyMap<string, VcsPanelBranchDetails> {
  const map = new Map<string, VcsPanelBranchDetails>();
  for (const detail of details) {
    map.set(detail.fullRefName, detail);
    map.set(detail.name, detail);
  }
  return map;
}

export function remoteBranchRef(
  remote: VcsPanelRemote,
  branch: VcsPanelRemote["branches"][number],
): VcsRef {
  return {
    name: branch.fullRefName,
    isRemote: true,
    remoteName: remote.name,
    current: false,
    isDefault: branch.isDefaultRemoteHead,
    worktreePath: null,
    lastActivityAt: branch.lastActivityAt,
    upstreamName: null,
  };
}

export function localBranchForRemoteBranch(
  snapshot: VcsPanelSnapshotResult,
  remote: VcsPanelRemote,
  branch: VcsPanelRemote["branches"][number],
): VcsRef | null {
  return (
    snapshot.localBranches.find((localBranch) => localBranch.upstreamName === branch.fullRefName) ??
    snapshot.localBranches.find(
      (localBranch) =>
        localBranch.name === branch.name &&
        localBranch.upstreamName === `${remote.name}/${branch.name}`,
    ) ??
    null
  );
}

export function localOnlyBranches(snapshot: VcsPanelSnapshotResult): VcsRef[] {
  return snapshot.localBranches
    .filter((branch) => !branchHasUpstream(branch, snapshot))
    .toSorted((left, right) => branchActivityTimestamp(right) - branchActivityTimestamp(left));
}

export function compareBaseRefNames(snapshot: VcsPanelSnapshotResult | null): string[] {
  if (!snapshot) return [];
  const refs = new Set<string>();
  if (snapshot.defaultCompareRef) refs.add(snapshot.defaultCompareRef);
  for (const branch of snapshot.localBranches) {
    refs.add(branch.name);
    if (branch.upstreamName) refs.add(branch.upstreamName);
  }
  for (const remote of snapshot.remotes) {
    for (const branch of remote.branches) refs.add(branch.fullRefName);
  }
  return [...refs].toSorted((left, right) => left.localeCompare(right));
}

export interface ExpandedBranchRequest {
  readonly branch: VcsRef;
  readonly detailsKey: string;
  readonly compareBaseRef?: string;
}

export function expandedBranchesForSnapshot(
  snapshot: VcsPanelSnapshotResult,
  expanded: ReadonlySet<string>,
): ExpandedBranchRequest[] {
  const localBranches = snapshot.localBranches
    .filter((branch) => expanded.has(treeKey("branch", branch.name)))
    .map((branch) => ({ branch, detailsKey: branch.name }));
  const expandedLocalBranches = localOnlyBranches(snapshot)
    .filter((branch) => expanded.has(treeKey("remote-branch", `local:${branch.name}`)))
    .map((branch) => ({ branch, detailsKey: branch.name }));
  const remoteBranches = snapshot.remotes.flatMap((remote) =>
    remote.branches
      .map((branch) => ({
        displayName: branch.name,
        ref:
          localBranchForRemoteBranch(snapshot, remote, branch) ?? remoteBranchRef(remote, branch),
      }))
      .filter((branch) =>
        expanded.has(
          treeKey("remote-branch", `${branch.ref.remoteName ?? "local"}:${branch.displayName}`),
        ),
      )
      .map((branch) => ({ branch: branch.ref, detailsKey: branch.ref.name })),
  );
  const forkBranches = snapshot.actionableForkBranches.flatMap((fork) => {
    const branch = snapshot.localBranches.find(
      (localBranch) => localBranch.name === fork.localBranchName,
    );
    if (!branch) return [];
    const detailsKey = treeKey("fork-details", `${fork.localBranchName}:${fork.remoteRefName}`);
    return expanded.has(treeKey("fork-branch", `${fork.localBranchName}:${fork.remoteRefName}`))
      ? [{ branch, detailsKey, compareBaseRef: fork.remoteRefName }]
      : [];
  });
  return [...localBranches, ...expandedLocalBranches, ...remoteBranches, ...forkBranches];
}

export interface ExpandedStashRequest {
  readonly stashRef: string;
  readonly detailsKey: string;
}

export function expandedStashesForSnapshot(
  snapshot: VcsPanelSnapshotResult,
  expanded: ReadonlySet<string>,
): ExpandedStashRequest[] {
  return snapshot.stashes
    .filter((stash) => expanded.has(treeKey("stash", stashIdentityKey(stash))))
    .map((stash) => ({ stashRef: stash.refName, detailsKey: stashIdentityKey(stash) }));
}
