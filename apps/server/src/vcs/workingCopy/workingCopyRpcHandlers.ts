/**
 * fork: f4 — the 28 `workingCopy.*` RPC handlers, factored out of `ws.ts`.
 *
 * `ws.ts` is one of the three hottest files in the repo for upstream
 * conflicts, so its share of this feature is exactly three lines: one import,
 * one service acquisition, and one spread into `WsRpcGroup.of`. Everything
 * else lives here.
 *
 * **Liveness without a watcher.** Every mutation ends by nudging the existing
 * `VcsStatusBroadcaster` local refresh — the same call every upstream vcs
 * mutation already makes — which pushes `subscribeVcsStatus` to every client.
 * The panel therefore stays live off server push with no new fs watcher, no
 * new subscription and no client polling; it re-reads `workingCopy.status`
 * when that push lands.
 */
import * as Effect from "effect/Effect";

import { WS_METHODS } from "@t3tools/contracts";
import type {
  EnvironmentAuthorizationError,
  WorkingCopyAbortOperationInput,
  WorkingCopyAmendCommitInput,
  WorkingCopyApplyPatchInput,
  WorkingCopyCheckoutCommitInput,
  WorkingCopyCherryPickInput,
  WorkingCopyCommitDetailInput,
  WorkingCopyCommitFileDiffInput,
  WorkingCopyCommitStagedInput,
  WorkingCopyCwdInput,
  WorkingCopyDiffInput,
  WorkingCopyDiscardPathsInput,
  WorkingCopyFileAtRefInput,
  WorkingCopyGenerateCommitMessageInput,
  WorkingCopyLogInput,
  WorkingCopyPathsInput,
  WorkingCopyResetToCommitInput,
  WorkingCopyResolveConflictInput,
  WorkingCopyRevertCommitInput,
  WorkingCopyStashPushInput,
  WorkingCopyStashRefInput,
  WorkingCopyStatusInput,
  WorkingCopyTagCommitInput,
} from "@t3tools/contracts";
import type { WorkingCopyService } from "./WorkingCopyService.ts";

/**
 * `ws.ts`'s scope-checking wrapper. Declared as an interface so the generic
 * call signature survives being passed as a value.
 */
export interface WorkingCopyObserveRpcEffect {
  <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ): Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
}

export interface WorkingCopyRpcHandlerDeps {
  readonly workingCopy: WorkingCopyService["Service"];
  readonly observeRpcEffect: WorkingCopyObserveRpcEffect;
  /** Fire-and-forget local status refresh; never fails the RPC. */
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
}

const TRACE = { "rpc.aggregate": "vcs" } as const;

