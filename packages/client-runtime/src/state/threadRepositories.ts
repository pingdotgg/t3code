import type {
  CheckpointScopeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadTurnRepositoryDiff,
} from "@t3tools/contracts";

type ChangedFiles = OrchestrationV2Checkpoint["files"];

/** One tracked Git repository a thread reaches. */
export interface ThreadRepositoryScope {
  readonly scopeId: CheckpointScopeId;
  /** Display name. */
  readonly name: string;
  /** Stable identity; matches `ThreadTurnDiff.repositories[].repositoryPath`. */
  readonly repositoryPath: string;
  /** The repository folder on the environment's disk; file paths resolve against it. */
  readonly cwd: string;
  /**
   * The repository folder from the thread's folder, `/`-separated; starts with `../` outside it.
   * Absent when the two folders share no root.
   */
  readonly relativePath?: string;
}

/** What one turn changed in one repository. `files` paths are relative to the repository. */
export interface TurnRepositoryChanges extends ThreadRepositoryScope {
  /** May be a prefix of the changed files when `filesTotal` is set. */
  readonly files: ChangedFiles;
  readonly filesTotal?: OrchestrationV2CheckpointFileTotals;
  /** The turn changed this repository, but nothing was recorded before it to compare with. */
  readonly baselineMissing: boolean;
}

interface ChangedFileList {
  readonly files: ChangedFiles;
  readonly filesTotal?: OrchestrationV2CheckpointFileTotals | undefined;
}

/** A turn's own files plus its repositories; `ThreadCheckpointSummary` has this shape. */
export interface TurnChangesSource extends ChangedFileList {
  readonly repositories?: ReadonlyArray<TurnRepositoryChanges> | undefined;
}

export interface TurnChanges {
  /** Files changed in the thread's own folder, relative to it. */
  readonly rootFiles: ChangedFiles;
  readonly repositories: ReadonlyArray<TurnRepositoryChanges>;
  /** Across the thread's folder and every repository. */
  readonly totals: OrchestrationV2CheckpointFileTotals;
}

/** One patch of a turn diff. Its file paths are relative to `relativePath`. */
export interface TurnDiffSection {
  readonly key: string;
  readonly name: string;
  /** Null for the thread's own folder. */
  readonly repositoryPath: string | null;
  /** Empty for the thread's own folder. */
  readonly relativePath: string;
  readonly diff: string;
}

const ROOT_SECTION_KEY = ".";
const NO_REPOSITORY_CHANGES: ReadonlyArray<TurnRepositoryChanges> = Object.freeze([]);
const NO_TURN_REPOSITORY_CHANGES: ReadonlyMap<
  RunId,
  ReadonlyArray<TurnRepositoryChanges>
> = new Map();

export function isRepositoryCheckpointScope(
  scope: Pick<OrchestrationV2CheckpointScope, "repositoryPath">,
): boolean {
  return typeof scope.repositoryPath === "string";
}

/** Scopes whose checkpoints belong to a repository, never to the thread's own timeline. */
export function repositoryCheckpointScopeIds(
  scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "repositoryPath">>,
): ReadonlySet<CheckpointScopeId> {
  return new Set(scopes.flatMap((scope) => (isRepositoryCheckpointScope(scope) ? [scope.id] : [])));
}

function pathSegments(path: string): { root: string; segments: string[] } | undefined {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (normalized.startsWith("/")) return { root: "/", segments };
  const drive = segments[0];
  if (drive === undefined || !/^[a-zA-Z]:$/.test(drive)) return undefined;
  return { root: drive.toLowerCase(), segments: segments.slice(1) };
}

function relativeFolderPath(from: string, to: string): string | undefined {
  const source = pathSegments(from);
  const target = pathSegments(to);
  if (source === undefined || target === undefined || source.root !== target.root) {
    return undefined;
  }
  const same = (left: string, right: string) =>
    source.root === "/" ? left === right : left.toLowerCase() === right.toLowerCase();
  let shared = 0;
  while (
    shared < source.segments.length &&
    shared < target.segments.length &&
    same(source.segments[shared]!, target.segments[shared]!)
  ) {
    shared += 1;
  }
  return [...source.segments.slice(shared).map(() => ".."), ...target.segments.slice(shared)].join(
    "/",
  );
}

