import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { OrchestrationGetTurnDiffResult, WorkspaceRepository } from "@t3tools/contracts";

export type ReviewTurnDiff = Pick<OrchestrationGetTurnDiffResult, "diff" | "repositories">;

/** A repo the review screen can show. */
export interface ReviewRepository {
  readonly name: string;
  /** Where diffs run. */
  readonly cwd: string;
  /**
   * Home reads the root checkpoints. A tracked repo reads its own checkpoints and turn patches by
   * tracked path, which stays stable across task folders. A folder outside the thread has none.
   */
  readonly history: "home" | { readonly repositoryPath: string } | null;
}

export function reviewRepositoriesFromWorkspace(
  repositories: ReadonlyArray<WorkspaceRepository>,
): ReadonlyArray<ReviewRepository> {
  return repositories.map((repository) => ({
    name: repository.name,
    cwd: repository.cwd,
    history: repository.kind === "home" ? "home" : { repositoryPath: repository.originalPath },
  }));
}

/** Adds a repo the agent edited outside the thread, unless the thread already reviews it. */
export function withOutsideReviewRepository(
  repositories: ReadonlyArray<ReviewRepository>,
  outside: { readonly name: string; readonly root: string } | null,
): ReadonlyArray<ReviewRepository> {
  if (outside === null || repositories.some((repository) => repository.cwd === outside.root)) {
    return repositories;
  }
  return [...repositories, { name: outside.name, cwd: outside.root, history: null }];
}

/**
 * Section ids of other repos start with the repo's cwd, so section caches, file state and inline
 * comments stay per repo. Home keeps the ids that single-repo threads use.
 */
export function reviewSectionPrefixForCwd(cwd: string | null): string {
  return cwd === null ? "" : `repo:${cwd}|`;
}

export function reviewRepositorySectionPrefix(repository: ReviewRepository | null): string {
  return reviewSectionPrefixForCwd(
    repository === null || repository.history === "home" ? null : repository.cwd,
  );
}

/** The repo a stored section id belongs to. Ids without a known repo prefix belong to home. */
export function resolveReviewRepository(
  repositories: ReadonlyArray<ReviewRepository>,
  sectionId: string | null,
): ReviewRepository | null {
  let match: ReviewRepository | null = null;
  let matchLength = 0;
  for (const repository of repositories) {
    const prefix = reviewRepositorySectionPrefix(repository);
    // Paths can contain the delimiter, so the longest matching prefix wins.
    if (prefix === "" || !sectionId?.startsWith(prefix) || prefix.length <= matchLength) continue;
    match = repository;
    matchLength = prefix.length;
  }
  return (
    match ??
    repositories.find((repository) => repository.history === "home") ??
    repositories[0] ??
    null
  );
}

/** The same section (turn N, Changes, Uncommitted) in another repo. */
export function moveReviewSectionId(
  sectionId: string | null,
  from: ReviewRepository | null,
  to: ReviewRepository | null,
): string | null {
  if (sectionId === null) return null;
  const base = sectionId.slice(reviewRepositorySectionPrefix(from).length);
  return `${reviewRepositorySectionPrefix(to)}${base}`;
}

/** Turn summaries as one repo sees them: home reads the root checkpoint, a tracked repo its own. */
export function checkpointsForReviewRepository(
  summaries: ReadonlyArray<ThreadCheckpointSummary>,
  repository: ReviewRepository | null,
): ReadonlyArray<ThreadCheckpointSummary> {
  if (repository === null || repository.history === "home") return summaries;
  const { history } = repository;
  if (history === null) return [];
  return summaries.flatMap((summary) => {
    const entry = summary.repositories.find(
      (candidate) => candidate.repositoryPath === history.repositoryPath,
    );
    return entry === undefined ? [] : [{ ...summary, status: entry.status, files: entry.files }];
  });
}

/** One repo's patch from a turn diff. Repos without changes in the range are absent. */
export function turnDiffForReviewRepository(
  turnDiff: ReviewTurnDiff | null | undefined,
  repository: ReviewRepository | null,
): string | undefined {
  if (turnDiff == null) return undefined;
  if (repository === null || repository.history === "home") return turnDiff.diff;
  const { history } = repository;
  return (
    (history === null
      ? undefined
      : turnDiff.repositories?.find((entry) => entry.repositoryPath === history.repositoryPath)
          ?.diff) ?? ""
  );
}

/** Answers decode new arrays, so a repeated answer compares by content. */
export function sameReviewTurnDiff(
  left: ReviewTurnDiff | undefined,
  right: ReviewTurnDiff,
): boolean {
  if (left === undefined || left.diff !== right.diff) return false;
  const leftRepositories = left.repositories ?? [];
  const rightRepositories = right.repositories ?? [];
  return (
    leftRepositories.length === rightRepositories.length &&
    leftRepositories.every(
      (entry, index) =>
        entry.repositoryPath === rightRepositories[index]?.repositoryPath &&
        entry.diff === rightRepositories[index]?.diff,
    )
  );
}