export function makeWorkingCopyRpcHandlers(deps: WorkingCopyRpcHandlerDeps) {
  const { workingCopy, observeRpcEffect, refreshGitStatus } = deps;

  /** Reads: nothing to invalidate. */
  const read = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    observeRpcEffect(method, effect, TRACE);

  /**
   * Mutations: push the new local status out without waiting for the client to
   * ask. On failure nothing is refreshed and the error propagates verbatim —
   * the panel's contract is a toast carrying the full stderr.
   */
  const mutate = <A, E, R>(method: string, cwd: string, effect: Effect.Effect<A, E, R>) =>
    observeRpcEffect(method, effect.pipe(Effect.tap(() => refreshGitStatus(cwd))), TRACE);

  return {
    // Reads
    [WS_METHODS.workingCopyStatus]: (input: WorkingCopyStatusInput) =>
      read(WS_METHODS.workingCopyStatus, workingCopy.status(input)),
    [WS_METHODS.workingCopyDiff]: (input: WorkingCopyDiffInput) =>
      read(WS_METHODS.workingCopyDiff, workingCopy.diff(input)),
    [WS_METHODS.workingCopyFileAtRef]: (input: WorkingCopyFileAtRefInput) =>
      read(WS_METHODS.workingCopyFileAtRef, workingCopy.fileAtRef(input)),
    [WS_METHODS.workingCopyListDiscardBackups]: (input: WorkingCopyCwdInput) =>
      read(WS_METHODS.workingCopyListDiscardBackups, workingCopy.listDiscardBackups(input)),
    [WS_METHODS.workingCopyLastCommitMessage]: (input: WorkingCopyCwdInput) =>
      read(WS_METHODS.workingCopyLastCommitMessage, workingCopy.lastCommitMessage(input)),
    // fork: f4 AI commit message — a read, so no `refreshGitStatus`: it
    // changes nothing in the repository and a status push would be a lie.
    [WS_METHODS.workingCopyGenerateCommitMessage]: (input: WorkingCopyGenerateCommitMessageInput) =>
      read(WS_METHODS.workingCopyGenerateCommitMessage, workingCopy.generateCommitMessage(input)),
    [WS_METHODS.workingCopyLog]: (input: WorkingCopyLogInput) =>
      read(WS_METHODS.workingCopyLog, workingCopy.log(input)),
    [WS_METHODS.workingCopyCommitDetail]: (input: WorkingCopyCommitDetailInput) =>
      read(WS_METHODS.workingCopyCommitDetail, workingCopy.commitDetail(input)),
    [WS_METHODS.workingCopyCommitFileDiff]: (input: WorkingCopyCommitFileDiffInput) =>
      read(WS_METHODS.workingCopyCommitFileDiff, workingCopy.commitFileDiff(input)),
    [WS_METHODS.workingCopyStashList]: (input: WorkingCopyCwdInput) =>
      read(WS_METHODS.workingCopyStashList, workingCopy.stashList(input)),

    // Mutations
    [WS_METHODS.workingCopyStagePaths]: (input: WorkingCopyPathsInput) =>
      mutate(WS_METHODS.workingCopyStagePaths, input.cwd, workingCopy.stagePaths(input)),
    [WS_METHODS.workingCopyUnstagePaths]: (input: WorkingCopyPathsInput) =>
      mutate(WS_METHODS.workingCopyUnstagePaths, input.cwd, workingCopy.unstagePaths(input)),
    [WS_METHODS.workingCopyApplyPatch]: (input: WorkingCopyApplyPatchInput) =>
      mutate(WS_METHODS.workingCopyApplyPatch, input.cwd, workingCopy.applyPatch(input)),
    [WS_METHODS.workingCopyDiscardPaths]: (input: WorkingCopyDiscardPathsInput) =>
      mutate(WS_METHODS.workingCopyDiscardPaths, input.cwd, workingCopy.discardPaths(input)),
    [WS_METHODS.workingCopyRestoreDiscardBackup]: (input: WorkingCopyStashRefInput) =>
      mutate(
        WS_METHODS.workingCopyRestoreDiscardBackup,
        input.cwd,
        workingCopy.restoreDiscardBackup(input),
      ),
    [WS_METHODS.workingCopyCommitStaged]: (input: WorkingCopyCommitStagedInput) =>
      mutate(WS_METHODS.workingCopyCommitStaged, input.cwd, workingCopy.commitStaged(input)),
    [WS_METHODS.workingCopyAmendCommit]: (input: WorkingCopyAmendCommitInput) =>
      mutate(WS_METHODS.workingCopyAmendCommit, input.cwd, workingCopy.amendCommit(input)),
    [WS_METHODS.workingCopyUndoLastCommit]: (input: WorkingCopyCwdInput) =>
      mutate(WS_METHODS.workingCopyUndoLastCommit, input.cwd, workingCopy.undoLastCommit(input)),
    [WS_METHODS.workingCopyStashPush]: (input: WorkingCopyStashPushInput) =>
      mutate(WS_METHODS.workingCopyStashPush, input.cwd, workingCopy.stashPush(input)),
    [WS_METHODS.workingCopyStashApply]: (input: WorkingCopyStashRefInput) =>
      mutate(WS_METHODS.workingCopyStashApply, input.cwd, workingCopy.stashApply(input)),
    [WS_METHODS.workingCopyStashPop]: (input: WorkingCopyStashRefInput) =>
      mutate(WS_METHODS.workingCopyStashPop, input.cwd, workingCopy.stashPop(input)),
    [WS_METHODS.workingCopyStashDrop]: (input: WorkingCopyStashRefInput) =>
      mutate(WS_METHODS.workingCopyStashDrop, input.cwd, workingCopy.stashDrop(input)),
    [WS_METHODS.workingCopyResolveConflict]: (input: WorkingCopyResolveConflictInput) =>
      mutate(WS_METHODS.workingCopyResolveConflict, input.cwd, workingCopy.resolveConflict(input)),
    [WS_METHODS.workingCopyAbortOperation]: (input: WorkingCopyAbortOperationInput) =>
      mutate(WS_METHODS.workingCopyAbortOperation, input.cwd, workingCopy.abortOperation(input)),
    [WS_METHODS.workingCopyCherryPick]: (input: WorkingCopyCherryPickInput) =>
      mutate(WS_METHODS.workingCopyCherryPick, input.cwd, workingCopy.cherryPick(input)),
    [WS_METHODS.workingCopyRevertCommit]: (input: WorkingCopyRevertCommitInput) =>
      mutate(WS_METHODS.workingCopyRevertCommit, input.cwd, workingCopy.revertCommit(input)),
    [WS_METHODS.workingCopyCheckoutCommit]: (input: WorkingCopyCheckoutCommitInput) =>
      mutate(WS_METHODS.workingCopyCheckoutCommit, input.cwd, workingCopy.checkoutCommit(input)),
    [WS_METHODS.workingCopyResetToCommit]: (input: WorkingCopyResetToCommitInput) =>
      mutate(WS_METHODS.workingCopyResetToCommit, input.cwd, workingCopy.resetToCommit(input)),
    [WS_METHODS.workingCopyTagCommit]: (input: WorkingCopyTagCommitInput) =>
      mutate(WS_METHODS.workingCopyTagCommit, input.cwd, workingCopy.tagCommit(input)),
  };
}
