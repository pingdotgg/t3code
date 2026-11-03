import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationGetTurnDiffResult,
  OrchestrationV2TurnItem,
  WorkspaceRepository,
} from "@t3tools/contracts";
import {
  isAbsolutePath,
  isWindowsAbsolutePath,
  resolveWorkspaceFilePath,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

import type {
  ThreadCheckpointFileSummary,
  ThreadCheckpointOutsideEdit,
  ThreadCheckpointRepositorySummary,
  ThreadCheckpointSummary,
} from "./threadCheckpoints.ts";

/**
 * The `workspace.listRepositories` target for a thread, or null for a project without tracked
 * folders, whose only repo is its home. The cwd is the thread's worktree or the home folder, so a
 * new worktree path is a new query.
 */
export function threadRepositoriesTarget(input: {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<
    OrchestrationProjectShell,
    "id" | "workspaceRoot" | "trackedFolders"
  > | null;
  readonly worktreePath: string | null;
}) {
  const { project } = input;
  if (project === null || project.trackedFolders.length === 0) return null;
  return {
    environmentId: input.environmentId,
    input: { projectId: project.id, cwd: input.worktreePath ?? project.workspaceRoot },
  };
}

export interface ChangedFilesRepositoryGroup {
  /** `home`, or the repo's tracked path. */
  readonly key: string;
  readonly name: string;
  readonly kind: WorkspaceRepository["kind"];
  /** Null for home: its files belong to the thread's own diff. */
  readonly repositoryPath: string | null;
  /** Where the files' paths start; null for home, which uses the thread's cwd. */
  readonly cwd: string | null;
  readonly files: ReadonlyArray<ThreadCheckpointFileSummary>;
}

export interface ChangedFilesByRepository {
  /** False for single-repo threads, which show no repo headers. */
  readonly multiRepo: boolean;
  /** Repos with changes, home first. */
  readonly groups: ReadonlyArray<ChangedFilesRepositoryGroup>;
  /** Repos of the thread without changes in this run. */
  readonly unchanged: ReadonlyArray<{
    readonly name: string;
    /** The capture failed, so "no changes" would not be true. */
    readonly failed: boolean;
  }>;
}

/**
 * A run's changed files grouped by repo. `repositories` is the thread's repo list; without it
 * only repos with a checkpoint in this run are known.
 */
export function groupChangedFilesByRepository(input: {
  readonly summary: Pick<ThreadCheckpointSummary, "files" | "repositories">;
  readonly repositories: ReadonlyArray<
    Pick<WorkspaceRepository, "name" | "originalPath" | "kind">
  > | null;
  /** Names the home group when the repo list has not loaded. */
  readonly homeName: string;
}): ChangedFilesByRepository {
  const { summary, repositories } = input;
  const home = repositories?.find((repository) => repository.kind === "home") ?? null;
  const tracked = repositories?.filter((repository) => repository.kind === "repository") ?? [];
  const multiRepo = summary.repositories.length > 0 || tracked.length > 0;
  const groups: ChangedFilesRepositoryGroup[] = [];
  const unchanged: Array<ChangedFilesByRepository["unchanged"][number]> = [];
  if (summary.files.length > 0) {
    groups.push({
      key: "home",
      name: home?.name ?? input.homeName,
      kind: "home",
      repositoryPath: null,
      cwd: null,
      files: summary.files,
    });
  } else if (multiRepo && home !== null) {
    unchanged.push({ name: home.name, failed: false });
  }
  const checkpointByPath = new Map<string, ThreadCheckpointRepositorySummary>(
    summary.repositories.map((repository) => [repository.repositoryPath, repository]),
  );
  const listed = new Set<string>();
  const addRepository = (
    name: string,
    checkpoint: ThreadCheckpointRepositorySummary | undefined,
  ) => {
    if (checkpoint !== undefined && checkpoint.files.length > 0) {
      groups.push({
        key: checkpoint.repositoryPath,
        name,
        kind: "repository",
        repositoryPath: checkpoint.repositoryPath,
        cwd: checkpoint.cwd,
        files: checkpoint.files,
      });
    } else {
      unchanged.push({ name, failed: checkpoint?.status === "error" });
    }
  };
  for (const repository of tracked) {
    listed.add(repository.originalPath);
    addRepository(repository.name, checkpointByPath.get(repository.originalPath));
  }
  // A repo removed from the project since this run still shows what the run changed.
  for (const checkpoint of summary.repositories) {
    if (!listed.has(checkpoint.repositoryPath)) addRepository(checkpoint.name, checkpoint);
  }
  return { multiRepo, groups, unchanged };
}

export interface RepositoryPatch {
  /** `home`, or the repo's tracked path. */
  readonly key: string;
  readonly name: string;
  /** Where the repo sits from the thread's cwd, with `/`; empty for home. */
  readonly relativePath: string;
  readonly patch: string;
}

/** A turn diff as one patch per repo, home first. */
export function turnDiffRepositoryPatches(
  diff: Pick<OrchestrationGetTurnDiffResult, "diff" | "repositories">,
  homeName: string,
): ReadonlyArray<RepositoryPatch> {
  return [
    { key: "home", name: homeName, relativePath: "", patch: diff.diff },
    ...(diff.repositories ?? []).map((repository) => ({
      key: repository.repositoryPath,
      name: repository.name,
      relativePath: repository.relativePath,
      patch: repository.diff,
    })),
  ];
}

/** A repo file's path from the thread's cwd, so every repo's files can share one list. */
export function threadRelativeFilePath(relativePath: string, filePath: string): string {
  const prefix = relativePath.replace(/\/+$/, "");
  return prefix.length === 0 || prefix === "." ? filePath : `${prefix}/${filePath}`;
}

/** Absolute paths the thread's file changes reported, newest first. Old paths of renames are left out. */
export function collectEditedFilePaths(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const item = turnItems[index];
    if (item?.type !== "file_change") continue;
    if (isAbsolutePath(item.fileName)) paths.add(item.fileName);
    for (const change of item.changes ?? []) {
      if (isAbsolutePath(change.path)) paths.add(change.path);
    }
  }
  return [...paths];
}

