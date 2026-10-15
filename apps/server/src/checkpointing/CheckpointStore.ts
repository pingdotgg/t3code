/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * A multi-repo workspace folder (see `WorkspaceRepositories`) is checkpointed as
 * one unit: every operation fans out to each repository under the same ref, and
 * diffs report paths relative to the workspace folder. Restores check every
 * repository has the ref first, but are not atomic across repositories.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { VcsUnsupportedOperationError, type CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspaceRepositories from "../workspace/WorkspaceRepositories.ts";
import { parseTurnDiffFilesFromNumstat, prefixNumstatPaths, prefixPatchPaths } from "./Diffs.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** Capture only in repositories without the ref, keeping checkpoints already taken. */
  readonly missingOnly?: boolean;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a Git worktree or is a multi-repo workspace folder. */
    readonly isCheckpointable: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a diff between two checkpoint refs. Defaults to a full patch.
     *
     * Numstat output has NUL-delimited paths for file summaries.
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * List paths changed by work done after the "from" checkpoint: uncommitted
     * edits at either checkpoint, commits made after "from", and commits that
     * left HEAD. Commits a pull, merge, or rebase brought in are older than
     * "from", so their paths are not listed.
     *
     * Returns null when HEAD did not move or a checkpoint does not record HEAD.
     * Then every changed path belongs to the turn.
     */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** One repository a checkpoint operation runs in, and where its paths sit under the cwd. */
interface CheckpointTarget {
  readonly cwd: string;
  readonly pathPrefix: string | null;
}

const MULTI_REPO_CONCURRENCY = 4;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const workspaceRepositories = yield* WorkspaceRepositories.WorkspaceRepositories;
  const path = yield* Path.Path;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository = (cwd: string) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  // A cwd that is no repository and holds none stays a single target, so its operations
  // fail the way they always have.
  const resolveTargets = Effect.fn("CheckpointStore.resolveTargets")(function* (cwd: string) {
    if (yield* isGitRepository(cwd)) return [{ cwd, pathPrefix: null }];
    const repositories = yield* workspaceRepositories.list(cwd);
    if (repositories.length === 0) return [{ cwd, pathPrefix: null }];
    return repositories.map((repository): CheckpointTarget => ({
      cwd: path.join(cwd, ...repository.relativePath.split("/")),
      pathPrefix: repository.relativePath,
    }));
  });

  const forEachTarget = <A, E, R>(
    targets: ReadonlyArray<CheckpointTarget>,
    run: (target: CheckpointTarget) => Effect.Effect<A, E, R>,
  ) => Effect.forEach(targets, run, { concurrency: MULTI_REPO_CONCURRENCY });

  const isCheckpointable: CheckpointStore["Service"]["isCheckpointable"] = Effect.fn(
    "isCheckpointable",
  )(function* (cwd) {
    if (yield* isGitRepository(cwd)) return true;
    return (yield* workspaceRepositories.list(cwd)).length > 0;
  });

  const hasRefIn = (target: CheckpointTarget, checkpointRef: CheckpointRef) =>
    resolveCheckpoints("CheckpointStore.hasCheckpointRef", target.cwd).pipe(
      Effect.flatMap((checkpoints) =>
        checkpoints.hasCheckpointRef({ cwd: target.cwd, checkpointRef }),
      ),
    );

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    yield* forEachTarget(yield* resolveTargets(input.cwd), (target) =>
      Effect.gen(function* () {
        if (input.missingOnly && (yield* hasRefIn(target, input.checkpointRef))) return;
        const checkpoints = yield* resolveCheckpoints(
          "CheckpointStore.captureCheckpoint",
          target.cwd,
        );
        yield* checkpoints.captureCheckpoint({
          cwd: target.cwd,
          checkpointRef: input.checkpointRef,
        });
      }),
    );
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const found = yield* forEachTarget(yield* resolveTargets(input.cwd), (target) =>
      hasRefIn(target, input.checkpointRef),
    );
    return found.every(Boolean);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const targets = yield* resolveTargets(input.cwd);
    // Refuse up front rather than restore some repositories and then find one without the ref.
    if (targets.length > 1 && input.fallbackToHead !== true) {
      const found = yield* forEachTarget(targets, (target) =>
        hasRefIn(target, input.checkpointRef),
      );
      if (!found.every(Boolean)) return false;
    }
    // One at a time, so a failure can name the repositories that were already restored.
    const restored = yield* Effect.forEach(targets, (target, index) =>
      resolveCheckpoints("CheckpointStore.restoreCheckpoint", target.cwd).pipe(
        Effect.flatMap((checkpoints) =>
          checkpoints.restoreCheckpoint({ ...input, cwd: target.cwd }),
        ),
        Effect.tapError(() =>
          index === 0
            ? Effect.void
            : Effect.logWarning("Checkpoint restore failed after restoring other repositories", {
                failed: target.cwd,
                restored: targets.slice(0, index).map((done) => done.cwd),
              }),
        ),
      ),
    );
    return restored.every(Boolean);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const targets = yield* resolveTargets(input.cwd);
    const diffs = yield* forEachTarget(targets, (target) =>
      Effect.gen(function* () {
        const checkpoints = yield* resolveCheckpoints(
          "CheckpointStore.diffCheckpoints",
          target.cwd,
        );
        if (target.pathPrefix === null) {
          return yield* checkpoints.diffCheckpoints({ ...input, cwd: target.cwd });
        }
        // A repository added to the workspace after either checkpoint has nothing to compare.
        const comparable =
          (yield* checkpoints.hasCheckpointRef({
            cwd: target.cwd,
            checkpointRef: input.toCheckpointRef,
          })) &&
          (input.fallbackFromToHead === true ||
            (yield* checkpoints.hasCheckpointRef({
              cwd: target.cwd,
              checkpointRef: input.fromCheckpointRef,
            })));
        if (!comparable) return "";
        // Requested paths are relative to the workspace folder.
        const repositoryPrefix = `${target.pathPrefix}/`;
        const diff = yield* checkpoints.diffCheckpoints({
          ...input,
          cwd: target.cwd,
          ...(input.filePaths
            ? {
                filePaths: input.filePaths.flatMap((filePath) =>
                  filePath.startsWith(repositoryPrefix)
                    ? [filePath.slice(repositoryPrefix.length)]
                    : [],
                ),
              }
            : {}),
        });
        return input.format === "numstat"
          ? prefixNumstatPaths(diff, target.pathPrefix)
          : prefixPatchPaths(diff, target.pathPrefix);
      }),
    );
    return diffs.join("");
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const targets = yield* resolveTargets(input.cwd);
    if (targets.length === 1 && targets[0]!.pathPrefix === null) {
      const checkpoints = yield* resolveCheckpoints("CheckpointStore.listAuthoredPaths", input.cwd);
      return yield* checkpoints.listAuthoredPaths(input);
    }
    const perRepository = yield* forEachTarget(targets, (target) =>
      Effect.gen(function* () {
        const checkpoints = yield* resolveCheckpoints(
          "CheckpointStore.listAuthoredPaths",
          target.cwd,
        );
        // A repository without both checkpoints has no diff, so nothing of it is listed.
        const comparable =
          (yield* checkpoints.hasCheckpointRef({
            cwd: target.cwd,
            checkpointRef: input.fromCheckpointRef,
          })) &&
          (yield* checkpoints.hasCheckpointRef({
            cwd: target.cwd,
            checkpointRef: input.toCheckpointRef,
          }));
        if (!comparable) return { target, paths: new Set<string>() };
        return {
          target,
          paths: yield* checkpoints.listAuthoredPaths({ ...input, cwd: target.cwd }),
        };
      }),
    );
    if (perRepository.every(({ paths }) => paths === null)) return null;
    // The result is one set for the workspace, so a repository whose HEAD did not move lists
    // every path it changed.
    const authored = new Set<string>();
    for (const { target, paths } of perRepository) {
      let repositoryPaths: Iterable<string> | null = paths;
      if (repositoryPaths === null) {
        const numstat = yield* resolveCheckpoints(
          "CheckpointStore.listAuthoredPaths",
          target.cwd,
        ).pipe(
          Effect.flatMap((checkpoints) =>
            checkpoints.diffCheckpoints({
              ...input,
              cwd: target.cwd,
              ignoreWhitespace: false,
              format: "numstat",
            }),
          ),
        );
        repositoryPaths = parseTurnDiffFilesFromNumstat(numstat).flatMap((file) =>
          file.previousPath === undefined ? [file.path] : [file.path, file.previousPath],
        );
      }
      for (const repositoryPath of repositoryPaths) {
        authored.add(`${target.pathPrefix}/${repositoryPath}`);
      }
    }
    return authored;
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    yield* forEachTarget(yield* resolveTargets(input.cwd), (target) =>
      resolveCheckpoints("CheckpointStore.deleteCheckpointRefs", target.cwd).pipe(
        Effect.flatMap((checkpoints) =>
          checkpoints.deleteCheckpointRefs({ ...input, cwd: target.cwd }),
        ),
      ),
    );
  });

  return CheckpointStore.of({
    isCheckpointable,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make).pipe(
  Layer.provide(WorkspaceRepositories.layer),
);
