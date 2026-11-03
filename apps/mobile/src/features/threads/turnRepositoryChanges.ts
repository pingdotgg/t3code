import type {
  ThreadCheckpointOutsideEdit,
  ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import { groupChangedFilesByRepository } from "@t3tools/client-runtime/state/thread-repositories";
import type { WorkspaceRepository } from "@t3tools/contracts";

import { getReviewSectionIdForCheckpoint } from "../review/reviewModel";
import { reviewSectionPrefixForCwd } from "../review/reviewRepositories";

export interface TurnRepositoryChange {
  /** The repo's cwd for this thread, or null for home. */
  readonly cwd: string | null;
  readonly name: string;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface TurnRepositoryChanges {
  /** False for single-repo threads, which keep the single diff stat. */
  readonly multiRepo: boolean;
  /** Home first, then tracked repos in project order. */
  readonly changed: ReadonlyArray<TurnRepositoryChange>;
  readonly unchanged: ReadonlyArray<string>;
  /** Repos whose capture failed, so "no changes" would not be true. */
  readonly failed: ReadonlyArray<string>;
  readonly additions: number;
  readonly deletions: number;
}

/** A turn's changes by repo. `repositories` is the thread's repo list, or null before it loads. */
export function groupTurnChangesByRepository(
  summary: Pick<ThreadCheckpointSummary, "files" | "repositories">,
  repositories: ReadonlyArray<Pick<WorkspaceRepository, "name" | "originalPath" | "kind">> | null,
  homeName: string,
): TurnRepositoryChanges {
  const grouped = groupChangedFilesByRepository({ summary, repositories, homeName });
  const cwdByPath = new Map(
    summary.repositories.map((repository) => [repository.repositoryPath, repository.cwd]),
  );
  const changed = grouped.groups.map((group) => ({
    cwd: group.repositoryPath === null ? null : (cwdByPath.get(group.repositoryPath) ?? null),
    name: group.name,
    fileCount: group.files.length,
    additions: group.files.reduce((total, file) => total + file.additions, 0),
    deletions: group.files.reduce((total, file) => total + file.deletions, 0),
  }));
  return {
    multiRepo: grouped.multiRepo,
    changed,
    unchanged: grouped.unchanged.filter((entry) => !entry.failed).map((entry) => entry.name),
    failed: grouped.unchanged.filter((entry) => entry.failed).map((entry) => entry.name),
    additions: changed.reduce((total, entry) => total + entry.additions, 0),
    deletions: changed.reduce((total, entry) => total + entry.deletions, 0),
  };
}

/** The review section that opens one repo's diff of the turn. */
export function turnRepositorySectionId(
  summary: Pick<ThreadCheckpointSummary, "checkpointTurnCount">,
  change: Pick<TurnRepositoryChange, "cwd"> | undefined,
): string {
  return `${reviewSectionPrefixForCwd(change?.cwd ?? null)}${getReviewSectionIdForCheckpoint(summary)}`;
}

function abbreviateHomePath(path: string): string {
  const match = path.match(
    /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=$|[\\/])/i,
  );
  return match ? `~${path.slice(match[0].length)}` : path;
}

export function outsideEditLabel(edit: ThreadCheckpointOutsideEdit): string {
  const files = `${edit.fileCount} file${edit.fileCount === 1 ? "" : "s"}`;
  const path = abbreviateHomePath(edit.root);
  return edit.tracked
    ? `Edited ${files} in ${path}, which has no history in this thread`
    : `Edited ${files} in ${path}, which this project does not track`;
}
