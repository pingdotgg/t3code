import {
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type OrchestrationV2CheckpointRepository,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import {
  checkpointRefForScopeOrdinal,
  checkpointWorkspaceStatus,
  resolveRepositorySnapshot,
} from "../orchestration-v2/CheckpointService.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;
const DIFF_TRUNCATED_MARKER = "\n\n[truncated]";

function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

/**
 * Each repository worktree's last ready snapshot in the turns being compared,
 * so a worktree the thread detached partway still shows its changes.
 */
function latestRepositoryEntries(
  projection: ProjectionCheckpointContext,
  to: ProjectionCheckpointContext["checkpoints"][number],
  fromOrdinal: number,
) {
  const latest = new Map<
    string,
    { readonly entry: OrchestrationV2CheckpointRepository; readonly ordinal: number }
  >();
  for (const checkpoint of projection.checkpoints) {
    if (
      checkpoint.scopeId !== to.scopeId ||
      checkpoint.status === "stale" ||
      checkpoint.ordinalWithinScope <= fromOrdinal ||
      checkpoint.ordinalWithinScope > to.ordinalWithinScope
    ) {
      continue;
    }
    for (const entry of checkpoint.repositories ?? []) {
      const current = latest.get(entry.worktreePath);
      if (
        entry.status === "ready" &&
        (current === undefined || current.ordinal < checkpoint.ordinalWithinScope)
      ) {
        latest.set(entry.worktreePath, { entry, ordinal: checkpoint.ordinalWithinScope });
      }
    }
  }
  return [...latest.values()];
}

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const digest = yield* Digest.Digest;
  const fileSystem = yield* FileSystem.FileSystem;

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
        Effect.mapError(
          () =>
            new CheckpointThreadNotFoundError({
              operation,
              threadId: input.threadId,
            }),
        ),
        Effect.withSpan("checkpoint.turnDiff.lookupContext"),
      );
      const completedRunIds = new Set(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const readyCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          checkpoint.status === "ready" &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          completedRunIds.has(checkpoint.runId),
      );
      const maxTurnCount = readyCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const toCheckpoint = readyCheckpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount,
      );
      if (toCheckpoint === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const toScope = projection.checkpointScopes.find(
        (scope) => scope.id === toCheckpoint.scopeId,
      );
      if (toScope === undefined) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      // Capture compares against the preceding scope ordinal, even when that
      // checkpoint belongs to a stopped run or has no run.
      const parentCheckpoint =
        input.fromTurnCount === input.toTurnCount - 1
          ? projection.checkpoints.find(
              (checkpoint) =>
                checkpoint.status === "ready" &&
                checkpoint.scopeId === toCheckpoint.scopeId &&
                checkpoint.ordinalWithinScope === toCheckpoint.ordinalWithinScope - 1,
            )
          : undefined;

      const firstScope =
        input.fromTurnCount === 0
          ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")
          : undefined;
      const fromCheckpoint =
        input.fromTurnCount === 0
          ? undefined
          : (parentCheckpoint ??
            readyCheckpoints.find(
              (checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount,
            ));
      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? firstScope === undefined
            ? undefined
            : yield* checkpointRefForScopeOrdinal({
                scopeId: firstScope.id,
                ordinalWithinScope: 0,
              }).pipe(Effect.provideService(Digest.Digest, digest))
          : fromCheckpoint?.ref;
      const repositoryEntries = latestRepositoryEntries(
        projection,
        toCheckpoint,
        input.fromTurnCount,
      );
      const hasRepositories =
        toCheckpoint.repositories !== undefined || repositoryEntries.length > 0;
      if (fromCheckpointRef === undefined && !hasRepositories) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      // Each part stops once it passes `budgetBytes`; the caller trims the total.
      const diffPart = Effect.fnUntraced(function* (
        comparison: {
          readonly cwd: string;
          readonly fromCheckpointRef: CheckpointRef;
          readonly toCheckpointRef: CheckpointRef;
          readonly fallbackFromToHead: boolean;
          readonly ignoreWhitespace: boolean;
          readonly pathPrefix?: string;
        },
        budgetBytes: number,
      ) {
        const authoredPaths = yield* checkpointStore
          .listAuthoredPaths(comparison)
          .pipe(Effect.orElseSucceed(() => null));
        const files =
          authoredPaths === null
            ? []
            : yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
                Effect.map(parseTurnDiffFilesFromNumstat),
                Effect.orElseSucceed(() => []),
              );
        const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
        // Select retained paths before generating a patch, so imported bulk cannot exhaust its output limit.
        const pathBatches =
          retainedFiles.length === files.length ? [undefined] : batchFilePaths(retainedFiles);
        let part = "";
        for (const filePaths of pathBatches) {
          part += yield* checkpointStore
            .diffCheckpoints({
              ...comparison,
              ...(filePaths === undefined ? {} : { filePaths }),
              // One extra byte distinguishes an exact fit from a truncated patch.
              maxOutputBytes: budgetBytes - Buffer.byteLength(part) + 1,
            })
            .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
          if (Buffer.byteLength(part) > budgetBytes) break;
        }
        return part;
      });

      const workspaceComparison =
        fromCheckpointRef === undefined ||
        (hasRepositories &&
          (checkpointWorkspaceStatus(toCheckpoint) !== "ready" ||
            (fromCheckpoint !== undefined &&
              checkpointWorkspaceStatus(fromCheckpoint) !== "ready")))
          ? null
          : {
              cwd: toScope.cwd,
              fromCheckpointRef,
              toCheckpointRef: toCheckpoint.ref,
              fallbackFromToHead: false,
              ignoreWhitespace,
            };
      let diff = "";
      const remainingBytes = () => CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(diff);
      if (workspaceComparison !== null) {
        diff += hasRepositories
          ? // Repositories still show when the workspace's thread-start ref is gone.
            yield* diffPart(workspaceComparison, remainingBytes()).pipe(
              Effect.orElseSucceed(() => ""),
            )
          : yield* diffPart(workspaceComparison, remainingBytes());
      }
      for (const { entry, ordinal } of repositoryEntries) {
        if (remainingBytes() < 0) break;
        const cwd = (yield* fileSystem
          .exists(entry.worktreePath)
          .pipe(Effect.orElseSucceed(() => false)))
          ? entry.worktreePath
          : entry.repositoryPath;
        const from = yield* resolveRepositorySnapshot({
          history: {
            scopeId: toCheckpoint.scopeId,
            checkpoints: projection.checkpoints,
            runs: projection.runs,
          },
          worktreePath: entry.worktreePath,
          cwd,
          targetOrdinal: input.fromTurnCount,
          beforeOrdinal: ordinal,
        }).pipe(
          Effect.provideService(Digest.Digest, digest),
          Effect.provideService(CheckpointStore.CheckpointStore, checkpointStore),
        );
        if (from._tag !== "found") continue;
        diff += yield* diffPart(
          {
            cwd,
            fromCheckpointRef: from.ref,
            toCheckpointRef: entry.ref,
            fallbackFromToHead: false,
            ignoreWhitespace,
            pathPrefix: entry.pathPrefix,
          },
          remainingBytes(),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("repository worktree diff failed", {
              threadId: input.threadId,
              cause: String(cause),
            }).pipe(Effect.as("")),
          ),
        );
      }
      if (remainingBytes() < 0) {
        // Reserve marker space only on overflow, which may trim an earlier part.
        // Streaming decode drops an incomplete final UTF-8 character at the byte boundary.
        diff =
          new TextDecoder().decode(
            Buffer.from(diff).subarray(
              0,
              CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(DIFF_TRUNCATED_MARKER),
            ),
            { stream: true },
          ) + DIFF_TRUNCATED_MARKER;
      }

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