function repositoryScope(
  scope: OrchestrationV2CheckpointScope,
  repositoryPath: string,
  threadCwd: string | undefined,
): ThreadRepositoryScope {
  const relativePath =
    threadCwd === undefined ? undefined : relativeFolderPath(threadCwd, scope.cwd);
  return {
    scopeId: scope.id,
    name: scope.label ?? scope.cwd.replaceAll("\\", "/").split("/").findLast(Boolean) ?? scope.cwd,
    repositoryPath,
    cwd: scope.cwd,
    ...(relativePath === undefined ? {} : { relativePath }),
  };
}

function byNameThenPath(left: ThreadRepositoryScope, right: ThreadRepositoryScope): number {
  return (
    left.name.localeCompare(right.name) || left.repositoryPath.localeCompare(right.repositoryPath)
  );
}

/** The repositories a thread reaches, by name and then path. */
export function threadRepositoryScopes(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpointScopes">,
): ReadonlyArray<ThreadRepositoryScope> {
  const scopes = projection.checkpointScopes;
  return scopes
    .flatMap((scope) =>
      scope.repositoryPath === undefined
        ? []
        : [
            repositoryScope(
              scope,
              scope.repositoryPath,
              scopes.find((candidate) => candidate.id === scope.parentScopeId)?.cwd,
            ),
          ],
    )
    .sort(byNameThenPath);
}

// Rows compare a turn's repositories by identity, so an unchanged turn keeps the same objects
// while later turns append checkpoints.
const changesByCheckpoint = new WeakMap<
  OrchestrationV2Checkpoint,
  {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly threadCwd: string | undefined;
    readonly changes: TurnRepositoryChanges;
  }
>();
const turnChangesByFirst = new WeakMap<
  TurnRepositoryChanges,
  ReadonlyArray<TurnRepositoryChanges>
>();

/**
 * Per run, the repositories it changed, by name and then path. A run that changed none has no
 * entry. Unchanged runs keep their array across calls.
 */
export function deriveTurnRepositoryChanges(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "checkpointScopes">,
): ReadonlyMap<RunId, ReadonlyArray<TurnRepositoryChanges>> {
  const scopes = projection.checkpointScopes;
  if (!scopes.some(isRepositoryCheckpointScope)) return NO_TURN_REPOSITORY_CHANGES;
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
  const withoutBaseline = new Set<string>();
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.status === "missing") {
      withoutBaseline.add(`${checkpoint.scopeId}\u0000${checkpoint.ordinalWithinScope + 1}`);
    }
  }
  const byRun = new Map<RunId, TurnRepositoryChanges[]>();
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.runId === null || checkpoint.status !== "ready") continue;
    const scope = scopeById.get(checkpoint.scopeId);
    if (scope?.repositoryPath === undefined) continue;
    const baselineMissing =
      checkpoint.files.length === 0 &&
      withoutBaseline.has(`${checkpoint.scopeId}\u0000${checkpoint.ordinalWithinScope}`);
    if (checkpoint.files.length === 0 && !baselineMissing) continue;
    const threadCwd =
      scope.parentScopeId === null ? undefined : scopeById.get(scope.parentScopeId)?.cwd;
    const cached = changesByCheckpoint.get(checkpoint);
    let changes = cached?.changes;
    if (
      cached === undefined ||
      changes === undefined ||
      cached.scope !== scope ||
      cached.threadCwd !== threadCwd ||
      changes.baselineMissing !== baselineMissing
    ) {
      changes = {
        ...repositoryScope(scope, scope.repositoryPath, threadCwd),
        files: checkpoint.files,
        ...(checkpoint.filesTotal === undefined ? {} : { filesTotal: checkpoint.filesTotal }),
        baselineMissing,
      };
      changesByCheckpoint.set(checkpoint, { scope, threadCwd, changes });
    }
    const forRun = byRun.get(checkpoint.runId);
    if (forRun === undefined) byRun.set(checkpoint.runId, [changes]);
    else forRun.push(changes);
  }
  const stable = new Map<RunId, ReadonlyArray<TurnRepositoryChanges>>();
  for (const [runId, repositories] of byRun) {
    repositories.sort(byNameThenPath);
    const first = repositories[0]!;
    const previous = turnChangesByFirst.get(first);
    if (
      previous !== undefined &&
      previous.length === repositories.length &&
      previous.every((entry, index) => entry === repositories[index])
    ) {
      stable.set(runId, previous);
    } else {
      turnChangesByFirst.set(first, repositories);
      stable.set(runId, repositories);
    }
  }
  return stable;
}

