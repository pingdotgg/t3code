/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
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
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

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

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? (() => {
              // The root scope is shared by every run in this thread. Its
              // runId tracks the latest owner, while ordinal zero stays the baseline.
              const firstScope = projection.checkpointScopes.find(
                (scope) => scope.kind === "root_run",
              );
              return firstScope === undefined
                ? undefined
                : checkpointRefForScopeOrdinal({
                    scopeId: firstScope.id,
                    ordinalWithinScope: 0,
                  });
            })()
          : readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount)
              ?.ref;
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
      // Capture attributes only the previous checkpoint in this scope, not arbitrary turn ranges.
      const fromScopeId =
        input.fromTurnCount === 0
          ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")?.id
          : readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount)
              ?.scopeId;
      const summary =
        input.includeGitChanges !== undefined &&
        input.toTurnCount === input.fromTurnCount + 1 &&
        fromScopeId === toScope.id
          ? yield* threads
              .getThreadRecords(input.threadId, ["checkpoints"], {
                checkpointRefs: [toCheckpoint.ref],
              })
              .pipe(
                Effect.map(({ checkpoints }) =>
                  checkpoints.find(
                    (checkpoint) =>
                      checkpoint.status === "ready" &&
                      checkpoint.scopeId === toScope.id &&
                      checkpoint.appRunOrdinal === input.toTurnCount &&
                      checkpoint.ref === toCheckpoint.ref &&
                      checkpoint.ordinalWithinScope > 0 &&
                      checkpointRefForScopeOrdinal({
                        scopeId: checkpoint.scopeId,
                        ordinalWithinScope: checkpoint.ordinalWithinScope - 1,
                      }) === fromCheckpointRef &&
                      checkpointRefForScopeOrdinal({
                        scopeId: checkpoint.scopeId,
                        ordinalWithinScope: checkpoint.ordinalWithinScope,
                      }) === toCheckpoint.ref,
                  ),
                ),
                Effect.orElseSucceed(() => undefined),
              )
          : undefined;
      const storedGitPaths = summary?.files
        .filter((file) => file.origin === "git")
        .map((file) => file.path);
      const gitPaths =
        input.includeGitChanges === undefined
          ? []
          : storedGitPaths && storedGitPaths.length > 0
            ? storedGitPaths
            : yield* checkpointStore
                .getGitChangedPaths(comparison)
                .pipe(Effect.catch(() => Effect.succeed([])));
      const files =
        gitPaths.length === 0
          ? []
          : parseTurnDiffFilesFromNumstat(
              yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }),
            );
      const imported = new Set(gitPaths);
      const gitFileCount = files.filter((file) => imported.has(file.path)).length;
      const filePaths =
        input.includeGitChanges === false && gitPaths.length > 0
          ? files
              .filter((file) => !imported.has(file.path))
              .flatMap((file) =>
                file.previousPath === undefined ? [file.path] : [file.previousPath, file.path],
              )
          : undefined;
      // Select retained paths before generating a patch, so imported bulk cannot exhaust its output limit.
      const diff = yield* checkpointStore
        .diffCheckpoints({
          ...comparison,
          ...(filePaths ? { filePaths } : {}),
        })
        .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));

      // Older clients keep the complete diff. Updated clients explicitly choose the grouped view.
      const turnDiff = {
        ...buildTurnDiffResult(input, diff),
        ...(gitFileCount > 0 ? { gitFileCount } : {}),
      };
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
      ...(input.includeGitChanges === undefined
        ? {}
        : { includeGitChanges: input.includeGitChanges }),
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
