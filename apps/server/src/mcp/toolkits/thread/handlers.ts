import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type ProviderApprovalDecision,
  ProviderRequestKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { modelSelectionCommandType } from "@t3tools/shared/model";

import {
  newCommandId,
  readCaller,
  readFullAccessCaller,
  readThread,
  readWritableThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
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

const isApprovalKind = Schema.is(ProviderRequestKind);
// The composer's choices when a provider advertises none.
const defaultApprovalDecisions: ReadonlyArray<ProviderApprovalDecision> = [
  "cancel",
  "decline",
  "acceptForSession",
  "accept",
];
/** Pending requests a caller can act on: user questions and approvals. */
const isPendingRequest = (request: OrchestrationV2ThreadProjection["runtimeRequests"][number]) =>
  request.status === "pending" && (request.kind === "user_input" || isApprovalKind(request.kind));

const readPendingRequest = Effect.fn("mcp.readPendingRequest")(function* (
  input: {
    threadId?: ThreadId | undefined;
    requestId: RuntimeRequestId;
  },
  writable = false,
) {
  const context = yield* writable
    ? readWritableThread(input.threadId, ["runtimeRequests", "turnItems"])
    : readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && isPendingRequest(request),
  );
  const item = context.projection.turnItems.find(
    (item) =>
      (item.type === "user_input_request" || item.type === "approval_request") &&
      item.requestId === input.requestId,
  );
  if (
    request === undefined ||
    (request.kind === "user_input" && item?.type !== "user_input_request")
  )
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending request was not found.",
    });
  return { ...context, request, item };
});

/** Mirrors the client's early wake: a fresh completion or failure after the snooze. */
function raisedHandWhileSnoozed(shell: OrchestrationV2ThreadShell) {
  const completedAt = shell.latestRunCompletedAt ?? null;
  const snoozedAt = shell.snoozedAt ?? null;
  if (snoozedAt === null) return shell.status === "failed";
  return (
    (shell.status === "completed" || shell.status === "failed") &&
    completedAt !== null &&
    DateTime.isGreaterThan(completedAt, snoozedAt)
  );
}

