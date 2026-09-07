import {
  type CommandId,
  type ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { newCommandId, readThread, readWritableThread, unavailable } from "../../threadAccess.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(projection: OrchestrationV2ThreadProjection, runId: RunId, limit: number) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readWritableThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(unavailable));
  return { sequence: result.sequence };
});

export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  t3_queue_list: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  t3_queue_read: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  t3_queue_edit: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  t3_queue_cancel: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  t3_queue_reorder: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  t3_queue_promote_to_steer: (input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  t3_thread_organize: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readWritableThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
});
