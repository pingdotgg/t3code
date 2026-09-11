import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@t3tools/shared/model";

import {
  newCommandId,
  readCaller,
  readMutationCaller,
  readThread,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
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

const readQuestion = Effect.fn("mcp.readQuestion")(function* (
  input: {
    threadId?: ThreadId | undefined;
    requestId: RuntimeRequestId;
  },
  writable = false,
) {
  const context = yield* writable ? readWritableThread(input.threadId) : readThread(input.threadId);
  const request = context.projection.runtimeRequests.find(
    (request) =>
      request.id === input.requestId &&
      request.kind === "user_input" &&
      request.status === "pending",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  return { ...context, request, item };
});
export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  run_scheduled_task_now: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readMutationCaller();
      if (
        caller.archivedAt !== null ||
        caller.runtimeMode !== "full-access" ||
        caller.interactionMode !== "default"
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Running a scheduled task requires a live full-access/default thread.",
        });
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId && task.projectId === caller.projectId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The task was not found in the calling project.",
        });
      const { task } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: task.id,
        threadId: task.threadId,
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  t3_thread_search: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const result = yield* query.searchThreads(input).pipe(Effect.mapError(unavailable));
      return { matches: result.matches.filter((match) => match.projectId === caller.projectId) };
    }),
  t3_thread_fork: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readWritableThread();
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence, targetThreadId };
    }),
  t3_thread_merge_back: (input) =>
    Effect.gen(function* () {
      const { threads, caller } = yield* readWritableThread(input.targetThreadId);
      const result = yield* threads
        .dispatch({
          type: "thread.merge_back",
          commandId: yield* newCommandId(),
          sourceThreadId: caller.id,
          targetThreadId: input.targetThreadId,
          sourcePoint: input.sourcePoint,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence, targetThreadId: input.targetThreadId };
    }),
  t3_thread_transfers: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  t3_thread_configuration: (input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      };
    }),
  t3_thread_configure: (input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readWritableThread();
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
  t3_pending_request_list: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  t3_pending_request_read: (input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  t3_pending_request_respond: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readQuestion(input, true);
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          answers: input.answers,
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
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
