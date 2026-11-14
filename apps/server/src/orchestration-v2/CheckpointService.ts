import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  type OrchestrationV2AppThread,
  type ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";
// The provider turn waits on the baseline, so a workspace too slow for this starts without one.
// It bounds only the snapshot: waiting on the lock lets an in-flight capture finish the same ref.
const BASELINE_CAPTURE_BUDGET = "5 seconds";
// Git processes are already capped server-wide; this keeps one thread from taking every slot.
const REPOSITORY_SCOPE_CONCURRENCY = 6;

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export class CheckpointDeleteStaleRefsError extends Schema.TaggedError<CheckpointDeleteStaleRefsError>()(
  "CheckpointDeleteStaleRefsError",
  {
    scopeId: CheckpointScopeId,
    checkpointIds: Schema.Array(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete stale checkpoint refs for scope ${this.scopeId}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

/** Per scope, the other scopes' folders inside its own: relative, `/`-separated. */
type NestedScopePaths = ReadonlyMap<CheckpointScopeId, ReadonlyArray<string>>;

/**
 * A scope leaves a folder that has its own scope to that scope, so a clone inside another checkout
 * is not also recorded as that checkout's gitlink. Real paths, since a folder can be reached
 * through a symlink.
 */
export const nestedScopePaths = Effect.fn("CheckpointService.nestedScopePaths")(function* (
  scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "cwd">>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* Effect.forEach(
    scopes,
    (scope) =>
      fileSystem.realPath(scope.cwd).pipe(
        Effect.orElseSucceed(() => path.resolve(scope.cwd)),
        Effect.map((cwd) => ({ id: scope.id, cwd })),
      ),
    { concurrency: REPOSITORY_SCOPE_CONCURRENCY },
  );
  const nested = new Map<CheckpointScopeId, ReadonlyArray<string>>();
  for (const outer of resolved) {
    const inside = resolved.flatMap((inner) => {
      const relative = path.relative(outer.cwd, inner.cwd);
      return relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
        ? []
        : [relative.split(path.sep).join("/")];
    });
    if (inside.length > 0) nested.set(outer.id, [...new Set(inside)]);
  }
  return nested as NestedScopePaths;
});

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  /**
   * One scope per tracked Git folder the thread reaches now, under its root scope. Ids depend only
   * on the thread and the tracked path, so every run names the same scope. Empty when the folders
   * cannot be read: the thread then runs with its root scope alone.
   */
  readonly repositoryScopes: (input: {
    readonly rootScope: OrchestrationV2CheckpointScope;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2CheckpointScope>>;
  readonly nestedScopePaths: (
    scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "cwd">>,
  ) => Effect.Effect<NestedScopePaths>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /**
     * Also baselines the tracked repositories this thread reaches, a few at a time and all within
     * one budget, so many repositories delay a turn no longer than one. A repository that misses
     * the budget has no baseline this turn.
     */
    readonly thread?: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath">;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** The run materializing the baseline: its root node, and when it was requested. */
    readonly nodeId: NodeId;
    readonly capturedAt: DateTime.Utc;
    /** Records a missing checkpoint without touching git, for side chats sharing a parent's worktree. */
    readonly forceMissing?: boolean;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
    readonly forceMissing?: boolean;
    readonly excludePaths?: ReadonlyArray<string>;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  /**
   * A tracked repository's checkpoint for a run, with the baseline before it unless that is
   * already recorded. None when the run left the repository as it found it, which costs one
   * status and writes nothing: a project can track dozens of repositories a turn never touches.
   */
  readonly captureRepository: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly capturedAt: DateTime.Utc;
    readonly baselineCapturedAt: DateTime.Utc;
    readonly baselineRecorded: boolean;
    readonly excludePaths?: ReadonlyArray<string>;
  }) => Effect.Effect<
    Option.Option<{
      readonly baseline: OrchestrationV2Checkpoint | null;
      readonly checkpoint: OrchestrationV2Checkpoint;
    }>,
    CheckpointServiceV2Error
  >;
  /**
   * Restores a thread's folders together. Every snapshot is checked before a folder changes and
   * each folder is snapshotted first, so a restore that fails puts back the ones already
   * restored: a rewind changes all of them or none.
   */
  readonly restore: (input: {
    readonly targets: ReadonlyArray<{
      readonly scope: Pick<OrchestrationV2CheckpointScope, "id" | "cwd">;
      readonly checkpoint: Pick<OrchestrationV2Checkpoint, "ordinalWithinScope" | "ref" | "status">;
    }>;
    /** Every folder of the thread with checkpoints of its own; a restore leaves the others' alone. */
    readonly scopes: ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "id" | "cwd">>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /**
   * Drops the snapshots the thread's tracked repositories took at these run ordinals. A rollback
   * reuses the ordinals, and a snapshot left behind would pass for a later turn's baseline. Most
   * have no checkpoint record, so they are found by ordinal. A failure is logged, not raised.
   */
  readonly discardRepositorySnapshots: (input: {
    readonly rootScope: OrchestrationV2CheckpointScope;
    readonly thread: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath">;
    readonly ordinals: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

const scopeRef = Effect.fnUntraced(function* (scopeId: CheckpointScopeId, name: string) {
  const crypto = yield* Digest.Digest;
  const digest = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(scopeId))
    .pipe(Effect.orDie);
  const scopeKey = Hex.encode(digest).slice(0, 32);
  return CheckpointRef.make(`${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/${name}`);
});

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) =>
    scopeRef(input.scopeId, `ordinal/${input.ordinalWithinScope}`),
);

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

const makeRootRunScope = Effect.fn("CheckpointService.makeRootRunScope")(function* (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly createdAt: DateTime.Utc;
}) {
  const scopeId = yield* input.idAllocator.allocate.checkpointScope({
    threadId: input.threadId,
    name: ROOT_CHECKPOINT_SCOPE_NAME,
  });
  return {
    id: scopeId,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.rootNodeId,
    parentScopeId: null,
    providerThreadId: input.providerThreadId,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: input.cwd,
    createdAt: input.createdAt,
  } satisfies OrchestrationV2CheckpointScope;
});

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly ref: CheckpointRef;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly capturedAt: DateTime.Utc;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: input.ref,
    status: input.status,
    files: input.files,
    capturedAt: input.capturedAt,
  };
}

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  | CheckpointStore.CheckpointStore
  | Digest.Digest
  | IdAllocator.IdAllocatorV2
  | WorkspaceFolders.WorkspaceFolders
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const workspaceFolders = yield* WorkspaceFolders.WorkspaceFolders;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Digest.Digest;
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(Effect.provideService(Digest.Digest, crypto));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);

    // A failed probe is an operational error, not proof that the workspace has no repository.
    const probeRepository = (scope: OrchestrationV2CheckpointScope) =>
      checkpointStore.isGitRepository(scope.cwd).pipe(
        Effect.map((isRepository) =>
          isRepository ? ("repository" as const) : ("missing" as const),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("orchestration V2 checkpoint repository probe failed", {
            scopeId: scope.id,
            cause: String(cause),
          }).pipe(Effect.as("error" as const)),
        ),
      );

    // What this process knows of each repository scope's folder as of a run ordinal. With
    // `cleanHead` the folder matched that commit exactly, and no snapshot ref need exist until a
    // turn changes it; null means the ordinal's ref holds its state. Unknown after a restart.
    const repositoryStates = new Map<
      CheckpointScopeId,
      {
        readonly ordinal: number;
        readonly cleanHead: string | null;
        /** Epoch seconds. */
        readonly seenAt: number;
      }
    >();
    const noteRepositoryState = Effect.fnUntraced(function* (
      scopeId: CheckpointScopeId,
      state: { readonly ordinal: number; readonly cleanHead: string | null },
    ) {
      const seenAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      repositoryStates.set(scopeId, { ...state, seenAt });
    });

    const captureScopeBaseline = (input: {
      readonly scope: OrchestrationV2CheckpointScope;
      readonly ordinalWithinScope: number;
      readonly excludePaths: ReadonlyArray<string> | undefined;
    }) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (!(yield* checkpointStore.isGitRepository(input.scope.cwd))) {
            return;
          }

          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const exists = yield* checkpointStore.hasCheckpointRef({
            cwd: input.scope.cwd,
            checkpointRef,
          });
          if (exists) {
            return;
          }

          yield* checkpointStore
            .captureCheckpoint({
              cwd: input.scope.cwd,
              checkpointRef,
              ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
            })
            .pipe(
              Effect.timeout(BASELINE_CAPTURE_BUDGET),
              Effect.catchTags({
                VcsUnsupportedOperationError: () => Effect.void,
              }),
            );
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointBaselineCaptureError({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
              cause,
            }),
        ),
      );

    // A clean repository is only noted, which costs one status. One with uncommitted work is
    // snapshotted now, before the turn can change it.
    const noteRepositoryBaseline = (input: {
      readonly scope: OrchestrationV2CheckpointScope;
      readonly ordinalWithinScope: number;
      readonly excludePaths: ReadonlyArray<string> | undefined;
    }) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          const { cwd, id } = input.scope;
          // Usually the state its last run ended with, so most turns start without asking Git.
          if (repositoryStates.get(id)?.ordinal === input.ordinalWithinScope) return;
          const cleanHead = yield* checkpointStore.resolveCleanHead(cwd);
          if (cleanHead === null) {
            const checkpointRef = yield* checkpointRefFor({
              scopeId: id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            if (!(yield* checkpointStore.hasCheckpointRef({ cwd, checkpointRef }))) {
              yield* checkpointStore.captureCheckpoint({
                cwd,
                checkpointRef,
                ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
              });
            }
          }
          yield* noteRepositoryState(id, { ordinal: input.ordinalWithinScope, cleanHead });
        }),
      );

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            const checkpointRef = yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const repository =
              input.forceMissing === true ? "missing" : yield* probeRepository(input.scope);
            const status =
              repository === "repository"
                ? yield* checkpointStore
                    .hasCheckpointRef({
                      cwd: input.scope.cwd,
                      checkpointRef,
                    })
                    .pipe(
                      Effect.map((exists) => (exists ? ("ready" as const) : ("missing" as const))),
                      Effect.catch((cause) =>
                        Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                          scopeId: input.scope.id,
                          checkpointRef,
                          cause: String(cause),
                        }).pipe(Effect.as("error" as const)),
                      ),
                    )
                : repository;
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status,
              files: [],
              capturedAt: input.capturedAt,
            });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    const capture = (
      input: Parameters<CheckpointServiceV2Shape["capture"]>[0] & {
        /** The commit a clean folder matches, which then needs no staging to snapshot. */
        readonly cleanHead?: string;
      },
    ) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const parentCheckpointId =
            input.ordinalWithinScope > 0
              ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                  scopeId: input.scope.id,
                  ordinalWithinScope: input.ordinalWithinScope - 1,
                })
              : null;
          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const previousCheckpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: Math.max(0, input.ordinalWithinScope - 1),
          });

          const repository =
            input.forceMissing === true ? "missing" : yield* probeRepository(input.scope);
          if (repository !== "repository") {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: repository,
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const captureStatus = yield* (
            input.cleanHead === undefined
              ? checkpointStore.captureCheckpoint({
                  cwd: input.scope.cwd,
                  checkpointRef,
                  ...(input.ordinalWithinScope > 0 ? { previousCheckpointRef } : {}),
                  ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
                })
              : checkpointStore.captureHeadCheckpoint({
                  cwd: input.scope.cwd,
                  checkpointRef,
                  head: input.cleanHead,
                })
          ).pipe(
            Effect.as("ready" as const),
            Effect.catchTags({
              VcsUnsupportedOperationError: () => Effect.succeed("missing" as const),
            }),
            Effect.catch((cause) =>
              Effect.logWarning("orchestration V2 checkpoint capture failed", {
                scopeId: input.scope.id,
                checkpointRef,
                cause: String(cause),
              }).pipe(Effect.as("error" as const)),
            ),
          );

          if (captureStatus !== "ready") {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: captureStatus,
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const previousExists = yield* checkpointStore
            .hasCheckpointRef({
              cwd: input.scope.cwd,
              checkpointRef: previousCheckpointRef,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                  scopeId: input.scope.id,
                  checkpointRef: previousCheckpointRef,
                  cause: String(cause),
                }).pipe(Effect.as(false)),
              ),
            );
          const refs = {
            cwd: input.scope.cwd,
            fromCheckpointRef: previousCheckpointRef,
            toCheckpointRef: checkpointRef,
          };
          // A pull or rebase can change thousands of files the turn did not write.
          const files = previousExists
            ? yield* Effect.all([
                checkpointStore.diffCheckpoints({
                  ...refs,
                  fallbackFromToHead: false,
                  ignoreWhitespace: false,
                  format: "numstat",
                  // An earlier checkpoint can predate a nested folder getting its own scope.
                  ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
                }),
                checkpointStore.listAuthoredPaths(refs).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                      scopeId: input.scope.id,
                      checkpointRef,
                      cause: String(cause),
                    }).pipe(Effect.as(null)),
                  ),
                ),
              ]).pipe(
                Effect.map(([diff, authoredPaths]) =>
                  parseTurnDiffFilesFromNumstat(diff)
                    .filter((file) => !isGitImport(file, authoredPaths))
                    .map((file) => ({
                      path: file.path,
                      kind: "modified",
                      additions: file.additions,
                      deletions: file.deletions,
                    })),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
                    scopeId: input.scope.id,
                    checkpointRef,
                    cause: String(cause),
                  }).pipe(Effect.as([])),
                ),
              )
            : [];

          return makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: input.runId,
            nodeId: input.nodeId,
            parentCheckpointId,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: input.appRunOrdinal,
            ref: checkpointRef,
            status: "ready",
            files,
            capturedAt: input.capturedAt,
          });
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointCaptureError({
              scopeId: input.scope.id,
              cause,
            }),
        ),
      );

    const resolveNestedScopePaths: CheckpointServiceV2Shape["nestedScopePaths"] = (scopes) =>
      nestedScopePaths(scopes).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    const restore: CheckpointServiceV2Shape["restore"] = Effect.fn("CheckpointService.restore")(
      function* (input) {
        type Target = (typeof input.targets)[number];
        const failed = (target: Target, cause: unknown) =>
          isCheckpointRestoreError(cause)
            ? Effect.succeed(cause)
            : Effect.map(
                checkpointIdForScopeOrdinal(idAllocator, {
                  scopeId: target.scope.id,
                  ordinalWithinScope: target.checkpoint.ordinalWithinScope,
                }),
                (checkpointId) =>
                  new CheckpointRestoreError({ scopeId: target.scope.id, checkpointId, cause }),
              );
        for (const target of input.targets) {
          if (target.checkpoint.status !== "ready") {
            return yield* Effect.flip(
              failed(target, `Checkpoint status is ${target.checkpoint.status}.`),
            );
          }
          const exists = yield* checkpointStore
            .hasCheckpointRef({ cwd: target.scope.cwd, checkpointRef: target.checkpoint.ref })
            .pipe(Effect.catch((cause) => Effect.flip(failed(target, cause))));
          if (!exists) return yield* Effect.flip(failed(target, "Checkpoint ref is unavailable."));
        }
        const nested = yield* resolveNestedScopePaths(input.scopes);
        const snapshots: Array<Omit<CheckpointStore.RestoreCheckpointInput, "fallbackToHead">> = [];
        yield* Effect.forEach(
          input.targets,
          (target) =>
            withWorkspaceLock(
              target.scope.cwd,
              Effect.gen(function* () {
                const excludePaths = nested.get(target.scope.id);
                const folder = {
                  cwd: target.scope.cwd,
                  ...(excludePaths === undefined ? {} : { excludePaths }),
                };
                const preRewindRef = yield* scopeRef(target.scope.id, "pre-rewind").pipe(
                  Effect.provideService(Digest.Digest, crypto),
                );
                yield* checkpointStore.captureCheckpoint({
                  ...folder,
                  checkpointRef: preRewindRef,
                });
                snapshots.push({ ...folder, checkpointRef: preRewindRef });
                // What this process knew of the folder no longer holds.
                repositoryStates.delete(target.scope.id);
                const restored = yield* checkpointStore.restoreCheckpoint({
                  ...folder,
                  checkpointRef: target.checkpoint.ref,
                  fallbackToHead: false,
                });
                if (!restored) return yield* Effect.fail("Checkpoint ref is unavailable.");
              }),
            ).pipe(Effect.catch((cause) => Effect.flip(failed(target, cause)))),
          { discard: true },
        ).pipe(
          Effect.onError(() =>
            Effect.forEach(
              snapshots.toReversed(),
              (snapshot) =>
                withWorkspaceLock(snapshot.cwd, checkpointStore.restoreCheckpoint(snapshot)).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("A failed rewind left a folder partly restored", {
                      cwd: snapshot.cwd,
                      cause,
                    }),
                  ),
                ),
              { discard: true },
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() =>
              Effect.forEach(
                snapshots,
                (snapshot) =>
                  checkpointStore
                    .deleteCheckpointRefs({
                      cwd: snapshot.cwd,
                      checkpointRefs: [snapshot.checkpointRef],
                    })
                    .pipe(Effect.ignore),
                { discard: true },
              ),
            ),
          ),
        );
      },
    );

    const repositoryScopes: CheckpointServiceV2Shape["repositoryScopes"] = Effect.fn(
      "CheckpointService.repositoryScopes",
    )(
      function* (input) {
        const workspace = yield* workspaceFolders.forThread(input);
        return yield* Effect.forEach(
          workspace.folders.filter((folder) => folder.isGitRepository),
          (folder) =>
            idAllocator.allocate
              .checkpointScope({
                threadId: input.rootScope.threadId,
                name: `repository:${folder.repositoryPath ?? folder.path}`,
              })
              .pipe(
                Effect.map(
                  (id) =>
                    ({
                      id,
                      threadId: input.rootScope.threadId,
                      runId: input.rootScope.runId,
                      nodeId: input.rootScope.nodeId,
                      parentScopeId: input.rootScope.id,
                      providerThreadId: input.rootScope.providerThreadId,
                      kind: "manual",
                      ordinalWithinParent: 1,
                      advancesAppRunCount: false,
                      cwd: folder.path,
                      label: folder.name,
                      repositoryPath: folder.repositoryPath ?? folder.path,
                      createdAt: input.rootScope.createdAt,
                    }) satisfies OrchestrationV2CheckpointScope,
                ),
              ),
        );
      },
      (effect, input) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orchestration V2 repository checkpoint scopes unavailable", {
              threadId: input.rootScope.threadId,
              cause,
            }).pipe(Effect.as([])),
          ),
        ),
    );

    const captureRepositoryBaselines = Effect.fn("CheckpointService.captureRepositoryBaselines")(
      function* (input: {
        readonly scopes: ReadonlyArray<OrchestrationV2CheckpointScope>;
        readonly ordinalWithinScope: number;
        readonly nested: NestedScopePaths;
      }) {
        const captured = yield* Effect.forEach(
          input.scopes,
          (scope) =>
            noteRepositoryBaseline({
              scope,
              ordinalWithinScope: input.ordinalWithinScope,
              excludePaths: input.nested.get(scope.id),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 repository baseline capture failed", {
                  scopeId: scope.id,
                  cause,
                }),
              ),
            ),
          { concurrency: REPOSITORY_SCOPE_CONCURRENCY, discard: true },
        ).pipe(Effect.timeoutOption(BASELINE_CAPTURE_BUDGET));
        if (Option.isNone(captured)) {
          yield* Effect.logWarning(
            "orchestration V2 repository baselines ran out of time; the rest start without one",
            { scopeCount: input.scopes.length },
          );
        }
      },
    );

    const captureRepository: CheckpointServiceV2Shape["captureRepository"] = Effect.fn(
      "CheckpointService.captureRepository",
    )(function* (input) {
      const { cwd, id } = input.scope;
      const baselineOrdinal = input.ordinalWithinScope - 1;
      const start = yield* withWorkspaceLock(
        cwd,
        Effect.gen(function* () {
          const cleanHead = yield* checkpointStore
            .resolveCleanHead(cwd)
            .pipe(Effect.orElseSucceed(() => null));
          const stored = repositoryStates.get(id);
          const known = stored?.ordinal === baselineOrdinal ? stored : undefined;
          const cleanAtStart = known?.cleanHead ?? null;
          const unchanged = { changed: false as const, cleanHead };
          if (cleanHead !== null && cleanAtStart === cleanHead) return unchanged;
          const baselineRef = yield* checkpointRefFor({
            scopeId: id,
            ordinalWithinScope: baselineOrdinal,
          });
          const baselineExists = yield* checkpointStore
            .hasCheckpointRef({ cwd, checkpointRef: baselineRef })
            .pipe(Effect.orElseSucceed(() => false));
          if (!baselineExists) {
            // The turn started on a clean folder; its snapshot was left until one was needed.
            if (known !== undefined && cleanAtStart !== null) {
              yield* checkpointStore
                .captureHeadCheckpoint({
                  cwd,
                  checkpointRef: baselineRef,
                  head: cleanAtStart,
                  seenAt: known.seenAt,
                })
                .pipe(Effect.ignore);
            } else if (cleanHead !== null) {
              // How the turn started is unknown and nothing is uncommitted: nothing to show.
              return unchanged;
            }
          }
          return { changed: true as const, cleanHead };
        }),
      );
      const settled = { ordinal: input.ordinalWithinScope, cleanHead: start.cleanHead };
      if (!start.changed) {
        yield* noteRepositoryState(id, settled);
        return Option.none();
      }
      const baseline = input.baselineRecorded
        ? null
        : yield* materializeBaselineCheckpoint({
            scope: input.scope,
            ordinalWithinScope: baselineOrdinal,
            nodeId: input.nodeId,
            capturedAt: input.baselineCapturedAt,
          });
      const checkpoint = yield* capture({
        scope: input.scope,
        runId: input.runId,
        nodeId: input.nodeId,
        ordinalWithinScope: input.ordinalWithinScope,
        appRunOrdinal: null,
        capturedAt: input.capturedAt,
        ...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths }),
        ...(start.cleanHead === null ? {} : { cleanHead: start.cleanHead }),
      });
      if (checkpoint.status !== "ready") {
        repositoryStates.delete(id);
        return Option.some({ baseline, checkpoint });
      }
      yield* noteRepositoryState(id, settled);
      // A pull or a commit of what was already there moves the snapshot and lists no file.
      return checkpoint.files.length === 0 && (baseline === null || baseline.status === "ready")
        ? Option.none()
        : Option.some({ baseline, checkpoint });
    });

    const discardRepositorySnapshots: CheckpointServiceV2Shape["discardRepositorySnapshots"] =
      Effect.fn("CheckpointService.discardRepositorySnapshots")(function* (input) {
        if (input.ordinals.length === 0) return;
        const repositories = yield* repositoryScopes({
          rootScope: input.rootScope,
          ...input.thread,
        });
        yield* Effect.forEach(
          repositories,
          (scope) =>
            withWorkspaceLock(
              scope.cwd,
              Effect.gen(function* () {
                repositoryStates.delete(scope.id);
                yield* checkpointStore.deleteCheckpointRefs({
                  cwd: scope.cwd,
                  checkpointRefs: yield* Effect.forEach(input.ordinals, (ordinalWithinScope) =>
                    checkpointRefFor({ scopeId: scope.id, ordinalWithinScope }),
                  ),
                });
              }),
            ).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 stale repository snapshots kept", {
                  scopeId: scope.id,
                  cause: String(cause),
                }),
              ),
            ),
          { concurrency: REPOSITORY_SCOPE_CONCURRENCY, discard: true },
        );
      });

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = Effect.fn(
      "CheckpointService.captureBaseline",
    )(function* (input) {
      const repositories =
        input.thread === undefined
          ? []
          : yield* repositoryScopes({ rootScope: input.scope, ...input.thread });
      if (repositories.length === 0) {
        return yield* captureScopeBaseline({ ...input, excludePaths: undefined });
      }
      const nested = yield* resolveNestedScopePaths([input.scope, ...repositories]);
      // Side by side, so the repositories add no wait of their own; the thread folder's failure
      // is still the caller's to report once they have had their turn.
      const [root] = yield* Effect.all(
        [
          Effect.exit(captureScopeBaseline({ ...input, excludePaths: nested.get(input.scope.id) })),
          captureRepositoryBaselines({
            scopes: repositories,
            ordinalWithinScope: input.ordinalWithinScope,
            nested,
          }),
        ],
        { concurrency: 2 },
      );
      if (Exit.isFailure(root)) return yield* Effect.failCause(root.cause);
    });

    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        checkpointStore.deleteCheckpointRefs({
          cwd: input.scope.cwd,
          checkpointRefs: input.checkpoints.map((checkpoint) => checkpoint.ref),
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointDeleteStaleRefsError({
              scopeId: input.scope.id,
              checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
              cause,
            }),
        ),
      );

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      repositoryScopes,
      nestedScopePaths: resolveNestedScopePaths,
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      captureRepository,
      restore,
      deleteStaleRefs,
      discardRepositorySnapshots,
    } satisfies CheckpointServiceV2Shape);
  }),
);
