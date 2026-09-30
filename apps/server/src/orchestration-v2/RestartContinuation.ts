import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type ProviderThreadId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import { ServerSettingsService } from "../serverSettings.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import {
  isRestartNoteSource,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

/**
 * The run a restart continuation resumes, if any: an unfinished root run, or a
 * settled one whose own provider thread lost background work in the restart
 * (`cancelledWorkProviderThreadIds`, which recovery records on that thread).
 */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runs" | "providerThreads" | "providerSessions" | "providerTurns"
  >,
  cancelledWorkProviderThreadIds: ReadonlySet<ProviderThreadId> = new Set(),
): OrchestrationV2Run | undefined {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) => (!latest || candidate.ordinal > latest.ordinal ? candidate : latest),
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
  if (run.status !== "running" && !preparedContinuation && !settledWithCancelledWork) return;
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
    const settings = yield* ServerSettingsService;
    const enabled = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!enabled) return;
    const threads = yield* ThreadManagementService;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns"],
      { messageIds: [messageId] },
    );
    if (
      !resolveProjectSettings(enabled, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;

    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    // A settled source prompts with the note of the background work it lost.
    const noteSource =
      source !== undefined && isRestartNoteSource(source, projection.providerTurns);
    if (!source || (source.status !== "cancelled" && !noteSource)) return;
    // A user submission after reconciliation takes precedence over an automatic prompt.
    if (projection.runs.some((run) => run.ordinal > source.ordinal)) return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      text: noteSource
        ? restartCancelledBackgroundWorkNote(source.restartCancelledBackgroundWork ?? [])
        : "Continue where you left off.",
      attachments: [],
      modelSelection: source.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: input.sourceRunId,
    });
  },
);
