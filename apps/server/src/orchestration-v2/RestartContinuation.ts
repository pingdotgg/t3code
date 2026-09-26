import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import { ServerSettingsService } from "../serverSettings.ts";
import { PROVIDER_BUSY_RETRY_DELAYS_MS } from "./ProviderFailure.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    "thread" | "runs" | "providerThreads" | "providerSessions" | "providerTurns"
  >,
): OrchestrationV2Run | undefined {
  if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
  const run = projection.runs.reduce<OrchestrationV2Run | undefined>(
    (latest, candidate) => (!latest || candidate.ordinal > latest.ordinal ? candidate : latest),
    undefined,
  );
  if (!run) return;
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  if (run.status !== "running" && !preparedContinuation) return;
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
    (!preparedContinuation && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  if (
    !session ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (!preparedContinuation && session.status !== "running")
  )
    return;
  if (
    !preparedContinuation &&
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
    const projection = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
      messageIds: [messageId],
    });
    if (
      !resolveProjectSettings(enabled, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;

    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    if (!source || source.status !== "cancelled") return;
    // A user submission after reconciliation takes precedence over an automatic prompt.
    if (projection.runs.some((run) => run.ordinal > source.ordinal)) return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      text: "Continue where you left off.",
      attachments: [],
      modelSelection: source.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      restartContinuationOfRunId: input.sourceRunId,
    });
  },
);

/**
 * Retries a run that failed because the provider was temporarily overloaded.
 * Scheduled by run finalization; every guard is rechecked here because the
 * thread can change while the effect waits out its delay.
 */
export const retryProviderBusyRun = Effect.fn("RestartContinuation.retryProviderBusyRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    readonly attempt: number;
  }) {
    if (input.attempt > PROVIDER_BUSY_RETRY_DELAYS_MS.length) return;
    const threads = yield* ThreadManagementService;
    const projection = yield* threads.getThreadProjection(input.threadId);
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
    // Settling or snoozing parks the thread; a message would un-park it, and only the user does that.
    const snoozedUntil = projection.thread.snoozedUntil ?? null;
    if (
      projection.thread.settledOverride === "settled" ||
      (snoozedUntil !== null && DateTime.isGreaterThan(snoozedUntil, yield* DateTime.now))
    )
      return;
    const messageId = MessageId.make(`message:provider-busy-retry:${input.sourceRunId}`);
    if (projection.messages.some((message) => message.id === messageId)) return;
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    if (!source || source.status !== "failed") return;
    // A user submission after the failure takes precedence over an automatic prompt.
    if (projection.runs.some((run) => run.ordinal > source.ordinal)) return;
    if (projection.thread.providerInstanceId !== source.providerInstanceId) return;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:provider-busy-retry:${input.sourceRunId}`),
      threadId: input.threadId,
      messageId,
      text: "The provider was temporarily at capacity and the last run stopped. Continue where you left off.",
      attachments: [],
      // The thread's selection, not the failed run's: a model picked while the
      // retry waited must not be reverted.
      modelSelection: projection.thread.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      providerBusyRetry: { sourceRunId: input.sourceRunId, attempt: input.attempt },
    });
  },
);
