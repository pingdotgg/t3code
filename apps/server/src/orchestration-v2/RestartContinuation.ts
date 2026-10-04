import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./Orchestrator.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  isRestartNoteSource,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
} from "./RestartBackgroundNote.ts";

const CONTINUE_PROMPT = "Continue where you left off.";

/** Archived, deleted, and settled threads are done; a restart does not reopen them. */
function isPutAway(
  thread: Pick<OrchestrationV2AppThread, "archivedAt" | "deletedAt" | "settledOverride">,
): boolean {
  return (
    thread.archivedAt !== null || thread.deletedAt !== null || thread.settledOverride === "settled"
  );
}

/**
 * The run a restart continuation resumes, if any: an unfinished root run, or a
 * settled one whose own provider thread lost background work in the restart
 * (`cancelledWorkProviderThreadIds`, which recovery records on that thread).
 *
 * Resuming an unfinished run needs the "Continue threads after restarts" opt-in
 * (`resumeInterrupted`). Waking a settled run does not: its agent ended the turn
 * waiting on that work, and the provider would have woken it when the work ended.
 */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runs" | "providerThreads" | "providerSessions" | "providerTurns"
  >,
  cancelledWorkProviderThreadIds: ReadonlySet<ProviderThreadId> = new Set(),
  resumeInterrupted = true,
): OrchestrationV2Run | undefined {
  if (isPutAway(projection.thread)) return;
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
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  // Background work outlived this settled turn; the provider has no live turn.
  const settledWithCancelledWork =
    (run.status === "completed" || run.status === "waiting") &&
    run.providerThreadId !== null &&
    cancelledWorkProviderThreadIds.has(run.providerThreadId);
  // A continuation another restart cut before it reached the provider is
  // offered again whatever the opt-in: this read lacks the run it continues,
  // and delivery reads the full history to tell a wake from a resume.
  if (
    !settledWithCancelledWork &&
    !preparedContinuation &&
    !(resumeInterrupted && run.status === "running")
  )
    return;
  const liveTurnRequired = !preparedContinuation && !settledWithCancelledWork;
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
  // A settled thread's session may already be stopped and out of the recovery
  // read; the continuation reopens it from the provider thread's native ref.
  // Most adapters keep a live session "ready" through its turns, so only a
  // stopped or failed session rules out a live turn.
  if (
    session === undefined
      ? !settledWithCancelledWork
      : session.providerInstanceId !== run.providerInstanceId ||
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

export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: { readonly threadId: ThreadId; readonly sourceRunId: RunId }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts"],
      { messageIds: [messageId] },
    );
    if (isPutAway(projection.thread)) return;

    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    // A settled source prompts with the note of the background work it lost.
    const noteSource =
      source !== undefined && isRestartNoteSource(source, projection.providerTurns);
    if (!source || (source.status !== "cancelled" && !noteSource)) return;
    const note = restartContinuationNote(
      source,
      projection.runs,
      projection.providerTurns,
      projection.attempts,
    );
    // Only resuming an interrupted turn is opt-in; see `restartContinuationRun`.
    if (
      !note.settled &&
      (enabled === null ||
        !resolveProjectSettings(enabled, projection.thread.projectId).settings
          .continueThreadsAfterServerUpdate)
    )
      return;
    // A user submission after reconciliation takes precedence over an automatic
    // prompt. Queued runs never started and stay held behind this one.
    if (
      projection.runs.some(
        (run) => run.id !== source.id && run.status !== "queued" && runRanAfter(run, source),
      )
    )
      return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    // The user asked this run's current attempt to stop before the restart cut
    // it. A steer after the Stop starts a new attempt and supersedes it.
    if (
      sourceRecords.turnItems.some(
        (item) =>
          item.runId === source.id &&
          item.type === "run_interrupt_request" &&
          projection.providerTurns.some(
            (turn) =>
              turn.id === item.providerTurnId && turn.runAttemptId === source.activeAttemptId,
          ),
      )
    )
      return;
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return;
    const noteText =
      note.work.length === 0 ? undefined : restartCancelledBackgroundWorkNote(note.work);
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      text:
        noteText === undefined
          ? CONTINUE_PROMPT
          : note.settled
            ? noteText
            : `${noteText}\n\n${CONTINUE_PROMPT}`,
      attachments: [],
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
