import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";
const PRE_REWIND_CHECKPOINT_NAME = "pre-rewind";

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

export class CheckpointScopeEnsureError extends Schema.TaggedError<CheckpointScopeEnsureError>()(
  "CheckpointScopeEnsureError",
  {
    scopeId: CheckpointScopeId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ensure checkpoint scope ${this.scopeId}.`;
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
  CheckpointScopeEnsureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

/** A checkpoint a restore can target; pre-rewind snapshots have no record. */
export type RestorableCheckpoint = Pick<OrchestrationV2Checkpoint, "id" | "ref" | "status">;

/** The thread's repository scopes. A scope leaves the ones inside its folder to them. */
type RepositoryScopeFolders = ReadonlyArray<Pick<OrchestrationV2CheckpointScope, "cwd">>;

/** A tracked Git folder of the thread's workspace. */
interface ScopedRepository {
  readonly name: string;
  readonly cwd: string;
  readonly originalPath: string;
}

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  /** One scope per tracked repo of the run, under the root scope. Ids are stable per tracked path. */
  readonly prepareRepositoryScopes: (input: {
    readonly rootScope: OrchestrationV2CheckpointScope;
    readonly repositories: ReadonlyArray<ScopedRepository>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2CheckpointScope>, CheckpointServiceV2Error>;
  readonly ensureScope: (
    scope: OrchestrationV2CheckpointScope,
  ) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    readonly repositoryScopes?: RepositoryScopeFolders;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /** Null outside Git: a baseline there is always missing and would replace that turn's record. */
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** The run materializing the baseline: its root node, and when it was requested. */
    readonly nodeId: NodeId;
    readonly capturedAt: DateTime.Utc;
    /** Records a missing checkpoint without touching git, for side chats sharing a parent's worktree. */
    readonly forceMissing?: boolean;
  }) => Effect.Effect<OrchestrationV2Checkpoint | null, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
    readonly forceMissing?: boolean;
    readonly repositoryScopes?: RepositoryScopeFolders;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  /** False when the ref is gone or cannot be read. */
  readonly hasCheckpointRef: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: Pick<OrchestrationV2Checkpoint, "ref">;
  }) => Effect.Effect<boolean>;
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: RestorableCheckpoint;
    readonly repositoryScopes?: RepositoryScopeFolders;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /** Snapshots the workspace so a failed multi-repo rewind can put it back. One per scope. */
  readonly savePreRewind: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly repositoryScopes?: RepositoryScopeFolders;
  }) => Effect.Effect<RestorableCheckpoint, CheckpointServiceV2Error>;
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

const checkpointRefForScope = Effect.fn("checkpointRefForScope")(function* (input: {
  readonly scopeId: CheckpointScopeId;
  readonly name: string;
}) {
  const crypto = yield* Digest.Digest;
  const digest = yield* crypto
    .digest(Digest.sha256, new TextEncoder().encode(input.scopeId))
    .pipe(Effect.orDie);
  const scopeKey = Hex.encode(digest).slice(0, 32);
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}/${input.name}`,
  );
});

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    return yield* checkpointRefForScope({
      scopeId: input.scopeId,
      name: `ordinal/${input.ordinalWithinScope}`,
    });
  },
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

// Child repos have their own scopes; without exclusion the parent records them as gitlinks.
const excludedRepositoryPaths = (
  path: Path.Path,
  cwd: string,
  repositoryScopes: RepositoryScopeFolders | undefined,
) => {
  const excludePaths = (repositoryScopes ?? []).flatMap((repositoryScope) => {
    const relative = path.relative(cwd, repositoryScope.cwd);
    return relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
      ? []
      : [relative.split(path.sep).join("/")];
  });
  return excludePaths.length === 0 ? {} : { excludePaths };
};

