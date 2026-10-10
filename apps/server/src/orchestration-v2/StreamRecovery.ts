import { STREAM_RECOVERY_PROMPT } from "./StreamRecoveryPolicy.ts";
import { CommandId, MessageId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const continueStreamFailedRun = Effect.fn("StreamRecovery.continueStreamFailedRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    readonly generation: number;
  }) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const text = STREAM_RECOVERY_PROMPT;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`command:stream-recovery:${input.sourceRunId}`),
      messageId: MessageId.make(`message:stream-recovery:${input.sourceRunId}`),
      threadId: input.threadId,
      streamContinuationOfRunId: input.sourceRunId,
      streamRecoveryGeneration: input.generation,
      text,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "T3 Code is retrying after exhausted stream retries",
        detail: text,
      },
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
    // The guarded dispatch consumes or declines the opportunity. A declined
    // child still owes its parent a result; a new continuation makes this a no-op.
    yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
  },
);

/** Cleanup retries never submit another continuation, even if the source is still pending. */
export const cancelStreamFailedRun = Effect.fn("StreamRecovery.cancelStreamFailedRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    readonly commandId: CommandId;
  }) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "stream-recovery.cancel",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: input.sourceRunId,
    });
    yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
  },
);
