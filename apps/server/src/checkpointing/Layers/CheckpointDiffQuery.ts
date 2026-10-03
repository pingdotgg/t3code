import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import { checkpointBaselineRefForThreadTurn, checkpointRefForThreadTurn } from "../Utils.ts";
import { MAX_TURN_SCOPED_PATHS } from "../TurnScopedFiles.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function addDiffPath(
  paths: Set<string>,
  file: { readonly path: string; readonly previousPath?: string | null },
) {
  paths.add(file.path);
  if (file.previousPath !== undefined && file.previousPath !== null) {
    paths.add(file.previousPath);
  }
}

function resolveCheckpointRange(input: {
  readonly threadId: OrchestrationGetFullThreadDiffInput["threadId"];
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly scope: "snapshot" | "turn";
  readonly threadContext: ProjectionThreadCheckpointContext;
}) {
  let maxTurnCount = 0;
  let fromCatalogCheckpointRef:
    | ProjectionThreadCheckpointContext["checkpoints"][number]["checkpointRef"]
    | undefined;
  let toCheckpointRef:
    | ProjectionThreadCheckpointContext["checkpoints"][number]["checkpointRef"]
    | undefined;
  const diffPaths = new Set<string>();
  let attributionComplete = true;
  // A checkpoint's turnFiles cannot be trusted as the complete set of changed paths when:
  // - touched-path attribution hit its cap (agentTouchedPaths is the capped set), or
  // - the cumulative summary shows changes that nothing attributes to the turn (changes made
  //   outside edit/write/delete/move tools), or
  // - both file summaries failed, leaving files and turnFiles empty.
  // Filtering a range by an untrustworthy set silently drops work, so drop the filter instead.
  // A superset is always preferable to missing changes.
  const trustTurnFiles = (
    checkpoint: ProjectionThreadCheckpointContext["checkpoints"][number],
  ): boolean => {
    if (checkpoint.agentTouchedPaths.length >= MAX_TURN_SCOPED_PATHS) {
      return false;
    }
    return !(checkpoint.files.length > 0 && checkpoint.turnFiles.length === 0);
  };

  for (const checkpoint of input.threadContext.checkpoints) {
    maxTurnCount = Math.max(maxTurnCount, checkpoint.checkpointTurnCount);
    if (
      checkpoint.checkpointTurnCount === input.fromTurnCount &&
      fromCatalogCheckpointRef === undefined
    ) {
      fromCatalogCheckpointRef = checkpoint.checkpointRef;
    }
    if (checkpoint.checkpointTurnCount === input.toTurnCount && toCheckpointRef === undefined) {
      toCheckpointRef = checkpoint.checkpointRef;
      if (input.scope === "turn") {
        if (!trustTurnFiles(checkpoint)) {
          attributionComplete = false;
        }
        for (const file of checkpoint.turnFiles) {
          addDiffPath(diffPaths, file);
        }
      }
    }
    if (
      input.scope === "snapshot" &&
      checkpoint.checkpointTurnCount > input.fromTurnCount &&
      checkpoint.checkpointTurnCount <= input.toTurnCount
    ) {
      if (!trustTurnFiles(checkpoint)) {
        attributionComplete = false;
      }
      for (const file of checkpoint.turnFiles) {
        addDiffPath(diffPaths, file);
      }
    }
  }

  // Safety net for the case no content check can catch: a range whose attribution
  // produced no paths at all. An unfiltered diff of an unchanged range is still
  // empty, so this can only widen the result, never narrow it.
  if (diffPaths.size === 0) {
    attributionComplete = false;
  }
  const preferredFromCheckpointRef =
    input.scope === "turn"
      ? checkpointBaselineRefForThreadTurn(input.threadId, input.toTurnCount)
      : input.fromTurnCount === 0
        ? checkpointBaselineRefForThreadTurn(input.threadId, 1)
        : fromCatalogCheckpointRef;
  const fallbackFromCheckpointRef =
    input.fromTurnCount === 0
      ? checkpointRefForThreadTurn(input.threadId, 0)
      : fromCatalogCheckpointRef;

  return {
    maxTurnCount,
    preferredFromCheckpointRef,
    fallbackFromCheckpointRef:
      fallbackFromCheckpointRef === preferredFromCheckpointRef
        ? undefined
        : fallbackFromCheckpointRef,
    toCheckpointRef,
    diffPaths: attributionComplete ? [...diffPaths] : undefined,
  };
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
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

      // Turn-scoped diffs path-filter the [from..to] range by the file list of
      // a single target checkpoint. That filtering only has well-defined
      // semantics for a single checkpoint transition. Wider ranges silently
      // drop changes outside the target turn's file list and look like a
      // valid (but wrong) turn diff. Snapshot scope is unaffected.
      if (input.scope === "turn" && input.toTurnCount !== input.fromTurnCount + 1) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Turn-scoped diff requires a single checkpoint transition (toTurnCount === fromTurnCount + 1); received fromTurnCount=${input.fromTurnCount}, toTurnCount=${input.toTurnCount}.`,
        });
      }

      const threadContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
        input.threadId,
      );
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const range = resolveCheckpointRange({
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        scope: input.scope,
        threadContext: threadContext.value,
      });
      if (input.toTurnCount > range.maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${range.maxTurnCount}.`,
        });
      }

      const workspaceCwd = yield* Effect.gen(function* () {
        const worktreePath = threadContext.value.worktreePath;
        if (worktreePath !== null && (yield* checkpointStore.isGitRepository(worktreePath))) {
          return worktreePath;
        }
        return threadContext.value.workspaceRoot;
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }

      if (!range.preferredFromCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      if (!range.toCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const diff = yield* checkpointStore
        .diffCheckpoints({
          cwd: workspaceCwd,
          fromCheckpointRef: range.preferredFromCheckpointRef,
          ...(range.fallbackFromCheckpointRef === undefined
            ? {}
            : { fallbackFromCheckpointRef: range.fallbackFromCheckpointRef }),
          toCheckpointRef: range.toCheckpointRef,
          fallbackFromToHead: false,
          ...(input.ignoreWhitespace === undefined
            ? {}
            : { ignoreWhitespace: input.ignoreWhitespace }),
          ...(range.diffPaths === undefined ? {} : { paths: range.diffPaths }),
          ...(threadContext.value.workspaceBinding == null
            ? {}
            : { workspaceBinding: threadContext.value.workspaceBinding }),
        })
        .pipe(
          Effect.catchTag("CheckpointRefUnavailableError", (error) => {
            const turnCount = error.endpoint === "from" ? input.fromTurnCount : input.toTurnCount;
            const missingCatalogFromRef =
              error.endpoint === "from" &&
              input.scope === "turn" &&
              range.fallbackFromCheckpointRef === undefined;
            return new CheckpointUnavailableError({
              threadId: input.threadId,
              turnCount,
              detail: missingCatalogFromRef
                ? `Checkpoint ref is unavailable for turn ${turnCount}.`
                : `Filesystem checkpoint is unavailable for turn ${turnCount}.`,
            });
          }),
        );

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
    },
  );

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      scope: "snapshot",
      ...(input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace }),
    }).pipe(Effect.map((result): OrchestrationGetFullThreadDiffResult => result));

  return {
    getTurnDiff,
    getFullThreadDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