const makeRepositoryScopes = Effect.fn("CheckpointService.makeRepositoryScopes")(function* (input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly rootScope: OrchestrationV2CheckpointScope;
  readonly repositories: ReadonlyArray<ScopedRepository>;
}) {
  return yield* Effect.forEach(input.repositories, (repository, index) =>
    input.idAllocator.allocate
      .checkpointScope({
        threadId: input.rootScope.threadId,
        name: `repository:${repository.originalPath}`,
      })
      .pipe(
        Effect.map(
          (id) =>
            ({
              id,
              threadId: input.rootScope.threadId,
              // The latest run that included the repo; capture selects repos by it.
              runId: input.rootScope.runId,
              nodeId: input.rootScope.nodeId,
              parentScopeId: input.rootScope.id,
              providerThreadId: input.rootScope.providerThreadId,
              kind: "repository",
              ordinalWithinParent: index + 1,
              advancesAppRunCount: false,
              cwd: repository.cwd,
              label: repository.name,
              repositoryPath: repository.originalPath,
              createdAt: input.rootScope.createdAt,
            }) satisfies OrchestrationV2CheckpointScope,
        ),
      ),
  );
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
  CheckpointStore.CheckpointStore | Digest.Digest | IdAllocator.IdAllocatorV2 | Path.Path
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const path = yield* Path.Path;
    const crypto = yield* Digest.Digest;
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(Effect.provideService(Digest.Digest, crypto));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    const ensureScope: CheckpointServiceV2Shape["ensureScope"] = (scope) => Effect.succeed(scope);

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (!(yield* isGitCheckpointable(input.scope.cwd))) {
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
              ...excludedRepositoryPaths(path, input.scope.cwd, input.repositoryScopes),
            })
            .pipe(
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
            const forceMissing = input.forceMissing === true;
            if (!forceMissing && !(yield* isGitCheckpointable(input.scope.cwd))) return null;
            const available = forceMissing
              ? false
              : yield* checkpointStore
                  .hasCheckpointRef({
                    cwd: input.scope.cwd,
                    checkpointRef,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                        scopeId: input.scope.id,
                        checkpointRef,
                        cause: String(cause),
                      }).pipe(Effect.as(false)),
                    ),
                  );
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status: available ? "ready" : "missing",
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

    const capture: CheckpointServiceV2Shape["capture"] = (input) =>
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

          if (input.forceMissing === true || !(yield* isGitCheckpointable(input.scope.cwd))) {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: "missing",
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          // A retried or raced capture keeps the snapshot already taken for this ordinal.
          const alreadyCaptured = yield* checkpointStore
            .hasCheckpointRef({ cwd: input.scope.cwd, checkpointRef })
            .pipe(Effect.orElseSucceed(() => false));
          const captureStatus = alreadyCaptured
            ? ("ready" as const)
            : yield* checkpointStore
                .captureCheckpoint({
                  cwd: input.scope.cwd,
                  checkpointRef,
                  ...excludedRepositoryPaths(path, input.scope.cwd, input.repositoryScopes),
                })
                .pipe(
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

    const restore: CheckpointServiceV2Shape["restore"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (input.checkpoint.status !== "ready") {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Checkpoint status is ${input.checkpoint.status}.`,
            });
          }

          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: input.checkpoint.ref,
            fallbackToHead: false,
            ...excludedRepositoryPaths(path, input.scope.cwd, input.repositoryScopes),
          });
          if (!restored) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: "Checkpoint ref is unavailable.",
            });
          }
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

    const hasCheckpointRef: CheckpointServiceV2Shape["hasCheckpointRef"] = (input) =>
      checkpointStore
        .hasCheckpointRef({ cwd: input.scope.cwd, checkpointRef: input.checkpoint.ref })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orchestration V2 checkpoint ref lookup failed", {
              scopeId: input.scope.id,
              checkpointRef: input.checkpoint.ref,
              cause: String(cause),
            }).pipe(Effect.as(false)),
          ),
        );

    const savePreRewind: CheckpointServiceV2Shape["savePreRewind"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          const ref = yield* checkpointRefForScope({
            scopeId: input.scope.id,
            name: PRE_REWIND_CHECKPOINT_NAME,
          }).pipe(Effect.provideService(Digest.Digest, crypto));
          yield* checkpointStore.captureCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: ref,
            ...excludedRepositoryPaths(path, input.scope.cwd, input.repositoryScopes),
          });
          const id = yield* idAllocator.allocate.checkpoint({
            checkpointScopeId: input.scope.id,
            name: PRE_REWIND_CHECKPOINT_NAME,
          });
          return { id, ref, status: "ready" as const };
        }),
      ).pipe(
        Effect.mapError((cause) => new CheckpointCaptureError({ scopeId: input.scope.id, cause })),
      );

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
      prepareRepositoryScopes: (input) =>
        makeRepositoryScopes({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) => new CheckpointScopeEnsureError({ scopeId: input.rootScope.id, cause }),
          ),
        ),
      ensureScope,
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      hasCheckpointRef,
      restore,
      savePreRewind,
      deleteStaleRefs,
    } satisfies CheckpointServiceV2Shape);
  }),
);
