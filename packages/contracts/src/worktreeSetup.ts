import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Live progress for a thread whose first turn is creating a worktree. The
 * server keeps this in memory only; a client that reconnects mid-setup gets a
 * fresh snapshot, and a finished setup is dropped once its turn starts.
 */
/** Producers clamp free text to these before publishing so encoding never fails. */
export const WORKTREE_SETUP_DETAIL_MAX_LENGTH = 200;
export const WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH = 400;
export const WORKTREE_SETUP_ERROR_MAX_LENGTH = 1000;

export const WorktreeSetupStageId = Schema.Literals([
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
]);
export type WorktreeSetupStageId = typeof WorktreeSetupStageId.Type;

export const WorktreeSetupStageStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "skipped",
  "warning",
  "failed",
]);
export type WorktreeSetupStageStatus = typeof WorktreeSetupStageStatus.Type;

export const WorktreeSetupStage = Schema.Struct({
  id: WorktreeSetupStageId,
  status: WorktreeSetupStageStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  /** Only the checkout stage reports a real percentage, parsed from git's `Updating files` lines. */
  percent: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  /** Short trailing text for the row: a file count, an exit code, a submodule name. */
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(WORKTREE_SETUP_DETAIL_MAX_LENGTH))),
  /** Last few output lines from the setup script, ANSI stripped, newest last. */
  tail: Schema.Array(Schema.String.check(Schema.isMaxLength(WORKTREE_SETUP_TAIL_LINE_MAX_LENGTH))),
});
export type WorktreeSetupStage = typeof WorktreeSetupStage.Type;

export const WorktreeSetupPhase = Schema.Literals(["running", "done", "failed", "cancelled"]);
export type WorktreeSetupPhase = typeof WorktreeSetupPhase.Type;

export const WorktreeSetupSnapshot = Schema.Struct({
  threadId: ThreadId,
  phase: WorktreeSetupPhase,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /** Display name plus command of the setup script from t3.json, when one runs. */
  setupScript: Schema.NullOr(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      command: TrimmedNonEmptyString,
      terminalId: TrimmedNonEmptyString,
    }),
  ),
  stages: Schema.Array(WorktreeSetupStage),
  /** Human readable reason when phase is failed. */
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(WORKTREE_SETUP_ERROR_MAX_LENGTH))),
  sequence: NonNegativeInt,
});
export type WorktreeSetupSnapshot = typeof WorktreeSetupSnapshot.Type;

/**
 * Thread activity that carries a `WorktreeSetupSnapshot` as its payload. The
 * bootstrap writes it under a fixed id once the thread exists (phase running)
 * and again when the setup settles, so the projection always holds the
 * latest known state: a client attaches the live stream while it says
 * running and renders the outcome from it afterwards, on any device or
 * after a reload.
 */
export const WORKTREE_SETUP_ACTIVITY_KIND = "worktree-setup";

export const WorktreeSetupSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type WorktreeSetupSubscribeInput = typeof WorktreeSetupSubscribeInput.Type;

/** Null means no setup is tracked for that thread. Sent first, then after every change. */
export const WorktreeSetupStreamEvent = Schema.NullOr(WorktreeSetupSnapshot);
export type WorktreeSetupStreamEvent = typeof WorktreeSetupStreamEvent.Type;

export const WorktreeSetupCancelInput = Schema.Struct({
  threadId: ThreadId,
});
export type WorktreeSetupCancelInput = typeof WorktreeSetupCancelInput.Type;

export const WorktreeSetupCancelResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type WorktreeSetupCancelResult = typeof WorktreeSetupCancelResult.Type;

export const WORKTREE_SETUP_STAGE_ORDER: ReadonlyArray<WorktreeSetupStageId> = [
  "fetch",
  "checkout",
  "submodules",
  "setup-script",
  "agent",
];

export function worktreeSetupStageLabel(id: WorktreeSetupStageId): string {
  switch (id) {
    case "fetch":
      return "Fetch base branch";
    case "checkout":
      return "Check out files";
    case "submodules":
      return "Init submodules";
    case "setup-script":
      return "Run setup script";
    case "agent":
      return "Start agent";
  }
}
