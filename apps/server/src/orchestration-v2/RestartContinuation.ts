import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

export function restartContinuationRun(
  projection: OrchestrationV2ThreadProjection,
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
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.continueThreadsAfterServerUpdate),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return;
    const threads = yield* ThreadManagementService;
    const projection = yield* threads.getThreadProjection(input.threadId);
    if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) return;
    const messageId = MessageId.make(`message:restart-continuation:${input.sourceRunId}`);
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
