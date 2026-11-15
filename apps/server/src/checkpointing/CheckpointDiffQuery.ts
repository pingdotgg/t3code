import {
  CHECKPOINT_DIFF_TRUNCATED_MARKER,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CHECKPOINT_DIFF_MAX_OUTPUT_BYTES } from "../vcs/VcsDriver.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
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

/** One turn's diff, or the whole thread up to the latest ready turn when `turn` is omitted. */
export interface ThreadDiffInput {
  readonly threadId: ThreadId;
  readonly turn?: number | undefined;
  readonly ignoreWhitespace?: boolean | undefined;
}

export interface ThreadDiffResult {
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly latestTurnCount: number;
  readonly diff: string;
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

    readonly getThreadDiff: (
      input: ThreadDiffInput,
    ) => Effect.Effect<ThreadDiffResult, CheckpointServiceError>;
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

  // Shared by every diff entry point, so the ready-checkpoint rule lives in one place.
  const loadReadyTurns = Effect.fn("CheckpointDiffQuery.loadReadyTurns")(function* (
    threadId: ThreadId,
  ) {
    const projection = yield* threads.getCheckpointContext(threadId).pipe(
      Effect.mapError(
        () =>
          new CheckpointThreadNotFoundError({
            // getThreadDiff reuses getTurnDiff's operation name so both report one not-found error.
            operation: "CheckpointDiffQuery.getTurnDiff",
            threadId,
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
    return { projection, readyCheckpoints, maxTurnCount } as const;
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

      const { projection, readyCheckpoints, maxTurnCount } = yield* loadReadyTurns(input.threadId);
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

      const comparison = {
        cwd: toScope.cwd,
        fromCheckpointRef,
        toCheckpointRef: toCheckpoint.ref,
        fallbackFromToHead: false,
        ignoreWhitespace,
      };
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
                CHECKPOINT_DIFF_MAX_OUTPUT_BYTES -
                  Buffer.byteLength(CHECKPOINT_DIFF_TRUNCATED_MARKER),
              ),
              { stream: true },
            ) + CHECKPOINT_DIFF_TRUNCATED_MARKER;
          break;
        }
        remainingBytes -= patchBytes;
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

  const getThreadDiff: CheckpointDiffQuery["Service"]["getThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getThreadDiff",
  )(function* (input) {
    const { maxTurnCount } = yield* loadReadyTurns(input.threadId);
    const ignoreWhitespace =
      input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace };
    const diff =
      input.turn === undefined
        ? yield* getFullThreadDiff({
            threadId: input.threadId,
            toTurnCount: maxTurnCount,
            ...ignoreWhitespace,
          })
        : yield* getTurnDiff({
            threadId: input.threadId,
            fromTurnCount: input.turn - 1,
            toTurnCount: input.turn,
            ...ignoreWhitespace,
          });
    return {
      fromTurnCount: diff.fromTurnCount,
      toTurnCount: diff.toTurnCount,
      latestTurnCount: maxTurnCount,
      diff: diff.diff,
    };
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
    getThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
