import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  latestProviderTurnForAttempt,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  isRestartNoteSource,
  isWorktreeContinuationRun,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
  restartPromptSource,
} from "./RestartBackgroundNote.ts";

const CONTINUE_PROMPT = "Continue where you left off.";

/** A recorded intent must not wake held threads, unanswered requests, or settled provider turns. */
export function restartContinuationBlocked(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runtimeRequests" | "providerTurns" | "turnItems"
  >,
  source: OrchestrationV2Run,
): boolean {
  if (
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.settledOverride === "settled" ||
    projection.thread.snoozedUntil != null
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  return (
    (turn !== undefined &&
      (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")) ||
    projection.runtimeRequests.some(
      (request) =>
        // Tool calls and auth refreshes do not wait on a person, and a
        // message-capable question stays answerable after the restart.
        request.kind !== "dynamic_tool_call" &&
        request.kind !== "auth_refresh" &&
        request.responseCapability.type !== "message" &&
        (request.status === "pending" ||
          // Recovery closes live callbacks; it does not answer their question.
          ((request.status === "expired" || request.status === "cancelled") &&
            request.responseCapability.type === "not_resumable" &&
            source.activeAttemptId !== null &&
            projection.providerTurns.some(
              (turn) =>
                turn.id === request.providerTurnId && turn.runAttemptId === source.activeAttemptId,
            ))),
    ) ||
    projection.turnItems.some(
      (item) =>
        item.type === "secret_request" &&
        item.runId === source.id &&
        (item.secretStatus === "pending" ||
          (item.secretStatus === "cancelled" &&
            item.completedAt !== null &&
            source.completedAt !== null &&
            DateTime.Order(item.completedAt, source.completedAt) === 0)),
    )
  );
}

/**
 * Resume only an unfinished root turn. Leftover background work is cleaned up
 * separately and reported on the next user turn; it must not wake a settled run.
 */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    | "thread"
    | "runs"
    | "attempts"
    | "providerThreads"
    | "providerSessions"
    | "providerTurns"
    | "runtimeRequests"
    | "turnItems"
  >,
): OrchestrationV2Run | undefined {
  // Queued runs never started; recovery holds them behind the cut run.
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) =>
      candidate.status !== "queued" && (!latest || runRanAfter(candidate, latest))
        ? candidate
        : latest,
    undefined,
  );
  if (!run) return;
  const preparedContinuation =
    run.status === "starting" &&
    (run.restartContinuationOfRunId !== undefined ||
      restartPromptSource(run, projection.runs, projection.providerTurns, projection.attempts) !==
        undefined);
  if (run.status !== "running" && !preparedContinuation) return;
  if (restartContinuationBlocked(projection, run)) return;
  const liveTurnRequired = !preparedContinuation;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Most adapters keep a live session "ready" through its turns, so only a
  // stopped or failed session rules out a live turn.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (liveTurnRequired && (session.status === "stopped" || session.status === "error"))
  )
    return;
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

/** Consecutive automatic continuations allowed before a person has to step in. */
const MAX_CONTINUATION_CHAIN = 3;

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], turnItemTypes: ["secret_request"] },
    );
    if (
      !resolveProjectSettings(enabled, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    const worktreeContinuation =
      source !== undefined &&
      source.status === "queued" &&
      source.queueHeld !== true &&
      isWorktreeContinuationRun(source) &&
      projection.thread.worktreePath != null &&
      projection.runs.filter((run) => run.status === "queued").length === 1 &&
      !projection.runs.some((run) =>
        ["preparing", "starting", "running", "waiting"].includes(run.status),
      );
    // Pending effects from older versions may target settled background work,
    // including waiting runs that reconciliation subsequently cancelled.
    if (
      !source ||
      (source.status !== "cancelled" && !worktreeContinuation) ||
      (isWorktreeContinuationRun(source) &&
        source.status === "cancelled" &&
        !projection.providerTurns.some((turn) => turn.runAttemptId === source.activeAttemptId)) ||
      restartContinuationBlocked(projection, source) ||
      isRestartNoteSource(source, projection.providerTurns)
    )
      return;
    // A user submission after reconciliation takes precedence over an automatic
    // prompt. Queued runs never started and stay held behind this one.
    if (
      projection.runs.some(
        (run) =>
          run.id !== source.id &&
          run.status !== "queued" &&
          (worktreeContinuation ? run.ordinal > source.ordinal : runRanAfter(run, source)),
      )
    )
      return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    // A turn that keeps crashing the server would otherwise restart it forever.
    let chainLength = 0;
    for (
      let run: (typeof projection.runs)[number] | undefined = source;
      run?.restartContinuationOfRunId !== undefined && chainLength < MAX_CONTINUATION_CHAIN;
      run = projection.runs.find((candidate) => candidate.id === run?.restartContinuationOfRunId)
    ) {
      chainLength += 1;
    }
    if (chainLength >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    const promptSource = restartPromptSource(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId, ...(promptSource ? [promptSource.userMessageId] : [])],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    // The user asked this run to stop before the restart cut it.
    if (
      sourceRecords.turnItems.some(
        (item) => item.runId === source.id && item.type === "run_interrupt_request",
      )
    )
      return;
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
    const replacementMessage =
      promptSource === undefined
        ? undefined
        : sourceRecords.messages.find((message) => message.id === promptSource.userMessageId);
    if (promptSource !== undefined && replacementMessage === undefined) return;
    const prompt = replacementMessage?.text ?? CONTINUE_PROMPT;
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      ...(sourceMessage?.scheduledTaskId === undefined
        ? {}
        : { scheduledTaskId: sourceMessage.scheduledTaskId }),
      text: noteText === undefined ? prompt : note.settled ? noteText : `${noteText}\n\n${prompt}`,
      attachments: replacementMessage?.attachments ?? [],
      ...(replacementMessage?.context === undefined ? {} : { context: replacementMessage.context }),
      modelSelection: source.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: input.sourceRunId,
    });
  },
  // A delegated child this declined to continue still owes its parent a
  // result. Once a continuation run exists this is a no-op; that run settles it.
  (effect, input) =>
    effect.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);
