/**
 * DelegateCoordinator - backs the single `delegate_task` MCP tool.
 *
 * A running provider session delegates one self-contained task to a child
 * thread on its own provider instance, model, effort, runtime mode, project,
 * and worktree — all inherited from the calling thread, never chosen by the
 * model. The one exception is advisor mode: when the calling thread is an
 * advisor thread with a user-configured executor model, the child runs on
 * that executor selection instead (still with `interactionMode: "default"`
 * and the parent's stored runtime mode). `delegate_task` returns as soon as
 * the child starts; `wait_for_delegate` performs bounded completion waits. A
 * server-lifetime reconciler mirrors progress and terminal state into the
 * parent timeline independently of the MCP request.
 *
 * Fan-out is bounded by construction: depth is capped at 1 via the persisted
 * `parentThreadId` (delegated children are refused, so advisor executor
 * sub-agents are pure executors that cannot spawn sub-agents of their own),
 * and concurrency is capped per parent (a per-thread slider value for
 * advisor threads, a global constant otherwise) and server-wide. Child
 * threads flow through the regular orchestration engine, so they persist and
 * render in the UI like user-created threads; progress is mirrored into the
 * parent timeline as task activities.
 */
import {
  CommandId,
  DELEGATE_MAX_CHILDREN_PER_PARENT,
  DELEGATE_MAX_RUNNING_SERVER_WIDE,
  DELEGATE_RESULT_MAX_CHARS,
  DelegateError,
  EventId,
  MessageId,
  RuntimeTaskId,
  sanitizeSubAgentName,
  ThreadId,
  type DelegateTaskInput,
  type DelegateTaskResult,
  type DelegateTaskStatusInput,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type SubAgentStatus,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../../../provider/Services/ProviderService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

const WAIT_POLL_INTERVAL_MILLIS = 500;
const DEFAULT_STATUS_WAIT_SECONDS = 20;
const RECONCILE_INTERVAL_MILLIS = 1_000;
const TITLE_MAX_LENGTH = 60;
const PARENT_ACTIVITY_TEXT_MAX_LENGTH = 2_000;
const EFFORT_OPTION_IDS = new Set(["effort", "reasoningEffort", "reasoning"]);

interface DelegateRecord {
  readonly parentThreadId: ThreadId;
  readonly taskId: RuntimeTaskId;
  readonly title: string;
  readonly model: string;
  readonly effort?: string | undefined;
  readonly providerLabel: string;
  readonly parentTurnId: TurnId | null;
  readonly lastTurnRequestedAt: string;
  readonly status: SubAgentStatus;
  readonly lastProgressKey?: string | undefined;
}

export interface DelegateCoordinatorShape {
  readonly delegate: (
    scope: McpInvocationScope,
    input: DelegateTaskInput,
  ) => Effect.Effect<DelegateTaskResult, DelegateError>;
  readonly waitForDelegate: (
    scope: McpInvocationScope,
    input: DelegateTaskStatusInput,
  ) => Effect.Effect<DelegateTaskResult, DelegateError>;
}

export class DelegateCoordinator extends Context.Service<
  DelegateCoordinator,
  DelegateCoordinatorShape
>()("t3/mcp/toolkits/agents/DelegateCoordinator") {}

const defaultTitleForPrompt = (prompt: string): string => {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : "Delegated task";
};

const truncateTitle = (title: string): string =>
  title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : title;

/** `Agent: <name>` so orchestration policy and clients recognize delegated threads. */
const resolveTitle = (input: DelegateTaskInput): string => {
  const name = input.name !== undefined ? sanitizeSubAgentName(input.name) : "";
  const seed = name.length > 0 ? name : defaultTitleForPrompt(input.prompt);
  return truncateTitle(`Agent: ${seed.replace(/^agent:\s*/i, "").trim() || "Delegated task"}`);
};

const stripAgentTitlePrefix = (title: string): string =>
  title.replace(/^agent:\s*/i, "").trim() || title;

const finalAssistantText = (thread: OrchestrationThread): string | null => {
  const latestTurn = thread.latestTurn;
  if (latestTurn?.assistantMessageId) {
    const byId = thread.messages.find((message) => message.id === latestTurn.assistantMessageId);
    if (byId) return byId.text;
  }
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role === "assistant" && latestTurn && message.turnId === latestTurn.turnId) {
      return message.text;
    }
  }
  return null;
};

