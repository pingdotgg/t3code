/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  type CheckpointRef,
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
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "./Errors.ts";
import type { CheckpointServiceError } from "./Errors.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import { filterUnifiedDiffFiles } from "./Diffs.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

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

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  // Drop file sections attributed to pre-existing git history from a patch
  // unless the caller opted in. Attribution failures degrade to the
  // unfiltered patch — never block the diff on attribution.
  const applyAttributionFilter = Effect.fn("applyAttributionFilter")(function* (input: {
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
    readonly diff: string;
    readonly includeGitChanges: boolean;
  }) {
    if (input.includeGitChanges || input.diff.trim().length === 0) {
      return input.diff;
    }
    const attribution = yield* checkpointStore
      .attributeCheckpointDiff({
        cwd: input.cwd,
        fromCheckpointRef: input.fromCheckpointRef,
        toCheckpointRef: input.toCheckpointRef,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (attribution === null) {
      return input.diff;
    }
    return filterUnifiedDiffFiles(input.diff, (path) => attribution.get(path) !== "git");
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
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan("checkpoint.turnDiff.lookupContext"));
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointThreadNotFoundError({
          operation,
          threadId: input.threadId,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
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

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const toCheckpointRef = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const rawDiff = yield* checkpointStore
        .diffCheckpoints({
          cwd: workspaceCwd,
          fromCheckpointRef,
          toCheckpointRef,
          fallbackFromToHead: false,
          ignoreWhitespace,
        })
        .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));
      const diff = yield* applyAttributionFilter({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        diff: rawDiff,
        includeGitChanges: input.includeGitChanges ?? false,
      });

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

    const threadContext = yield* projectionSnapshotQuery
      .getFullThreadDiffContext(input.threadId, input.toTurnCount)
      .pipe(Effect.withSpan("checkpoint.fullThread.lookupContext"));

    if (Option.isNone(threadContext)) {
      return yield* new CheckpointThreadNotFoundError({
        operation,
        threadId: input.threadId,
      });
    }

    if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: threadContext.value.latestCheckpointTurnCount,
      });
    }

    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
    }

    if (!threadContext.value.toCheckpointRef) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, 0);
    const toCheckpointRef = threadContext.value.toCheckpointRef as CheckpointRef;
    const rawDiff = yield* checkpointStore
      .diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      })
      .pipe(Effect.withSpan("checkpoint.fullThread.diffCheckpoints"));
    const diff = yield* applyAttributionFilter({
      cwd: workspaceCwd,
      fromCheckpointRef,
      toCheckpointRef,
      diff: rawDiff,
      includeGitChanges: input.includeGitChanges ?? false,
    });

    const turnDiff = buildTurnDiffResult(
      {
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
      },
      diff,
    );
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