/** Why a thread needs attention, if it does. unread mirrors the client's hasUnseenCompletion. */
function inboxReason(shell: OrchestrationV2ThreadShell, now: DateTime.Utc) {
  if (shell.pendingRuntimeRequest !== null) return "pending_request" as const;
  if (shell.settledOverride === "settled") return null;
  if (
    shell.snoozedUntil != null &&
    DateTime.isGreaterThan(shell.snoozedUntil, now) &&
    !raisedHandWhileSnoozed(shell)
  )
    return null;
  if (shell.status === "failed") return "error" as const;
  const completedAt = shell.latestRunCompletedAt ?? null;
  const visitedAt = shell.lastVisitedAt ?? null;
  return completedAt !== null &&
    visitedAt !== null &&
    DateTime.isGreaterThan(completedAt, visitedAt)
    ? ("unread" as const)
    : null;
}
const inboxReasonOrder = ["pending_request", "error", "unread"] as const;
export const ThreadToolkitHandlersLive = ThreadToolkit.toLayer({
  run_scheduled_task_now: (input) =>
    Effect.gen(function* () {
      yield* readFullAccessCaller(
        "Running a scheduled task requires a live full-access/default thread or a full-access client.",
      );
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
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
      const { projectId: requested, ...query } = input;
      // Like the other project tools, an omitted project means the caller's own; a client
      // outside a thread searches every project.
      const projectId = requested ?? caller?.projectId;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const result = yield* threadSearch.search(query).pipe(Effect.mapError(unavailable));
      return {
        matches:
          projectId === undefined
            ? result.matches
            : result.matches.filter((match) => match.projectId === projectId),
      };
    }),
  t3_thread_fork: (input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readWritableThread(input.threadId);
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
      const context = yield* readWritableThread(input.targetThreadId);
      const source = yield* readWritableThread(input.sourceThreadId);
      const result = yield* context.threads
        .dispatch({
          type: "thread.merge_back",
          commandId: yield* newCommandId(),
          sourceThreadId: source.projection.thread.id,
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
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
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
      } = yield* readWritableThread(input.threadId);
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
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      const requests = projection.runtimeRequests
        .filter(isPendingRequest)
        .map((request) => ({ requestId: request.id, kind: request.kind }));
      return {
        // The original output: user questions only.
        requestIds: requests
          .filter((request) => request.kind === "user_input")
          .map((request) => request.requestId),
        requests,
      };
    }),
  t3_pending_request_read: (input) =>
    Effect.gen(function* () {
      const { request, item } = yield* readPendingRequest(input);
      const approval = item?.type === "approval_request" ? item : undefined;
      return {
        requestId: input.requestId,
        kind: request.kind,
        ...(item?.type === "user_input_request" ? { questions: item.questions } : {}),
        ...(approval?.prompt === undefined
          ? {}
          : { prompt: Array.from(approval.prompt).slice(0, 4000).join("") }),
        ...(approval?.options === undefined ? {} : { options: approval.options }),
      };
    }),
  t3_pending_request_respond: (input) =>
    Effect.gen(function* () {
      const { threads, projection, request, item } = yield* readPendingRequest(input, true);
      const approval = request.kind !== "user_input";
      const response = approval
        ? input.decision === undefined
          ? undefined
          : { decision: input.decision }
        : input.answers === undefined
          ? undefined
          : { answers: input.answers };
      if (response === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: approval ? "Approvals need a decision." : "User questions need answers.",
        });
      // Like the composer, offer only the provider's options, else the same defaults.
      const offered = item?.type === "approval_request" ? item.options : undefined;
      if (
        approval &&
        input.decision !== undefined &&
        !(offered?.map((option) => option.decision) ?? defaultApprovalDecisions).includes(
          input.decision,
        )
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "That decision was not offered for this approval.",
        });
      // Approving lets the caller run commands in the target thread; declining or cancelling
      // only stops one, which any caller that can reach the thread may do.
      if (approval && input.decision !== "decline" && input.decision !== "cancel")
        yield* readFullAccessCaller(
          "Approving requires a live full-access/default thread or a full-access client.",
        );
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          ...response,
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
  t3_pending_request_dismiss: (input) =>
    Effect.gen(function* () {
      const { threads, projection, request } = yield* readPendingRequest(input, true);
      if (request.kind !== "user_input")
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Only user questions can be dismissed. Decline an approval with a decision.",
        });
      const result = yield* threads
        .dispatch({
          type: "thread.user-input.dismiss",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
        })
        .pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
  t3_inbox: (input) =>
    Effect.gen(function* () {
      const { threads, caller } = yield* readCaller();
      // Like t3_thread_search, an omitted project means the caller's own; a client outside
      // a thread sees every project.
      const projectId = input.projectId ?? caller?.projectId;
      const snapshot = yield* threads.getShellSnapshot().pipe(Effect.mapError(unavailable));
      const now = yield* DateTime.now;
      const items = snapshot.threads
        .flatMap((shell) => {
          if (shell.archivedAt !== null || shell.deletedAt !== null) return [];
          if (projectId !== undefined && shell.projectId !== projectId) return [];
          const reason = inboxReason(shell, now);
          return reason === null ? [] : [{ shell, reason }];
        })
        .toSorted(
          (left, right) =>
            inboxReasonOrder.indexOf(left.reason) - inboxReasonOrder.indexOf(right.reason) ||
            DateTime.toEpochMillis(right.shell.updatedAt) -
              DateTime.toEpochMillis(left.shell.updatedAt),
        );
      return {
        items: items.slice(0, input.limit ?? 50).map(({ shell, reason }) => ({
          threadId: shell.id,
          projectId: shell.projectId,
          title: shell.title,
          updatedAt: DateTime.formatIso(shell.updatedAt),
          reason,
          ...(shell.pendingRuntimeRequest === null
            ? {}
            : {
                pendingRequest: {
                  requestId: shell.pendingRuntimeRequest.id,
                  kind: shell.pendingRuntimeRequest.kind,
                },
              }),
        })),
      };
    }),
  t3_queue_list: (input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
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
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
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
        case "mark_read": {
          // The reverse of mark_unread: visit up to the thread's current state, as a client does.
          const shell = yield* threads
            .getThreadShell(projection.thread.id)
            .pipe(Effect.mapError(unavailable));
          if (shell === null) return yield* unavailable();
          command = {
            ...common,
            type: "thread.visit",
            visitedAt: DateTime.formatIso(shell.updatedAt),
          };
          break;
        }
        case "auto_settle_on":
        case "auto_settle_off":
          command = {
            ...common,
            type: "thread.auto-settle.set",
            enabled: input.action === "auto_settle_on",
          };
          break;
        case "delete":
          // Deleting cannot be undone, so it needs full access on top of reaching the thread.
          yield* readFullAccessCaller(
            "Deleting a thread requires a live full-access/default thread or a full-access client.",
          );
          command = { ...common, type: "thread.delete" };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(unavailable));
      return { sequence: result.sequence };
    }),
});
