import {
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
  type ThreadTurnRepositoryDiff,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
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
const REPOSITORY_DIFF_CONCURRENCY = 4;

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

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
  repositories?: ReadonlyArray<ThreadTurnRepositoryDiff>,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
    ...(repositories === undefined ? {} : { repositories }),
  };
}

type ContextCheckpoint = ProjectionCheckpointContext["checkpoints"][number];

/**
 * A repo's checkpoints for a turn range: the latest completed run in the range, and its state at
 * the range start, which is its first baseline when the repo joined later. None when it is unchanged.
 */
function repositoryDiffRange(
  checkpoints: ReadonlyArray<ContextCheckpoint>,
  completedRunIds: ReadonlySet<string>,
  range: { readonly fromTurnCount: number; readonly toTurnCount: number },
): { readonly from: ContextCheckpoint; readonly to: ContextCheckpoint } | undefined {
  const ready = checkpoints
    .filter((checkpoint) => checkpoint.status === "ready")
    .toSorted((left, right) => left.ordinalWithinScope - right.ordinalWithinScope);
  const to = ready.findLast(
    (checkpoint) =>
      checkpoint.runId !== null &&
      completedRunIds.has(checkpoint.runId) &&
      checkpoint.ordinalWithinScope <= range.toTurnCount,
  );
  const from = ready.find((checkpoint) => checkpoint.ordinalWithinScope >= range.fromTurnCount);
  return to === undefined || from === undefined || from.ordinalWithinScope >= to.ordinalWithinScope
    ? undefined
    : { from, to };
}

/** @public */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const digest = yield* Digest.Digest;
  const path = yield* Path.Path;

  // Drops what a pull or rebase brought in before building the patch, within one output budget.
  const diffBetween = Effect.fn("CheckpointDiffQuery.diffBetween")(function* (comparison: {
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
    readonly fallbackFromToHead: false;
    readonly ignoreWhitespace: boolean;
  }) {
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
    let diff = "";
    let remainingBytes = CHECKPOINT_DIFF_MAX_OUTPUT_BYTES;
    for (const filePaths of pathBatches) {
      const patch = yield* checkpointStore
        .diffCheckpoints({
          ...comparison,
          ...(filePaths === undefined ? {} : { filePaths }),
          // One extra byte distinguishes an exact fit from a truncated patch.
          maxOutputBytes: remainingBytes + 1,
        })
        .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
      const patchBytes = Buffer.byteLength(patch);
      diff += patch;
      if (patchBytes > remainingBytes) {
        // Reserve marker space only on overflow, which may trim an earlier batch.
        // Streaming decode drops an incomplete final UTF-8 character at the byte boundary.
        diff =
          new TextDecoder().decode(
            Buffer.from(diff).subarray(
              0,
              CHECKPOINT_DIFF_MAX_OUTPUT_BYTES - Buffer.byteLength(DIFF_TRUNCATED_MARKER),
            ),
            { stream: true },
          ) + DIFF_TRUNCATED_MARKER;
        break;
      }
      remainingBytes -= patchBytes;
    }
    return diff;
  });

  // Each tracked repo gets its own patch and output budget; repos without changes are left out.
  const repositoryDiffs = Effect.fn("CheckpointDiffQuery.repositoryDiffs")(function* (input: {
    readonly projection: ProjectionCheckpointContext;
    readonly completedRunIds: ReadonlySet<string>;
    readonly threadCwd: string;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
    readonly ignoreWhitespace: boolean;
  }) {
    const diffs = yield* Effect.forEach(
      input.projection.checkpointScopes.filter((scope) => scope.kind === "repository"),
      (scope) => {
        const range = repositoryDiffRange(
          input.projection.checkpoints.filter((checkpoint) => checkpoint.scopeId === scope.id),
          input.completedRunIds,
          input,
        );
        if (range === undefined) return Effect.succeed([]);
        return diffBetween({
          cwd: scope.cwd,
          fromCheckpointRef: range.from.ref,
          toCheckpointRef: range.to.ref,
          fallbackFromToHead: false,
          ignoreWhitespace: input.ignoreWhitespace,
        }).pipe(
          Effect.map((diff): ReadonlyArray<ThreadTurnRepositoryDiff> =>
            diff === ""
              ? []
              : [
                  {
                    name: scope.label ?? path.basename(scope.cwd),
                    repositoryPath: scope.repositoryPath ?? scope.cwd,
                    relativePath: path
                      .relative(input.threadCwd, scope.cwd)
                      .split(path.sep)
                      .join("/"),
                    diff,
                  },
                ],
          ),
          Effect.catch((cause) =>
            Effect.logWarning("checkpoint repository diff unavailable", {
              scopeId: scope.id,
              cause: String(cause),
            }).pipe(Effect.as([])),
          ),
        );
      },
      { concurrency: REPOSITORY_DIFF_CONCURRENCY },
    );
    return diffs.flat();
  });

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
      const completedRunIds = new Set<string>(
        projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
      );
      const multiRepo = projection.checkpointScopes.some((scope) => scope.kind === "repository");
      // A plain home folder records "missing" checkpoints; its turns still exist for the repos.
      const turnCheckpoints = projection.checkpoints.filter(
        (checkpoint) =>
          (checkpoint.status === "ready" || (multiRepo && checkpoint.status === "missing")) &&
          checkpoint.appRunOrdinal !== null &&
          checkpoint.runId !== null &&
          completedRunIds.has(checkpoint.runId),
      );
      const readyCheckpoints = turnCheckpoints.filter(
        (checkpoint) => checkpoint.status === "ready",
      );
      const maxTurnCount = turnCheckpoints.reduce(
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

      const toCheckpoint = turnCheckpoints.find(
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

      const repositories = multiRepo
        ? yield* repositoryDiffs({
            projection,
            completedRunIds,
            threadCwd: toScope.cwd,
            fromTurnCount: input.fromTurnCount,
            toTurnCount: input.toTurnCount,
            ignoreWhitespace,
          })
        : undefined;
      if (toCheckpoint.status === "missing") {
        const turnDiff = buildTurnDiffResult(input, "", repositories);
        if (!isTurnDiffResult(turnDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return turnDiff;
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
      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? firstScope === undefined
            ? undefined
            : yield* checkpointRefForScopeOrdinal({
                scopeId: firstScope.id,
                ordinalWithinScope: 0,
              }).pipe(Effect.provideService(Digest.Digest, digest))
          : (
              parentCheckpoint ??
              readyCheckpoints.find(
                (checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount,
              )
            )?.ref;
      if (fromCheckpointRef === undefined) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const diff = yield* diffBetween({
        cwd: toScope.cwd,
        fromCheckpointRef,
        toCheckpointRef: toCheckpoint.ref,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });

      const turnDiff = buildTurnDiffResult(input, diff, repositories);
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
