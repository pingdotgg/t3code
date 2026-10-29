import {
  CheckpointRef,
  PipelineError,
  type PipelineRunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import type { StartCheckpoint } from "./PipelineStore.ts";

const isPipelineError = Schema.is(PipelineError);

const IDLE_POLL_INTERVAL = Duration.millis(250);
const IDLE_POLLS_MAX = 60;

/** Names the safety copy of the failed attempt's files; the run id is encoded to be a valid ref segment. */
export const beforeRestoreRef = (runId: PipelineRunId, stepIndex: number, attempt: number) =>
  CheckpointRef.make(
    `refs/t3/pipeline-runs/${Base64Url.encode(runId)}/${stepIndex}/before-restore-${attempt}`,
  );

/** Reads and restores the git snapshots a pipeline step starts from. */
export const makePipelineWorkspace = Effect.fn("PipelineWorkspace.make")(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const crypto = yield* Crypto.Crypto;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  /**
   * The state a thread's first run found its workspace in: the root scope's ordinal-0 checkpoint.
   * The ref is captured before the provider starts, but the checkpoint record only follows a
   * completed or stopped run, so a failed run is found by recomputing the ref and asking git.
   * Null when the thread never started a run, is not in a managed worktree, or has no snapshot.
   */
  const findThreadStartCheckpoint = Effect.fn("PipelineWorkspace.findThreadStartCheckpoint")(
    function* (threadId: ThreadId) {
      const context = yield* threads.getCheckpointContext(threadId);
      // Each run has its own root scope; later ones already hold this step's own changes.
      const firstRun = context.runs[0];
      if (firstRun === undefined) return null;
      const scope = context.checkpointScopes.find(
        (candidate) => candidate.kind === "root_run" && candidate.runId === firstRun.id,
      );
      if (scope === undefined || !(yield* isManagedWorktreePath(scope.cwd))) return null;
      const recorded = context.checkpoints.find(
        (checkpoint) =>
          checkpoint.scopeId === scope.id &&
          checkpoint.ordinalWithinScope === 0 &&
          checkpoint.status === "ready",
      );
      const ref =
        recorded?.ref ??
        (yield* checkpointRefForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope: 0 }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        ));
      const exists = yield* checkpoints.hasCheckpointRef({ cwd: scope.cwd, checkpointRef: ref });
      return exists ? ({ cwd: scope.cwd, ref } satisfies StartCheckpoint) : null;
    },
  );

  /** False when the thread still has a run after the bounded wait; stopping it is asynchronous. */
  const waitUntilThreadIdle = Effect.fn("PipelineWorkspace.waitUntilThreadIdle")(function* (
    threadId: ThreadId,
  ) {
    const idle = threads.getThreadShell(threadId).pipe(
      Effect.map((shell) => shell === null || shell.activeRunId === null),
      // An unreadable thread cannot be shown to be idle.
      Effect.orElseSucceed(() => false),
    );
    for (let poll = 0; poll < IDLE_POLLS_MAX; poll += 1) {
      if (yield* idle) return true;
      yield* Effect.sleep(IDLE_POLL_INTERVAL);
    }
    return yield* idle;
  });

  /**
   * Puts the workspace's files and index back to `start`, keeping a copy of what was there first.
   * Commits stay on the branch.
   */
  const restoreStartCheckpoint = Effect.fn("PipelineWorkspace.restoreStartCheckpoint")(
    function* (input: {
      readonly runId: PipelineRunId;
      readonly stepIndex: number;
      readonly attempt: number;
      readonly start: StartCheckpoint;
    }): Effect.fn.Return<void, PipelineError> {
      const { runId, start } = input;
      const failure = (message: string, cause?: unknown) =>
        new PipelineError({ message, runId, ...(cause === undefined ? {} : { cause }) });
      // Never the project's own checkout: it can hold work that is not the pipeline's.
      if (!(yield* isManagedWorktreePath(start.cwd))) {
        return yield* failure(
          "This step did not run in a T3 Code worktree, so its files cannot be restored. Retry with the current files instead.",
        );
      }
      const backupRef = beforeRestoreRef(runId, input.stepIndex, input.attempt);
      yield* withWorkspaceLease(
        start.cwd,
        Effect.gen(function* () {
          if (
            !(yield* checkpoints.hasCheckpointRef({ cwd: start.cwd, checkpointRef: start.ref }))
          ) {
            return yield* failure(
              "The saved starting files for this step are gone. Retry with the current files instead.",
            );
          }
          yield* checkpoints.captureCheckpoint({ cwd: start.cwd, checkpointRef: backupRef });
          yield* Effect.logInfo("Saved pipeline step files before restoring its start", {
            runId,
            stepIndex: input.stepIndex,
            cwd: start.cwd,
            backupRef,
          });
          const restored = yield* checkpoints.restoreCheckpoint({
            cwd: start.cwd,
            checkpointRef: start.ref,
          });
          if (!restored) {
            return yield* failure(
              "The saved starting files for this step could not be found. Retry with the current files instead.",
            );
          }
        }),
      ).pipe(
        Effect.mapError((error) =>
          isPipelineError(error)
            ? error
            : failure(
                "Could not restore the step's starting files. Try again, or retry with the current files.",
                error,
              ),
        ),
      );
    },
  );

  return { findThreadStartCheckpoint, waitUntilThreadIdle, restoreStartCheckpoint };
});
