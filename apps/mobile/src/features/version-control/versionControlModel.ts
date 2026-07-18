import type {
  VcsPanelChangeGroup,
  VcsPanelFileChange,
  VcsPanelSnapshotResult,
  VcsPanelWorkingTreeFileEnrichmentResult,
  VcsPanelWorktreeChangeSet,
  VcsRef,
} from "@t3tools/contracts";
import {
  mergePanelChangeGroups,
  panelBranchHasUpstream,
  panelBranchSyncCounts,
  type PanelChangedFile,
} from "@t3tools/shared/sourceControl";

export interface VersionControlChangeSet {
  readonly id: string;
  readonly branchName: string;
  readonly cwd: string;
  readonly current: boolean;
  readonly lastActivityAt?: string | null;
  readonly files: readonly PanelChangedFile[];
}

function siblingChangeSet(changeSet: VcsPanelWorktreeChangeSet): VersionControlChangeSet {
  return {
    id: `worktree:${changeSet.worktreePath}`,
    branchName: changeSet.branchName,
    cwd: changeSet.worktreePath,
    current: changeSet.current,
    lastActivityAt: changeSet.lastActivityAt,
    files: mergePanelChangeGroups(changeSet.changeGroups),
  };
}

export function panelChangeSets(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
): VersionControlChangeSet[] {
  const currentBranch = snapshot.status.refName ?? "Detached HEAD";
  const current: VersionControlChangeSet = {
    id: `worktree:${cwd}`,
    branchName: currentBranch,
    cwd,
    current: true,
    files: mergePanelChangeGroups(snapshot.changeGroups),
  };

  return [current, ...snapshot.worktreeChangeSets.map(siblingChangeSet)].filter(
    (changeSet, index, all) =>
      changeSet.files.length > 0 &&
      all.findIndex((candidate) => candidate.cwd === changeSet.cwd) === index,
  );
}

export function actionableLocalBranches(snapshot: VcsPanelSnapshotResult): VcsRef[] {
  return snapshot.localBranches.filter((branch) => {
    const { aheadCount, behindCount } = panelBranchSyncCounts(branch, snapshot);
    return !panelBranchHasUpstream(branch, snapshot) || aheadCount > 0 || behindCount > 0;
  });
}

export function operationPaths(
  files: readonly Pick<VcsPanelFileChange, "path" | "originalPath">[],
) {
  return [
    ...new Set(
      files.flatMap((file) => (file.originalPath ? [file.path, file.originalPath] : [file.path])),
    ),
  ];
}

export function discardPathGroups(files: readonly PanelChangedFile[]): {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
} {
  return {
    staged: operationPaths(files.filter((file) => file.hasStagedChanges)),
    unstaged: operationPaths(
      files.filter((file) => file.hasUnstagedChanges || !file.hasStagedChanges),
    ),
  };
}

export function workingTreeEnrichmentRequests(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
): ReadonlyArray<{ readonly cwd: string; readonly paths: readonly string[] }> {
  return panelChangeSets(snapshot, cwd).flatMap((changeSet) => {
    const paths = changeSet.files
      .filter(
        (file) =>
          file.hasUnstagedChanges && (file.status === "untracked" || file.status === "deleted"),
      )
      .map((file) => file.path);
    return paths.length > 0 ? [{ cwd: changeSet.cwd, paths }] : [];
  });
}

function applyWorkingTreeEnrichment(
  groups: readonly VcsPanelChangeGroup[],
  enrichment: VcsPanelWorkingTreeFileEnrichmentResult | undefined,
): VcsPanelChangeGroup[] {
  if (!enrichment) return groups.map((group) => ({ ...group, files: [...group.files] }));

  const enrichedByPath = new Map(enrichment.files.map((file) => [file.path, file]));
  const hiddenPaths = new Set(enrichment.hiddenPaths);
  return groups.map((group) => {
    if (group.kind !== "unstaged") return { ...group, files: [...group.files] };
    const seenPaths = new Set<string>();
    const files = group.files.flatMap((file) => {
      if (hiddenPaths.has(file.path)) return [];
      const enriched = enrichedByPath.get(file.path) ?? file;
      seenPaths.add(enriched.path);
      return [enriched];
    });
    for (const file of enrichment.files) {
      if (!seenPaths.has(file.path) && !hiddenPaths.has(file.path)) files.push(file);
    }
    return {
      ...group,
      files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
    };
  });
}

export function applyWorkingTreeEnrichments(
  snapshot: VcsPanelSnapshotResult,
  cwd: string,
  enrichments: ReadonlyMap<string, VcsPanelWorkingTreeFileEnrichmentResult>,
): VcsPanelSnapshotResult {
  return {
    ...snapshot,
    changeGroups: applyWorkingTreeEnrichment(snapshot.changeGroups, enrichments.get(cwd)),
    worktreeChangeSets: snapshot.worktreeChangeSets.map((changeSet) => ({
      ...changeSet,
      changeGroups: applyWorkingTreeEnrichment(
        changeSet.changeGroups,
        enrichments.get(changeSet.worktreePath),
      ),
    })),
  };
}

export function branchOwnsOperationCwd(branch: VcsRef): boolean {
  return branch.current || branch.worktreePath !== null;
}

export function selectedFileStats(
  files: readonly Pick<VcsPanelFileChange, "insertions" | "deletions">[],
) {
  return files.reduce(
    (total, file) => ({
      insertions: total.insertions + file.insertions,
      deletions: total.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
}

export function fileStatusLetter(status: VcsPanelFileChange["status"]): string {
  switch (status) {
    case "added":
    case "untracked":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "conflicted":
      return "!";
    case "modified":
      return "M";
  }
}

export function branchSyncLabel(input: {
  readonly state: "fetch" | "pull" | "push" | "publish" | "diverged";
  readonly busy: boolean;
}): string {
  if (input.busy) return "Working…";
  switch (input.state) {
    case "fetch":
      return "Fetch";
    case "pull":
      return "Pull";
    case "push":
      return "Push";
    case "publish":
      return "Publish";
    case "diverged":
      return "Sync";
  }
}