const hasTurnStartFailureSince = (thread: OrchestrationThread, sinceIso: string): boolean =>
  thread.activities.some(
    (activity) =>
      activity.tone === "error" &&
      activity.kind === "provider.turn.start.failed" &&
      activity.createdAt >= sinceIso,
  );

const turnStatus = (thread: OrchestrationThread, sinceIso: string): SubAgentStatus => {
  const latestTurn = thread.latestTurn;
  // The projection lags the dispatched turn-start command; treat a missing or
  // older latest turn as the requested turn still spinning up — unless the
  // provider already failed before creating the turn, which is recorded only
  // as an error activity on the thread.
  if (!latestTurn || latestTurn.requestedAt < sinceIso) {
    return hasTurnStartFailureSince(thread, sinceIso) ? "error" : "running";
  }
  if (latestTurn.state === "running") return "running";
  if ((thread.session?.activeTurnId ?? null) !== null) return "running";
  return latestTurn.state;
};

const isTerminalStatus = (status: SubAgentStatus): status is Exclude<SubAgentStatus, "running"> =>
  status !== "running";

const taskStatusForStatus = (status: SubAgentStatus): "completed" | "failed" | "stopped" =>
  status === "completed" ? "completed" : status === "interrupted" ? "stopped" : "failed";

const completionSummaryForStatus = (status: SubAgentStatus): string => {
  switch (status) {
    case "completed":
      return "Delegated agent completed.";
    case "interrupted":
      return "Delegated agent interrupted.";
    case "error":
      return "Delegated agent failed.";
    case "running":
      return "Delegated agent still running.";
  }
};

const truncateParentActivityText = (text: string): string =>
  text.length > PARENT_ACTIVITY_TEXT_MAX_LENGTH
    ? `${text.slice(0, PARENT_ACTIVITY_TEXT_MAX_LENGTH - 1).trimEnd()}…`
    : text;

const truncateResult = (text: string): { readonly text: string; readonly truncated: boolean } =>
  text.length > DELEGATE_RESULT_MAX_CHARS
    ? {
        text: `${text.slice(0, DELEGATE_RESULT_MAX_CHARS).trimEnd()}\n\n[truncated — full transcript is available in the delegated thread]`,
        truncated: true,
      }
    : { text, truncated: false };

const runningResult = (record: DelegateRecord, childThreadId: ThreadId): DelegateTaskResult => ({
  taskId: record.taskId,
  threadId: childThreadId,
  status: "running",
  result: "The delegated agent is still running. Call wait_for_delegate again.",
  truncated: false,
});

const progressSnapshot = (
  thread: OrchestrationThread,
): { readonly key: string; readonly summary: string; readonly lastToolName?: string } | null => {
  const activity = thread.activities.at(-1);
  if (!activity) return null;
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : undefined;
  const presentation =
    payload?.presentation && typeof payload.presentation === "object"
      ? (payload.presentation as Record<string, unknown>)
      : undefined;
  const detail = typeof payload?.detail === "string" ? payload.detail.trim() : "";
  const summary = truncateParentActivityText(detail || activity.summary.trim());
  if (summary.length === 0) return null;
  const lastToolName =
    typeof presentation?.title === "string"
      ? presentation.title
      : activity.kind.startsWith("tool.")
        ? activity.summary
        : undefined;
  return {
    key: `${activity.id}:${activity.createdAt}:${summary}`,
    summary,
    ...(lastToolName ? { lastToolName } : {}),
  };
};

