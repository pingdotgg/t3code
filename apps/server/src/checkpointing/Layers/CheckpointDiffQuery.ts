import {
  OrchestrationGetTurnDiffResult,
  type CheckpointRef,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import { checkpointRefForThreadTurn, resolveThreadWorkspaceCwd } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildCheckpointIndex(input: {
  readonly operation: string;
  readonly threadId: string;
  readonly checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
    readonly checkpointRef: CheckpointRef;
  }>;
}): Effect.Effect<
  {
    readonly checkpointByTurnCount: Map<number, (typeof input.checkpoints)[number]>;
    readonly maxTurnCount: number;
  },
  CheckpointInvariantError
> {
  const checkpointByTurnCount = new Map<number, (typeof input.checkpoints)[number]>();

  for (const checkpoint of input.checkpoints) {
    if (checkpointByTurnCount.has(checkpoint.checkpointTurnCount)) {
      return Effect.fail(
        new CheckpointInvariantError({
          operation: input.operation,
          detail: `Checkpoint turn-count sequence is inconsistent for thread '${input.threadId}': duplicate checkpoint row for turn ${checkpoint.checkpointTurnCount}.`,
        }),
      );
    }
    checkpointByTurnCount.set(checkpoint.checkpointTurnCount, checkpoint);
  }

  const maxTurnCount = input.checkpoints.reduce(
    (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
    0,
  );

  return Effect.succeed({
    checkpointByTurnCount,
    maxTurnCount,
  });
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointDiffQuery.getTurnDiff";

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
      if (!thread) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const { checkpointByTurnCount, maxTurnCount } = yield* buildCheckpointIndex({
        operation,
        threadId: input.threadId,
        checkpoints: thread.checkpoints,
      });

      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: snapshot.projects,
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : checkpointByTurnCount.get(input.fromTurnCount)?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Checkpoint turn-count sequence is inconsistent for thread '${input.threadId}': missing checkpoint row for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpointRef = checkpointByTurnCount.get(input.toTurnCount)?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Checkpoint turn-count sequence is inconsistent for thread '${input.threadId}': missing checkpoint row for turn ${input.toTurnCount}.`,
        });
      }

      const [fromExists, toExists] = yield* Effect.all(
        [
          checkpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: fromCheckpointRef,
          }),
          checkpointStore.hasCheckpointRef({
            cwd: workspaceCwd,
            checkpointRef: toCheckpointRef,
          }),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromExists) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      if (!toExists) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const diff = yield* checkpointStore.diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
      });

      const turnDiff: OrchestrationGetTurnDiffResultType = {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    });

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
    }).pipe(Effect.map((result): OrchestrationGetFullThreadDiffResult => result));

  return {
    getTurnDiff,
    getFullThreadDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