export interface RepositoryFileLinkCandidate {
  readonly path: string;
  /** The repo holding the file; null when the path is in none of the thread's repos. */
  readonly repositoryName: string | null;
}

/** Whether `path` ends with `suffix` at a folder boundary; Windows paths ignore case. */
function endsWithPath(path: string, suffix: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return isWindowsAbsolutePath(path)
    ? normalized.toLowerCase().endsWith(`/${suffix.toLowerCase()}`)
    : normalized.endsWith(`/${suffix}`);
}

function repositoryNameFor(
  path: string,
  repositories: ReadonlyArray<Pick<WorkspaceRepository, "name" | "cwd">>,
): string | null {
  let best: { name: string; length: number } | null = null;
  for (const repository of repositories) {
    if (workspaceRelativeFilePath(path, repository.cwd) === null) continue;
    if (best === null || repository.cwd.length > best.length) {
      best = { name: repository.name, length: repository.cwd.length };
    }
  }
  return best?.name ?? null;
}

/**
 * Where a relative file link from the agent points in a multi-repo thread: first files the
 * thread edited that end with the path, then the repos where the path exists. Empty means the
 * caller keeps the plain join with the thread's cwd. Paths starting with `../` or `~/` already
 * name one place, so they get no candidates.
 */
export async function findRepositoryFileLinkCandidates(input: {
  readonly path: string;
  readonly editedPaths: ReadonlyArray<string>;
  readonly repositories: ReadonlyArray<Pick<WorkspaceRepository, "name" | "cwd">>;
  /** Whether each path exists, in order. */
  readonly exists: (paths: ReadonlyArray<string>) => Promise<ReadonlyArray<boolean>>;
}): Promise<ReadonlyArray<RepositoryFileLinkCandidate>> {
  const relativePath = input.path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("~/") ||
    isAbsolutePath(relativePath)
  ) {
    return [];
  }
  const edited = input.editedPaths.filter((path) => endsWithPath(path, relativePath));
  if (edited.length > 0) {
    return edited.map((path) => ({
      path,
      repositoryName: repositoryNameFor(path, input.repositories),
    }));
  }
  const joined = input.repositories.map((repository) => ({
    path: resolveWorkspaceFilePath(relativePath, repository.cwd),
    repositoryName: repository.name,
  }));
  if (joined.length === 0) return [];
  const exists = await input.exists(joined.map((candidate) => candidate.path));
  return joined.filter((_, index) => exists[index] === true);
}

/** `~/code/infra` for a folder under the user's home on macOS, Linux or Windows. */
function abbreviateHomeFolder(path: string): string {
  const match = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/.exec(
    path,
  );
  return match === null ? path : `~${path.slice(match[0].length).replaceAll("\\", "/")}`;
}

/** The outside-edit notice line, the same on every client. */
export function describeOutsideEdit(edit: ThreadCheckpointOutsideEdit): string {
  const files = `${edit.fileCount} ${edit.fileCount === 1 ? "file" : "files"}`;
  const folder = abbreviateHomeFolder(edit.root);
  return edit.tracked
    ? `Edited ${files} in ${folder}, which this thread has no history for`
    : `Edited ${files} in ${folder}, which this project does not track`;
}

export const OUTSIDE_EDITS_SHELL_NOTE = "Edits made through shell commands can be missed.";