/** Totals for a file list that may be a prefix of what changed. */
export function changedFileTotals(list: ChangedFileList): OrchestrationV2CheckpointFileTotals {
  if (list.filesTotal !== undefined) return list.filesTotal;
  let additions = 0;
  let deletions = 0;
  for (const file of list.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { count: list.files.length, additions, deletions };
}

/** A turn's changed files: the thread folder's own, then each repository's, with totals. */
export function turnChanges(turn: TurnChangesSource): TurnChanges {
  const repositories = turn.repositories ?? NO_REPOSITORY_CHANGES;
  const totals = { ...changedFileTotals(turn) };
  for (const repository of repositories) {
    const repositoryTotals = changedFileTotals(repository);
    totals.count += repositoryTotals.count;
    totals.additions += repositoryTotals.additions;
    totals.deletions += repositoryTotals.deletions;
  }
  return { rootFiles: turn.files, repositories, totals };
}

/**
 * Whether a turn has changes to show. The thread folder's own checkpoint need not be ready: a
 * plain folder holding repositories never has one, and its turns still change those repositories.
 */
export function turnHasChanges(turn: TurnChangesSource): boolean {
  return turn.files.length > 0 || (turn.repositories?.length ?? 0) > 0;
}

/** A repository file's path from the thread's folder, as the turn diff sections name it. */
export function repositoryFilePath(relativePath: string, filePath: string): string {
  return relativePath === "" || relativePath === "." ? filePath : `${relativePath}/${filePath}`;
}

/**
 * The patches of a turn diff, the thread folder's own first. Empty patches are left out, so a
 * diff without repositories gives its one patch or nothing.
 */
export function turnDiffSections(
  diff: {
    readonly diff: string;
    readonly repositories?: ReadonlyArray<ThreadTurnRepositoryDiff> | undefined;
  },
  rootName: string,
): ReadonlyArray<TurnDiffSection> {
  const root: ReadonlyArray<TurnDiffSection> =
    diff.diff.trim() === ""
      ? []
      : [
          {
            key: ROOT_SECTION_KEY,
            name: rootName,
            repositoryPath: null,
            relativePath: "",
            diff: diff.diff,
          },
        ];
  return [
    ...root,
    ...(diff.repositories ?? []).flatMap((repository) =>
      repository.diff.trim() === ""
        ? []
        : [
            {
              key: repository.repositoryPath,
              name: repository.name,
              repositoryPath: repository.repositoryPath,
              relativePath: repository.relativePath,
              diff: repository.diff,
            },
          ],
    ),
  ];
}

/**
 * The repository section a thread-relative path belongs to, and the path inside that repository.
 * Null for a file of the thread's own folder.
 */
export function repositorySectionForPath(
  sections: ReadonlyArray<TurnDiffSection>,
  filePath: string,
): { readonly section: TurnDiffSection; readonly path: string } | null {
  let match: { readonly section: TurnDiffSection; readonly path: string } | null = null;
  for (const section of sections) {
    if (section.repositoryPath === null || section.relativePath === "") continue;
    const prefix = `${section.relativePath}/`;
    if (!filePath.startsWith(prefix)) continue;
    if (match === null || section.relativePath.length > match.section.relativePath.length) {
      match = { section, path: filePath.slice(prefix.length) };
    }
  }
  return match;
}