const makeDelegateCoordinator = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  // Optional: used to heartbeat the parent's turn-activity watchdog while the
  // parent turn is blocked on a delegated child. Without it the parent emits
  // no runtime events of its own and would be flagged as stalled.
  const providerService = yield* Effect.serviceOption(ProviderService);
  const records = yield* SynchronizedRef.make<ReadonlyMap<ThreadId, DelegateRecord>>(new Map());
  // The concurrency-cap check and record insertion are check-then-act over
  // shared state; serialize just that section (not the wait) so concurrent
  // delegate calls cannot oversubscribe the caps.
  const delegateGate = yield* Semaphore.make(1);

  const randomUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const dispatchFailed = (operation: string) => (cause: unknown) =>
    new DelegateError({
      reason: "dispatch-failed",
      description: `Failed to ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

  const readParentTurnId = Effect.fn("DelegateCoordinator.readParentTurnId")(function* (
    threadId: ThreadId,
  ) {
    const detail = yield* snapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
    if (Option.isNone(detail)) return null;
    return detail.value.session?.activeTurnId ?? detail.value.latestTurn?.turnId ?? null;
  });

  const appendParentTaskActivity = Effect.fn("DelegateCoordinator.appendParentTaskActivity")(
    function* (input: {
      readonly record: DelegateRecord;
      readonly kind: "task.started" | "task.progress" | "task.completed";
      readonly summary: string;
      readonly payload: OrchestrationThreadActivity["payload"];
    }) {
      const createdAt = yield* nowIso;
      const commandUuid = yield* randomUuid;
      const activityUuid = yield* randomUuid;
      yield* engine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:delegate-activity:${commandUuid}`),
          threadId: input.record.parentThreadId,
          createdAt,
          activity: {
            id: EventId.make(`delegate:${input.record.taskId}:${input.kind}:${activityUuid}`),
            tone: "info",
            kind: input.kind,
            summary: input.summary,
            payload: input.payload,
            turnId: input.record.parentTurnId,
            createdAt,
          },
        })
        .pipe(Effect.mapError(dispatchFailed("append delegate activity")));
    },
  );

  const emitTaskStarted = (record: DelegateRecord, childThreadId: ThreadId) =>
    appendParentTaskActivity({
      record,
      kind: "task.started",
      summary: "Delegated agent started",
      payload: {
        taskId: record.taskId,
        description: stripAgentTitlePrefix(record.title),
        taskType: "sub-agent",
        subagentType: record.providerLabel,
        model: record.model,
        ...(record.effort ? { effort: record.effort } : {}),
        workflowName: "delegate_task",
        toolUseId: childThreadId,
      },
    });

  const emitTaskCompleted = (
    record: DelegateRecord,
    childThreadId: ThreadId,
    status: Exclude<SubAgentStatus, "running">,
    finalText: string | null,
  ) =>
    appendParentTaskActivity({
      record,
      kind: "task.completed",
      summary: "Delegated agent finished",
      payload: {
        taskId: record.taskId,
        status: taskStatusForStatus(status),
        summary: truncateParentActivityText(finalText ?? completionSummaryForStatus(status)),
        toolUseId: childThreadId,
      },
    });

  const archiveChild = (childThreadId: ThreadId, thread: OrchestrationThread) => {
    if (thread.archivedAt !== null) return Effect.void;
    return Effect.gen(function* () {
      const commandUuid = yield* randomUuid;
      yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`server:delegate-archive:${commandUuid}`),
          threadId: childThreadId,
        })
        .pipe(Effect.mapError(dispatchFailed("archive delegated thread")));
    });
  };

  const writeStatus = (childThreadId: ThreadId, status: SubAgentStatus) =>
    SynchronizedRef.update(records, (current) => {
      const existing = current.get(childThreadId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(childThreadId, { ...existing, status });
      return next;
    });

  const writeProgressKey = (childThreadId: ThreadId, lastProgressKey: string) =>
    SynchronizedRef.update(records, (current) => {
      const existing = current.get(childThreadId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(childThreadId, { ...existing, lastProgressKey });
      return next;
    });

  const claimTerminalStatus = (childThreadId: ThreadId, status: SubAgentStatus) =>
    SynchronizedRef.modify(records, (current) => {
      const existing = current.get(childThreadId);
      if (!existing || existing.status !== "running") return [false, current] as const;
      const next = new Map(current);
      next.set(childThreadId, { ...existing, status });
      return [true, next] as const;
    });

  /**
   * First observation of a terminal status for a delegated child: update the
   * record, mirror completion into the parent timeline, and archive the child
   * thread so it drops out of active views.
   */
  const settle = Effect.fn("DelegateCoordinator.settle")(function* (
    childThreadId: ThreadId,
    record: DelegateRecord,
    status: Exclude<SubAgentStatus, "running">,
    thread: OrchestrationThread,
    finalText: string | null,
  ) {
    const claimed = yield* claimTerminalStatus(childThreadId, status);
    if (!claimed) return;
    yield* emitTaskCompleted(record, childThreadId, status, finalText).pipe(
      Effect.catch(() => Effect.void),
    );
    yield* archiveChild(childThreadId, thread).pipe(Effect.catch(() => Effect.void));
  });

  /**
   * Refresh this parent's running records against the projection so caps
   * reflect children that settled since the last delegate call.
   */
  const refreshRecords = Effect.fn("DelegateCoordinator.refreshRecords")(function* (
    parentThreadId: ThreadId,
  ) {
    const snapshot = yield* SynchronizedRef.get(records);
    for (const [childThreadId, record] of snapshot) {
      if (record.parentThreadId !== parentThreadId || record.status !== "running") continue;
      const detail = yield* snapshotQuery
        .getThreadDetailById(childThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
      if (Option.isNone(detail)) {
        yield* writeStatus(childThreadId, "error");
        continue;
      }
      const status = turnStatus(detail.value, record.lastTurnRequestedAt);
      if (status === record.status) continue;
      if (isTerminalStatus(status)) {
        yield* settle(
          childThreadId,
          record,
          status,
          detail.value,
          finalAssistantText(detail.value),
        );
      } else {
        yield* writeStatus(childThreadId, status);
      }
    }
  });

  /**
   * The parent turn is blocked on the delegate tool call and emits no runtime
   * events of its own; heartbeat the turn-activity watchdog so the parent
   * thread is not flagged as stalled while the delegated child is working.
   */
  const noteParentActivity = (record: DelegateRecord) =>
    Option.isSome(providerService) && providerService.value.noteSessionActivity !== undefined
      ? providerService.value.noteSessionActivity(record.parentThreadId)
      : Effect.void;

  const observeDelegate = Effect.fn("DelegateCoordinator.observeDelegate")(function* (
    childThreadId: ThreadId,
    record: DelegateRecord,
  ): Effect.fn.Return<DelegateTaskResult, DelegateError> {
    yield* noteParentActivity(record);
    const detail = yield* snapshotQuery
      .getThreadDetailById(childThreadId)
      .pipe(Effect.mapError(dispatchFailed("read delegated thread state")));
    if (Option.isNone(detail)) {
      const message = "The delegated thread no longer exists (it may have been deleted).";
      const claimed = yield* claimTerminalStatus(childThreadId, "error");
      if (claimed) {
        yield* emitTaskCompleted(record, childThreadId, "error", message).pipe(
          Effect.catch(() => Effect.void),
        );
      }
      return {
        taskId: record.taskId,
        threadId: childThreadId,
        status: "error",
        result: message,
        truncated: false,
      };
    }
    const thread = detail.value;
    const status = turnStatus(thread, record.lastTurnRequestedAt);
    if (isTerminalStatus(status)) {
      const finalText = finalAssistantText(thread);
      yield* settle(childThreadId, record, status, thread, finalText);
      const result = truncateResult(finalText ?? completionSummaryForStatus(status));
      return {
        taskId: record.taskId,
        threadId: childThreadId,
        status,
        result: result.text,
        truncated: result.truncated,
      };
    }

    const progress = progressSnapshot(thread);
    if (progress && progress.key !== record.lastProgressKey) {
      yield* appendParentTaskActivity({
        record,
        kind: "task.progress",
        summary: "Delegated agent progress",
        payload: {
          taskId: record.taskId,
          description: stripAgentTitlePrefix(record.title),
          summary: progress.summary,
          ...(progress.lastToolName ? { lastToolName: progress.lastToolName } : {}),
          toolUseId: childThreadId,
          detail: progress.summary,
        },
      }).pipe(Effect.catch(() => Effect.void));
      yield* writeProgressKey(childThreadId, progress.key);
    }
    return runningResult(record, childThreadId);
  });

  const awaitCompletion = Effect.fn("DelegateCoordinator.awaitCompletion")(function* (
    childThreadId: ThreadId,
    record: DelegateRecord,
    waitSeconds: number,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + waitSeconds * 1_000;
    while (true) {
      const current = (yield* SynchronizedRef.get(records)).get(childThreadId) ?? record;
      const result = yield* observeDelegate(childThreadId, current);
      if (result.status !== "running" || (yield* Clock.currentTimeMillis) >= deadline) {
        return result;
      }
      yield* Effect.sleep(Duration.millis(WAIT_POLL_INTERVAL_MILLIS));
    }
  });

  /** Cap check, child creation, and turn start — serialized via the gate. */
  const prepareDelegate = Effect.fn("DelegateCoordinator.prepareDelegate")(function* (
    scope: McpInvocationScope,
    input: DelegateTaskInput,
  ) {
    const callerShell = yield* snapshotQuery
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError(dispatchFailed("read calling thread")));
    if (Option.isNone(callerShell)) {
      return yield* new DelegateError({
        reason: "caller-thread-not-found",
        description: "The calling session's thread no longer exists; cannot delegate from it.",
      });
    }
    const caller = callerShell.value;
    if (caller.parentThreadId !== null) {
      return yield* new DelegateError({
        reason: "depth-limit-exceeded",
        description:
          "Delegated agents cannot delegate further. Do the work in this session instead.",
      });
    }

    yield* refreshRecords(scope.threadId);
    const snapshot = yield* SynchronizedRef.get(records);
    const runningForParent = [...snapshot.values()].filter(
      (record) => record.parentThreadId === scope.threadId && record.status === "running",
    ).length;
    // Advisor threads get a user-configured per-thread cap (the executor
    // slider); every other thread uses the global per-parent cap.
    const maxChildrenForCaller =
      caller.interactionMode === "advisor"
        ? caller.executorMaxSubAgents
        : DELEGATE_MAX_CHILDREN_PER_PARENT;
    if (runningForParent >= maxChildrenForCaller) {
      return yield* new DelegateError({
        reason: "concurrency-limit-exceeded",
        description: `This session already has ${runningForParent} delegated agents running (max ${maxChildrenForCaller}). Wait for one to finish before delegating more.`,
      });
    }
    const runningTotal = [...snapshot.values()].filter(
      (record) => record.status === "running",
    ).length;
    if (runningTotal >= DELEGATE_MAX_RUNNING_SERVER_WIDE) {
      return yield* new DelegateError({
        reason: "concurrency-limit-exceeded",
        description: `The server already has ${runningTotal} delegated agents running (max ${DELEGATE_MAX_RUNNING_SERVER_WIDE}). Try again after one finishes.`,
      });
    }

    const createdAt = yield* nowIso;
    const commandUuid = yield* randomUuid;
    const threadUuid = yield* randomUuid;
    const childThreadId = ThreadId.make(threadUuid);
    const taskId = RuntimeTaskId.make(`delegate:${threadUuid}`);
    const title = resolveTitle(input);
    const parentTurnId = yield* readParentTurnId(scope.threadId);

    // Advisor threads with an executor model configured delegate on that
    // model instead of their own. The child still runs with
    // `interactionMode: "default"` and the parent's stored runtime mode, and
    // `parentThreadId` structurally bars it from delegating further — advisor
    // sub-agents are pure executors.
    const executorSelection =
      caller.interactionMode === "advisor" ? caller.executorModelSelection : null;
    const childModelSelection = executorSelection ?? caller.modelSelection;

    const providers = yield* providerRegistry.getProviders.pipe(
      Effect.orElseSucceed(() => [] as const),
    );
    const provider = providers.find(
      (candidate) => candidate.instanceId === childModelSelection.instanceId,
    );
    const effortOption = childModelSelection.options?.find(
      (option) => EFFORT_OPTION_IDS.has(option.id) && typeof option.value === "string",
    );
    const record: DelegateRecord = {
      parentThreadId: scope.threadId,
      taskId,
      title,
      model: childModelSelection.model,
      effort: typeof effortOption?.value === "string" ? effortOption.value : undefined,
      providerLabel: provider?.displayName ?? provider?.driver ?? childModelSelection.instanceId,
      parentTurnId,
      lastTurnRequestedAt: createdAt,
      status: "running",
    };

    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`server:delegate-create:${commandUuid}`),
        threadId: childThreadId,
        projectId: caller.projectId,
        title,
        modelSelection: childModelSelection,
        runtimeMode: caller.runtimeMode,
        interactionMode: "default",
        branch: caller.branch,
        worktreePath: caller.worktreePath,
        parentThreadId: scope.threadId,
        createdAt,
      })
      .pipe(Effect.mapError(dispatchFailed("create delegated thread")));

    const turnCommandUuid = yield* randomUuid;
    const messageUuid = yield* randomUuid;
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:delegate-turn:${turnCommandUuid}`),
        threadId: childThreadId,
        message: {
          messageId: MessageId.make(messageUuid),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        runtimeMode: caller.runtimeMode,
        interactionMode: "default",
        createdAt,
      })
      .pipe(Effect.mapError(dispatchFailed("start delegated turn")));

    yield* SynchronizedRef.update(records, (current) => {
      const next = new Map(current);
      next.set(childThreadId, record);
      return next;
    });
    yield* emitTaskStarted(record, childThreadId).pipe(Effect.catch(() => Effect.void));

    return [childThreadId, record] as const;
  });

  const delegate: DelegateCoordinatorShape["delegate"] = (scope, input) =>
    delegateGate
      .withPermits(1)(prepareDelegate(scope, input))
      .pipe(Effect.map(([childThreadId, record]) => runningResult(record, childThreadId)));

  const recoverRecord = Effect.fn("DelegateCoordinator.recoverRecord")(function* (
    scope: McpInvocationScope,
    taskId: string,
  ) {
    if (!taskId.startsWith("delegate:")) return null;
    const childThreadId = ThreadId.make(taskId.slice("delegate:".length));
    const detail = yield* snapshotQuery
      .getThreadDetailById(childThreadId)
      .pipe(Effect.mapError(dispatchFailed("recover delegated thread state")));
    if (Option.isNone(detail) || detail.value.parentThreadId !== scope.threadId) return null;

    const thread = detail.value;
    const effortOption = thread.modelSelection.options?.find(
      (option) => EFFORT_OPTION_IDS.has(option.id) && typeof option.value === "string",
    );
    const record: DelegateRecord = {
      parentThreadId: scope.threadId,
      taskId: RuntimeTaskId.make(taskId),
      title: thread.title,
      model: thread.modelSelection.model,
      effort: typeof effortOption?.value === "string" ? effortOption.value : undefined,
      providerLabel: thread.modelSelection.instanceId,
      parentTurnId: null,
      lastTurnRequestedAt: thread.latestTurn?.requestedAt ?? thread.createdAt,
      // Reconciliation claims the real terminal state atomically and mirrors
      // completion into the parent even when this record was rebuilt after a
      // server restart.
      status: "running",
    };
    yield* SynchronizedRef.update(records, (current) => {
      const next = new Map(current);
      next.set(childThreadId, record);
      return next;
    });
    return [childThreadId, record] as const;
  });

  const waitForDelegate: DelegateCoordinatorShape["waitForDelegate"] = Effect.fn(
    "DelegateCoordinator.waitForDelegate",
  )(function* (scope, input) {
    const snapshot = yield* SynchronizedRef.get(records);
    const entry =
      [...snapshot.entries()].find(([, record]) => record.taskId === input.taskId) ??
      (yield* recoverRecord(scope, input.taskId));
    if (!entry || entry[1].parentThreadId !== scope.threadId) {
      return yield* new DelegateError({
        reason: "task-not-found",
        description: `No delegated task '${input.taskId}' belongs to this session.`,
      });
    }
    const [childThreadId, record] = entry;
    return yield* awaitCompletion(
      childThreadId,
      record,
      input.waitSeconds ?? DEFAULT_STATUS_WAIT_SECONDS,
    );
  });

  // This fiber belongs to the coordinator layer (server lifetime), not to an
  // individual MCP request. It is the durable bridge from real child-thread
  // state to the parent timeline when a provider disconnects or times out.
  yield* Effect.gen(function* () {
    while (true) {
      const snapshot = yield* SynchronizedRef.get(records);
      for (const [childThreadId, record] of snapshot) {
        if (record.status !== "running") continue;
        const current = (yield* SynchronizedRef.get(records)).get(childThreadId) ?? record;
        yield* observeDelegate(childThreadId, current).pipe(Effect.catch(() => Effect.void));
      }
      yield* Effect.sleep(Duration.millis(RECONCILE_INTERVAL_MILLIS));
    }
  }).pipe(Effect.forkScoped);

  return DelegateCoordinator.of({ delegate, waitForDelegate });
});

export const DelegateCoordinatorLive = Layer.effect(DelegateCoordinator, makeDelegateCoordinator);

/** Exposed for tests. */
export const __testing = {
  make: makeDelegateCoordinator,
  resolveTitle,
  DEFAULT_STATUS_WAIT_SECONDS,
  WAIT_POLL_INTERVAL_MILLIS,
};
