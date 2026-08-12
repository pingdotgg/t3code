import {
  WorktreeStorageError,
  threadKeepsWorktreeActive,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type WorktreeCleanupInput,
  type WorktreeCleanupOutcome,
  type WorktreeCleanupResult,
  type WorktreeStorageEntry,
  type WorktreeStoragePreviewResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { parseWorktreeBranchPaths } from "./GitVcsDriverCore.ts";

const WORKTREE_LIST_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const FILE_STAT_CONCURRENCY = 32;
const WORKTREE_INSPECTION_CONCURRENCY = 4;

interface ManagedWorktree {
  readonly path: string;
  readonly refName: string;
}

export class WorktreeStorage extends Context.Service<
  WorktreeStorage,
  {
    readonly preview: () => Effect.Effect<WorktreeStoragePreviewResult, WorktreeStorageError>;
    readonly cleanup: (
      input: WorktreeCleanupInput,
    ) => Effect.Effect<WorktreeCleanupResult, WorktreeStorageError>;
  }
>()("t3/vcs/WorktreeStorage") {}

function boundedByteCount(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(value)));
}

function sumByteCounts(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total = boundedByteCount(total + value);
  }
  return total;
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(Effect.orElseSucceed(() => resolvedPath));
  };

  const pathExists = (operation: string, value: string) =>
    fileSystem.exists(value).pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeStorageError({
            operation,
            detail: "Could not check whether the worktree path exists.",
            path: value,
            cause,
          }),
      ),
    );

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const loadShellSnapshot = (operation: string) =>
    projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeStorageError({
            operation,
            detail: "Could not read the current projects and active threads.",
            cause,
          }),
      ),
    );

  const resolveActivePaths = Effect.fn("WorktreeStorage.resolveActivePaths")(function* (
    snapshot: OrchestrationShellSnapshot,
  ) {
    const candidates = [
      ...snapshot.projects.map((project) => project.workspaceRoot),
      ...snapshot.threads.flatMap((thread) =>
        thread.worktreePath === null || !threadKeepsWorktreeActive(thread)
          ? []
          : [thread.worktreePath],
      ),
    ];
    const canonicalPaths = yield* Effect.forEach(candidates, canonicalizePath, {
      concurrency: 16,
    });
    return new Set(canonicalPaths);
  });

  const listManagedWorktrees = Effect.fn("WorktreeStorage.listManagedWorktrees")(function* (
    project: OrchestrationProjectShell,
    worktreesRoot: string,
  ): Effect.fn.Return<ReadonlyArray<ManagedWorktree>, WorktreeStorageError> {
    const result = yield* git
      .execute({
        operation: "WorktreeStorage.listManagedWorktrees",
        cwd: project.workspaceRoot,
        args: ["worktree", "list", "--porcelain", "-z"],
        allowNonZeroExit: true,
        timeoutMs: 30_000,
        maxOutputBytes: WORKTREE_LIST_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new WorktreeStorageError({
              operation: "WorktreeStorage.listManagedWorktrees",
              detail: `Could not inspect worktrees for ${project.title}.`,
              path: project.workspaceRoot,
              cause,
            }),
        ),
      );

    if (result.exitCode !== 0) {
      return [];
    }
    if (result.stdoutTruncated) {
      return yield* new WorktreeStorageError({
        operation: "WorktreeStorage.listManagedWorktrees",
        detail: `The worktree list for ${project.title} was too large to inspect safely.`,
        path: project.workspaceRoot,
      });
    }

    const candidates = [...parseWorktreeBranchPaths(result.stdout)].map(
      ([refName, worktreePath]) => ({ refName, path: worktreePath }),
    );
    const inspected = yield* Effect.forEach(
      candidates,
      Effect.fn("WorktreeStorage.inspectManagedPath")(function* (candidate) {
        if (!(yield* pathExists("WorktreeStorage.listManagedWorktrees", candidate.path))) {
          return null;
        }
        const canonicalPath = yield* canonicalizePath(candidate.path);
        if (canonicalPath === worktreesRoot || !isWithinRoot(canonicalPath, worktreesRoot)) {
          return null;
        }
        return { ...candidate, path: canonicalPath } satisfies ManagedWorktree;
      }),
      { concurrency: 16 },
    );

    return inspected.flatMap((candidate) => (candidate === null ? [] : [candidate]));
  });

  const measureDirectory = Effect.fn("WorktreeStorage.measureDirectory")(function* (
    worktreePath: string,
  ): Effect.fn.Return<number, WorktreeStorageError> {
    const relativeEntries = yield* fileSystem.readDirectory(worktreePath, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeStorageError({
            operation: "WorktreeStorage.measureDirectory",
            detail: "Could not enumerate the worktree while measuring its size.",
            path: worktreePath,
            cause,
          }),
      ),
    );
    const fileStats = yield* Effect.forEach(
      relativeEntries,
      (relativeEntry) => {
        const entryPath = path.resolve(worktreePath, relativeEntry);
        if (!isWithinRoot(entryPath, worktreePath)) {
          return Effect.succeed(null);
        }
        return fileSystem.stat(entryPath).pipe(
          Effect.map((info) =>
            info.type === "File"
              ? {
                  device: info.dev,
                  inode: Option.getOrNull(info.ino),
                  links: Option.getOrElse(info.nlink, () => 1),
                  sizeBytes: Number(info.size),
                }
              : null,
          ),
          Effect.catch((cause) =>
            cause instanceof PlatformError.PlatformError && cause.reason._tag === "NotFound"
              ? Effect.succeed(null)
              : Effect.fail(
                  new WorktreeStorageError({
                    operation: "WorktreeStorage.measureDirectory",
                    detail: "Could not inspect a worktree entry while measuring its size.",
                    path: entryPath,
                    cause,
                  }),
                ),
          ),
        );
      },
      { concurrency: FILE_STAT_CONCURRENCY },
    );

    const seenHardLinks = new Set<string>();
    let sizeBytes = 0;
    for (const stats of fileStats) {
      if (stats === null) continue;
      if (stats.links > 1 && stats.inode !== null) {
        const hardLinkKey = `${stats.device}:${stats.inode}`;
        if (seenHardLinks.has(hardLinkKey)) continue;
        seenHardLinks.add(hardLinkKey);
      }
      sizeBytes = boundedByteCount(sizeBytes + stats.sizeBytes);
    }
    return sizeBytes;
  });

  const preview: WorktreeStorage["Service"]["preview"] = Effect.fn("WorktreeStorage.preview")(
    function* () {
      const snapshot = yield* loadShellSnapshot("WorktreeStorage.preview");
      const [worktreesRoot, activePaths] = yield* Effect.all(
        [canonicalizePath(config.worktreesDir), resolveActivePaths(snapshot)],
        { concurrency: 2 },
      );
      const seenPaths = new Set<string>();
      const projects: WorktreeStoragePreviewResult["projects"][number][] = [];

      for (const project of snapshot.projects) {
        const listedWorktrees = yield* listManagedWorktrees(project, worktreesRoot);
        const projectWorktrees = listedWorktrees.filter((worktree) => {
          if (seenPaths.has(worktree.path)) return false;
          seenPaths.add(worktree.path);
          return true;
        });
        const worktrees = yield* Effect.forEach(
          projectWorktrees,
          Effect.fn("WorktreeStorage.inspectWorktree")(function* (worktree): Effect.fn.Return<
            WorktreeStorageEntry,
            WorktreeStorageError
          > {
            const isActive = activePaths.has(worktree.path);
            const [sizeBytes, hasWorkingTreeChanges] = yield* Effect.all(
              [
                measureDirectory(worktree.path),
                isActive
                  ? Effect.succeed(false)
                  : git.statusDetailsLocal(worktree.path).pipe(
                      Effect.map((status) => status.hasWorkingTreeChanges),
                      Effect.mapError(
                        (cause) =>
                          new WorktreeStorageError({
                            operation: "WorktreeStorage.preview",
                            detail: "Could not determine whether the worktree has local changes.",
                            path: worktree.path,
                            cause,
                          }),
                      ),
                    ),
              ],
              { concurrency: 2 },
            );
            return {
              ...worktree,
              sizeBytes,
              status: isActive ? "active" : hasWorkingTreeChanges ? "dirty" : "clean",
            };
          }),
          { concurrency: WORKTREE_INSPECTION_CONCURRENCY },
        );
        if (worktrees.length === 0) continue;

        const sortedWorktrees = worktrees.toSorted(
          (left, right) =>
            right.sizeBytes - left.sizeBytes || left.refName.localeCompare(right.refName),
        );
        projects.push({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          faviconPath: project.faviconPath ?? null,
          worktrees: sortedWorktrees,
        });
      }

      return {
        totalSizeBytes: sumByteCounts(
          projects.flatMap((project) => project.worktrees.map((worktree) => worktree.sizeBytes)),
        ),
        projects,
      };
    },
  );

  const cleanup: WorktreeStorage["Service"]["cleanup"] = Effect.fn("WorktreeStorage.cleanup")(
    function* (input) {
      const snapshot = yield* loadShellSnapshot("WorktreeStorage.cleanup");
      const [worktreesRoot, activePaths, confirmedDirtyPaths] = yield* Effect.all(
        [
          canonicalizePath(config.worktreesDir),
          resolveActivePaths(snapshot),
          Effect.forEach(input.confirmedDirtyPaths ?? [], canonicalizePath, {
            concurrency: 16,
          }).pipe(Effect.map((paths) => new Set(paths))),
        ],
        { concurrency: 3 },
      );
      const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
      const listedWorktreesByProject = new Map<string, ReadonlyArray<ManagedWorktree>>();
      const handledTargets = new Set<string>();
      const outcomes: WorktreeCleanupOutcome[] = [];

      for (const target of input.targets) {
        const canonicalTargetPath = yield* canonicalizePath(target.path);
        const targetKey = `${target.projectId}\0${canonicalTargetPath}`;
        if (handledTargets.has(targetKey)) continue;
        handledTargets.add(targetKey);

        const record = (status: WorktreeCleanupOutcome["status"], detail?: string) => {
          outcomes.push({
            ...target,
            path: canonicalTargetPath,
            status,
            ...(detail === undefined ? {} : { detail }),
          });
        };

        const project = projectsById.get(target.projectId);
        if (!project) {
          record("skipped_missing");
          continue;
        }
        if (!(yield* pathExists("WorktreeStorage.cleanup", canonicalTargetPath))) {
          record("skipped_missing");
          continue;
        }
        if (
          canonicalTargetPath === worktreesRoot ||
          !isWithinRoot(canonicalTargetPath, worktreesRoot)
        ) {
          record("skipped_missing", "The selected path is not a T3-managed worktree.");
          continue;
        }
        if (activePaths.has(canonicalTargetPath)) {
          record("skipped_active");
          continue;
        }

        let projectWorktrees = listedWorktreesByProject.get(project.id);
        if (!projectWorktrees) {
          const listedResult = yield* Effect.result(listManagedWorktrees(project, worktreesRoot));
          if (listedResult._tag === "Failure") {
            record("failed", listedResult.failure.message);
            continue;
          }
          projectWorktrees = listedResult.success;
          listedWorktreesByProject.set(project.id, projectWorktrees);
        }
        if (!projectWorktrees.some((worktree) => worktree.path === canonicalTargetPath)) {
          record("skipped_missing");
          continue;
        }

        const statusResult = yield* Effect.result(git.statusDetailsLocal(canonicalTargetPath));
        if (statusResult._tag === "Failure") {
          record("failed", statusResult.failure.message);
          continue;
        }
        if (
          statusResult.success.hasWorkingTreeChanges &&
          !confirmedDirtyPaths.has(canonicalTargetPath)
        ) {
          record("skipped_dirty");
          continue;
        }

        // Force is required to remove ignored build artifacts. The fresh status check above keeps
        // tracked and untracked user changes opt-in, while Git keeps the branch and every commit.
        const removeResult = yield* Effect.result(
          git.removeWorktree({
            cwd: project.workspaceRoot,
            path: canonicalTargetPath,
            force: true,
          }),
        );
        if (removeResult._tag === "Success") {
          record("removed");
        } else {
          record("failed", removeResult.failure.message);
        }
      }

      return { outcomes };
    },
  );

  return WorktreeStorage.of({ preview, cleanup });
});
