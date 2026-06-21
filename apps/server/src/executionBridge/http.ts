// @effect-diagnostics globalFetchInEffect:off
// @effect-diagnostics preferSchemaOverJson:off

import {
  type ExecutionRunActivityEvent,
  type ExecutionRunLifecycleEvent,
  MessageId,
  type TaskRuntimeAssistantMessageEvent,
  type TaskRuntimeUserInputRequestEvent,
  ExecutionRunContinueRequest,
  ExecutionRunCreateRequest,
  ExecutionRunInterruptRequest,
  ExecutionRunStatusQuery,
  TaskRuntimeMaterializeRequest,
  TaskRuntimeUserInputRespondRequest,
  type OrchestrationEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { setTimeout as sleep } from "node:timers/promises";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { authenticateExecutionBridgeRequest, ExecutionBridgeAuthError } from "./routeAuth.ts";
import {
  buildLifecycleEvent,
  buildTaskRuntimeLifecycleEvent,
  continueExecutionRun,
  ExecutionBridgeRunRegistry,
  ExecutionBridgeRunStartError,
  interruptExecutionRun,
  materializeTaskRuntime,
  respondToTaskRuntimeUserInput,
  startExecutionRun,
  type ExecutionLifecycleCheckpoint,
  type TrackedExecutionRun,
} from "./runStart.ts";

function readExecutionBridgeCallbackConfig() {
  const baseUrl = process.env.ORCHESTRATOR_BASE_URL?.trim();
  const sharedSecret = process.env.T3_EXECUTION_BRIDGE_SHARED_SECRET?.trim();
  if (!baseUrl || !sharedSecret) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    sharedSecret,
  };
}

class ExecutionBridgeCallbackError extends Schema.TaggedErrorClass<ExecutionBridgeCallbackError>()(
  "ExecutionBridgeCallbackError",
  {
    message: Schema.String,
  },
) {}

function postToOrchestrator(path: string, body: unknown) {
  return Effect.tryPromise({
    try: async () => {
      const config = readExecutionBridgeCallbackConfig();
      if (config === null) {
        return;
      }

      const maxAttempts = 4;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await fetch(`${config.baseUrl}${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.sharedSecret}`,
            },
            body: JSON.stringify(body),
          });
        } catch (error) {
          lastError = error;
          if (attempt === maxAttempts) {
            throw error;
          }
          await sleep(250 * 2 ** (attempt - 1));
          continue;
        }

        if (response.ok) {
          return;
        }

        const detail = await response.text();
        const error = new Error(
          `Execution bridge callback rejected (${response.status}): ${detail || "Unknown error"}`,
        );
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;

        await sleep(250 * 2 ** (attempt - 1));
      }
      throw lastError;
    },
    catch: (error) =>
      new ExecutionBridgeCallbackError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });
}

const postLifecycleEvent = (event: ExecutionRunLifecycleEvent) =>
  postToOrchestrator("/t3/execution-events", event);

const postActivityEvent = (event: ExecutionRunActivityEvent) =>
  postToOrchestrator("/t3/execution-activities", event);

const postTaskRuntimeLifecycleEvent = (event: ReturnType<typeof buildTaskRuntimeLifecycleEvent>) =>
  postToOrchestrator("/t3/task-runtime-events", event);

const postTaskRuntimeAssistantMessageEvent = (event: TaskRuntimeAssistantMessageEvent) =>
  postToOrchestrator("/t3/task-runtime-assistant-messages", event);

const postTaskRuntimeAssistantMessageObservationEvent = (event: TaskRuntimeAssistantMessageEvent) =>
  postToOrchestrator("/t3/task-runtime-assistant-message-observations", event);

const postTaskRuntimeUserInputRequestEvent = (event: TaskRuntimeUserInputRequestEvent) =>
  postToOrchestrator("/t3/task-runtime-user-input-requests", event);

const MAX_LIFECYCLE_ASSISTANT_RESPONSE_CHARS = 12_000;

interface AssistantResponseCacheEntry {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly text: string;
}

interface FirstAssistantRelayEntry {
  readonly messageId: string;
  readonly text: string;
}

interface FinalAssistantRelayEntry {
  readonly messageId: string;
  readonly text: string;
}

const FINAL_ASSISTANT_RELAY_RETRY_DELAYS = [
  "500 millis",
  "2 seconds",
  "5 seconds",
  "10 seconds",
] as const;

function normalizeAssistantResponse(text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length <= MAX_LIFECYCLE_ASSISTANT_RESPONSE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_LIFECYCLE_ASSISTANT_RESPONSE_CHARS).trimEnd()}\n\n[Response truncated for intake reply.]`;
}

export function cacheAssistantMessageForLifecycle(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
}) {
  const { cache, event } = input;
  if (event.payload.role !== "assistant") {
    return;
  }

  const response = normalizeAssistantResponse(event.payload.text);
  if (response === undefined) {
    return;
  }

  const threadKey = String(event.payload.threadId);
  const existing = cache.get(threadKey) ?? [];
  const nextEntry: AssistantResponseCacheEntry = {
    messageId: String(event.payload.messageId),
    turnId: event.payload.turnId === null ? null : String(event.payload.turnId),
    text: response,
  };
  const next = existing.some((entry) => entry.messageId === nextEntry.messageId)
    ? existing.map((entry) => (entry.messageId === nextEntry.messageId ? nextEntry : entry))
    : [...existing, nextEntry];
  cache.set(threadKey, next.slice(-20));
}

export function readCachedAssistantResponse(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly assistantMessageId?: string | null;
}) {
  return readCachedAssistantResponseEntry(input)?.text;
}

function readCachedAssistantResponseEntry(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly assistantMessageId?: string | null;
}) {
  const entries = input.cache.get(String(input.threadId)) ?? [];
  if (input.assistantMessageId !== undefined && input.assistantMessageId !== null) {
    const byMessage = entries.find((entry) => entry.messageId === String(input.assistantMessageId));
    if (byMessage !== undefined) {
      return byMessage;
    }
  }
  if (input.turnId !== undefined) {
    const byTurn = entries.findLast((entry) => entry.turnId === String(input.turnId));
    if (byTurn !== undefined) {
      return byTurn;
    }
  }
  return undefined;
}

function resolveAssistantResponseEntry(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly assistantMessageId?: string | null;
}) {
  const cached = readCachedAssistantResponseEntry(input);
  if (cached !== undefined) {
    return Effect.succeed(cached);
  }

  return Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
    if (Option.isNone(thread)) {
      return undefined;
    }

    if (input.assistantMessageId !== undefined && input.assistantMessageId !== null) {
      const byMessage = thread.value.messages.find(
        (message) => String(message.id) === String(input.assistantMessageId),
      );
      if (byMessage !== undefined) {
        const text = normalizeAssistantResponse(byMessage.text);
        return text === undefined
          ? undefined
          : {
              messageId: String(byMessage.id),
              turnId: byMessage.turnId === null ? null : String(byMessage.turnId),
              text,
            };
      }
    }

    if (input.turnId !== undefined) {
      const byTurn = thread.value.messages.findLast(
        (message) =>
          message.role === "assistant" && String(message.turnId) === String(input.turnId),
      );
      if (byTurn !== undefined) {
        const text = normalizeAssistantResponse(byTurn.text);
        return text === undefined
          ? undefined
          : {
              messageId: String(byTurn.id),
              turnId: byTurn.turnId === null ? null : String(byTurn.turnId),
              text,
            };
      }
    }

    return undefined;
  }).pipe(Effect.catch(() => Effect.sync(() => undefined)));
}

function firstAssistantMessageTurnKey(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}) {
  return `${String(input.threadId)}:${String(input.turnId)}`;
}

export function shouldRelayFinalAssistantResponse(input: {
  readonly firstRelay?: FirstAssistantRelayEntry;
  readonly finalRelay?: FinalAssistantRelayEntry;
  readonly finalResponse?: AssistantResponseCacheEntry;
}) {
  if (input.finalResponse === undefined) {
    return false;
  }
  if (input.finalRelay !== undefined) {
    return false;
  }
  if (input.firstRelay === undefined) {
    return true;
  }
  if (input.firstRelay.text === input.finalResponse.text) {
    return false;
  }
  return true;
}

function postTaskRuntimeAssistantMessageObservation(input: {
  readonly event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
  readonly trackedRun: TrackedExecutionRun;
}) {
  const { event, trackedRun } = input;
  if (
    trackedRun.kind !== "task" ||
    trackedRun.taskId === null ||
    trackedRun.workSessionId === null ||
    event.payload.role !== "assistant"
  ) {
    return Effect.void;
  }

  const assistantMessage = event.payload.text.trim();
  if (!assistantMessage) {
    return Effect.void;
  }

  return postTaskRuntimeAssistantMessageObservationEvent({
    eventId: `${String(event.eventId)}:assistant-observed`,
    taskId: trackedRun.taskId,
    workSessionId: trackedRun.workSessionId,
    occurredAt: event.occurredAt,
    t3ThreadId: trackedRun.threadId,
    t3MessageId: event.payload.messageId,
    ...(event.payload.turnId !== null ? { t3TurnId: event.payload.turnId } : {}),
    assistantMessage,
  }).pipe(
    Effect.catch((error: Error) =>
      Effect.logWarning("execution bridge failed to forward assistant message observation", {
        eventId: String(event.eventId),
        threadId: String(trackedRun.threadId),
        message: error.message,
      }),
    ),
  );
}

function postFirstTaskRuntimeAssistantMessage(input: {
  readonly event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
  readonly trackedRun: TrackedExecutionRun;
  readonly forwardedTurnKeys: Map<string, FirstAssistantRelayEntry>;
}) {
  const { event, forwardedTurnKeys, trackedRun } = input;
  if (
    trackedRun.kind !== "task" ||
    trackedRun.taskId === null ||
    trackedRun.workSessionId === null ||
    event.payload.role !== "assistant" ||
    event.payload.turnId === null
  ) {
    return Effect.void;
  }

  const assistantResponse = normalizeAssistantResponse(event.payload.text);
  if (assistantResponse === undefined) {
    return Effect.void;
  }

  const turnKey = firstAssistantMessageTurnKey({
    threadId: event.payload.threadId,
    turnId: event.payload.turnId,
  });
  if (forwardedTurnKeys.has(turnKey)) {
    return Effect.void;
  }

  return postTaskRuntimeAssistantMessageEvent({
    eventId: `${String(event.eventId)}:assistant-first`,
    taskId: trackedRun.taskId,
    workSessionId: trackedRun.workSessionId,
    occurredAt: event.occurredAt,
    t3ThreadId: trackedRun.threadId,
    t3MessageId: event.payload.messageId,
    t3TurnId: event.payload.turnId,
    assistantMessage: assistantResponse,
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        forwardedTurnKeys.set(turnKey, {
          messageId: String(event.payload.messageId),
          text: assistantResponse,
        });
      }),
    ),
    Effect.catch((error: Error) =>
      Effect.logWarning("execution bridge failed to forward first assistant message", {
        eventId: String(event.eventId),
        threadId: String(trackedRun.threadId),
        message: error.message,
      }),
    ),
  );
}

function postFinalTaskRuntimeAssistantMessage(input: {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly trackedRun: TrackedExecutionRun;
  readonly assistantMessageId?: string | null;
  readonly turnId?: TurnId;
  readonly assistantResponse?: string;
}): Effect.Effect<boolean, never, never> {
  if (
    input.trackedRun.taskId === null ||
    input.trackedRun.workSessionId === null ||
    input.assistantResponse === undefined
  ) {
    return Effect.succeed(false);
  }

  return postTaskRuntimeAssistantMessageEvent({
    eventId: input.eventId,
    taskId: input.trackedRun.taskId,
    workSessionId: input.trackedRun.workSessionId,
    occurredAt: input.occurredAt,
    t3ThreadId: input.trackedRun.threadId,
    t3MessageId:
      input.assistantMessageId !== undefined && input.assistantMessageId !== null
        ? MessageId.make(input.assistantMessageId)
        : MessageId.make(`final-response:${input.eventId}`),
    ...(input.turnId !== undefined ? { t3TurnId: input.turnId } : {}),
    assistantMessage: input.assistantResponse,
  }).pipe(
    Effect.as(true),
    Effect.catch((error: Error) =>
      Effect.logWarning("execution bridge failed to forward final assistant message", {
        eventId: input.eventId,
        threadId: String(input.trackedRun.threadId),
        message: error.message,
      }).pipe(Effect.as(false)),
    ),
  );
}

function postResolvedFinalTaskRuntimeAssistantMessage(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly trackedRun: TrackedExecutionRun;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly turnId?: TurnId;
  readonly firstRelays: Map<string, FirstAssistantRelayEntry>;
  readonly finalRelays: Map<string, FinalAssistantRelayEntry>;
  readonly finalRelayMutex: Semaphore.Semaphore;
}) {
  if (input.trackedRun.kind !== "task" || input.turnId === undefined) {
    return Effect.succeed(false);
  }
  const turnId = input.turnId;

  const turnKey = firstAssistantMessageTurnKey({
    threadId: input.trackedRun.threadId,
    turnId,
  });

  return Effect.gen(function* () {
    const assistantResponseEntry = yield* resolveAssistantResponseEntry({
      cache: input.cache,
      threadId: input.trackedRun.threadId,
      turnId,
    });
    const firstRelay = input.firstRelays.get(turnKey);
    const finalRelay = input.finalRelays.get(turnKey);
    const shouldRelayFinal = shouldRelayFinalAssistantResponse({
      ...(firstRelay !== undefined ? { firstRelay } : {}),
      ...(finalRelay !== undefined ? { finalRelay } : {}),
      ...(assistantResponseEntry !== undefined ? { finalResponse: assistantResponseEntry } : {}),
    });
    if (!shouldRelayFinal || assistantResponseEntry === undefined) {
      return false;
    }

    const delivered = yield* postFinalTaskRuntimeAssistantMessage({
      eventId: input.eventId,
      occurredAt: input.occurredAt,
      trackedRun: input.trackedRun,
      turnId,
      assistantMessageId: assistantResponseEntry.messageId,
      assistantResponse: assistantResponseEntry.text,
    });
    if (!delivered) {
      return false;
    }
    input.finalRelays.set(turnKey, {
      messageId: assistantResponseEntry.messageId,
      text: assistantResponseEntry.text,
    });
    return true;
  }).pipe(input.finalRelayMutex.withPermits(1));
}

function scheduleFinalTaskRuntimeAssistantMessageRetries(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly getTrackedRun: (
    threadId: ThreadId,
  ) => Effect.Effect<TrackedExecutionRun | null, never, never>;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly completionEventId: string;
  readonly occurredAt: string;
  readonly firstRelays: Map<string, FirstAssistantRelayEntry>;
  readonly finalRelays: Map<string, FinalAssistantRelayEntry>;
  readonly finalRelayMutex: Semaphore.Semaphore;
}) {
  if (input.turnId === undefined) {
    return Effect.void;
  }
  const turnId = input.turnId;

  return Effect.gen(function* () {
    for (let index = 0; index < FINAL_ASSISTANT_RELAY_RETRY_DELAYS.length; index += 1) {
      yield* Effect.sleep(FINAL_ASSISTANT_RELAY_RETRY_DELAYS[index]!);
      const latestTrackedRun = yield* input.getTrackedRun(input.threadId);
      if (latestTrackedRun === null || latestTrackedRun.kind !== "task") {
        return;
      }

      const relayed = yield* postResolvedFinalTaskRuntimeAssistantMessage({
        cache: input.cache,
        trackedRun: latestTrackedRun,
        eventId: `${input.completionEventId}:assistant-final`,
        occurredAt: input.occurredAt,
        turnId,
        firstRelays: input.firstRelays,
        finalRelays: input.finalRelays,
        finalRelayMutex: input.finalRelayMutex,
      });
      if (relayed) {
        return;
      }
    }
  }).pipe(Effect.forkScoped, Effect.asVoid);
}

function toLifecycleCheckpoint(
  event: Extract<OrchestrationEvent, { type: "thread.session-set" }>,
): {
  readonly type: ExecutionLifecycleCheckpoint;
  readonly turnId?: NonNullable<typeof event.payload.session.activeTurnId>;
  readonly failureSummary?: string;
} | null {
  if (event.payload.session.status === "running" && event.payload.session.activeTurnId !== null) {
    return {
      type: "started",
      turnId: event.payload.session.activeTurnId,
    };
  }
  if (event.payload.session.status === "stopped" && event.payload.session.lastError !== null) {
    return {
      type: "failed",
      failureSummary: event.payload.session.lastError,
    };
  }
  if (event.payload.session.status === "ready" || event.payload.session.status === "stopped") {
    return {
      type: "completed",
    };
  }
  if (event.payload.session.status === "error") {
    return {
      type: "failed",
      failureSummary: event.payload.session.lastError ?? "Execution run failed.",
    };
  }
  if (event.payload.session.status === "interrupted") {
    return {
      type: "interrupted",
    };
  }
  return null;
}

function hasLifecycleAlreadyBeenDelivered(input: {
  readonly type: ExecutionLifecycleCheckpoint;
  readonly trackedRun: TrackedExecutionRun;
}) {
  switch (input.type) {
    case "started":
      return input.trackedRun.startedEventId !== null;
    case "completed":
      return input.trackedRun.completedEventId !== null;
    case "failed":
      return input.trackedRun.failedEventId !== null;
    case "interrupted":
      return input.trackedRun.interruptedEventId !== null;
  }
}

export function shouldForwardLifecycleCheckpoint(input: {
  readonly type: ExecutionLifecycleCheckpoint;
  readonly trackedRun: TrackedExecutionRun;
  readonly turnId?: TurnId;
}) {
  if (
    input.trackedRun.kind === "task" &&
    input.type === "completed" &&
    input.turnId === undefined &&
    input.trackedRun.lastTurnId === null
  ) {
    return false;
  }

  if (hasLifecycleAlreadyBeenDelivered(input)) {
    return false;
  }

  return true;
}

const respondToExecutionBridgeError = (
  error: ExecutionBridgeAuthError | ExecutionBridgeRunStartError,
) => HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status });

export const executionBridgeRunCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/execution/runs",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const request = yield* HttpServerRequest.schemaBodyJson(ExecutionRunCreateRequest);
    const result = yield* startExecutionRun(request);
    return HttpServerResponse.jsonUnsafe(result, { status: 202 });
  }).pipe(
    Effect.catchTags({
      ExecutionBridgeAuthError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
      ExecutionBridgeRunStartError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
    }),
  ),
);

export const taskRuntimeMaterializeRouteLayer = HttpRouter.add(
  "POST",
  "/api/tasks/materialize",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const request = yield* HttpServerRequest.schemaBodyJson(TaskRuntimeMaterializeRequest);
    const result = yield* materializeTaskRuntime(request);
    return HttpServerResponse.jsonUnsafe(result, { status: 202 });
  }).pipe(
    Effect.catchTags({
      ExecutionBridgeAuthError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
      ExecutionBridgeRunStartError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
    }),
  ),
);

export const executionBridgeStatusQueryRouteLayer = HttpRouter.add(
  "POST",
  "/api/execution/runs/status",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const query = yield* HttpServerRequest.schemaBodyJson(ExecutionRunStatusQuery);
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const thread = yield* projectionSnapshotQuery.getThreadDetailById(query.t3ThreadId);

    if (Option.isNone(thread)) {
      return HttpServerResponse.jsonUnsafe(
        {
          executionRunId: query.executionRunId,
          t3ThreadId: query.t3ThreadId,
          sessionStatus: "unknown",
          activeTurnId: null,
          lastError: null,
          found: false,
        },
        { status: 200 },
      );
    }

    return HttpServerResponse.jsonUnsafe(
      {
        executionRunId: query.executionRunId,
        t3ThreadId: query.t3ThreadId,
        sessionStatus: thread.value.session?.status ?? "unknown",
        activeTurnId: thread.value.session?.activeTurnId ?? null,
        lastError: thread.value.session?.lastError ?? null,
        found: true,
      },
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("ExecutionBridgeAuthError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
  ),
);

export const executionBridgeContinueRouteLayer = HttpRouter.add(
  "POST",
  "/api/execution/runs/continue",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const request = yield* HttpServerRequest.schemaBodyJson(ExecutionRunContinueRequest);
    const result = yield* continueExecutionRun(request);
    return HttpServerResponse.jsonUnsafe(result, { status: 202 });
  }).pipe(
    Effect.catchTags({
      ExecutionBridgeAuthError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
      ExecutionBridgeRunStartError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
    }),
  ),
);

export const executionBridgeInterruptRouteLayer = HttpRouter.add(
  "POST",
  "/api/execution/runs/interrupt",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const request = yield* HttpServerRequest.schemaBodyJson(ExecutionRunInterruptRequest);
    const result = yield* interruptExecutionRun(request);
    return HttpServerResponse.jsonUnsafe(result, { status: 202 });
  }).pipe(
    Effect.catchTags({
      ExecutionBridgeAuthError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
      ExecutionBridgeRunStartError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
    }),
  ),
);

export const taskRuntimeUserInputRespondRouteLayer = HttpRouter.add(
  "POST",
  "/api/tasks/user-input/respond",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const request = yield* HttpServerRequest.schemaBodyJson(TaskRuntimeUserInputRespondRequest);
    const result = yield* respondToTaskRuntimeUserInput(request);
    return HttpServerResponse.jsonUnsafe(result, { status: 202 });
  }).pipe(
    Effect.catchTags({
      ExecutionBridgeAuthError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
      ExecutionBridgeRunStartError: (error) => Effect.succeed(respondToExecutionBridgeError(error)),
    }),
  ),
);

function toActivityEvent(
  event: Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
  trackedRun: TrackedExecutionRun,
): ExecutionRunActivityEvent | null {
  const { activity } = event.payload;
  const tone = activity.tone as string;

  if (tone === "tool") {
    return {
      eventId: event.eventId,
      controlThreadId: trackedRun.controlThreadId,
      executionRunId: trackedRun.executionRunId,
      activity: {
        type: "action",
        action: activity.kind,
        parameter: activity.summary,
        ephemeral: true,
      },
      occurredAt: event.occurredAt,
    };
  }

  if (tone === "info") {
    return {
      eventId: event.eventId,
      controlThreadId: trackedRun.controlThreadId,
      executionRunId: trackedRun.executionRunId,
      activity: {
        type: "thought",
        body: activity.summary,
      },
      occurredAt: event.occurredAt,
    };
  }

  if (tone === "error") {
    return {
      eventId: event.eventId,
      controlThreadId: trackedRun.controlThreadId,
      executionRunId: trackedRun.executionRunId,
      activity: {
        type: "error",
        body: activity.summary,
      },
      occurredAt: event.occurredAt,
    };
  }

  return null;
}

function toTaskRuntimeUserInputRequestEvent(
  event: Extract<OrchestrationEvent, { type: "thread.activity-appended" }>,
  trackedRun: TrackedExecutionRun,
): TaskRuntimeUserInputRequestEvent | null {
  if (
    trackedRun.kind !== "task" ||
    trackedRun.taskId === null ||
    trackedRun.workSessionId === null
  ) {
    return null;
  }

  const { activity } = event.payload;
  if (activity.kind !== "user-input.requested") {
    return null;
  }
  const payload =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : null;
  const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
  const questions = Array.isArray(payload?.questions) ? payload.questions : null;
  if (requestId === null || questions === null) {
    return null;
  }

  return {
    eventId: event.eventId,
    taskId: trackedRun.taskId,
    workSessionId: trackedRun.workSessionId,
    occurredAt: event.occurredAt,
    t3ThreadId: trackedRun.threadId,
    ...(activity.turnId !== null ? { t3TurnId: activity.turnId } : {}),
    requestId,
    questions,
  } as unknown as TaskRuntimeUserInputRequestEvent;
}

export const executionBridgeLifecycleCallbacksLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const callbackConfig = readExecutionBridgeCallbackConfig();
    if (callbackConfig === null) {
      yield* Effect.logDebug(
        "execution bridge lifecycle callbacks disabled until ORCHESTRATOR_BASE_URL and T3_EXECUTION_BRIDGE_SHARED_SECRET are configured",
      );
      return;
    }

    const orchestrationEngine = yield* OrchestrationEngineService;
    const runRegistry = yield* ExecutionBridgeRunRegistry;
    const assistantResponseCache = new Map<string, AssistantResponseCacheEntry[]>();
    const firstAssistantMessageTurnKeys = new Map<string, FirstAssistantRelayEntry>();
    const finalAssistantMessageTurnKeys = new Map<string, FinalAssistantRelayEntry>();
    const finalAssistantMessageRelayMutex = yield* Semaphore.make(1);

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.message-sent") {
          cacheAssistantMessageForLifecycle({
            cache: assistantResponseCache,
            event,
          });
          return Effect.gen(function* () {
            const trackedRun = yield* runRegistry.getTrackedRun(event.payload.threadId);
            if (trackedRun === null) {
              return;
            }
            yield* postTaskRuntimeAssistantMessageObservation({
              event,
              trackedRun,
            });
            yield* postFirstTaskRuntimeAssistantMessage({
              event,
              trackedRun,
              forwardedTurnKeys: firstAssistantMessageTurnKeys,
            });
            if (
              trackedRun.kind === "task" &&
              event.payload.role === "assistant" &&
              event.payload.turnId !== null
            ) {
              yield* runRegistry.markLifecycleDelivered({
                threadId: trackedRun.threadId,
                type: "started",
                eventId: `${String(event.eventId)}:assistant-turn-observed`,
                turnId: event.payload.turnId,
              });
            }
            if (
              trackedRun.kind === "task" &&
              trackedRun.completedEventId !== null &&
              event.payload.role === "assistant" &&
              event.payload.turnId !== null
            ) {
              yield* postResolvedFinalTaskRuntimeAssistantMessage({
                cache: assistantResponseCache,
                trackedRun,
                eventId: `${String(event.eventId)}:assistant-final`,
                occurredAt: event.occurredAt,
                turnId: event.payload.turnId,
                firstRelays: firstAssistantMessageTurnKeys,
                finalRelays: finalAssistantMessageTurnKeys,
                finalRelayMutex: finalAssistantMessageRelayMutex,
              });
            }
          });
        }

        if (event.type === "thread.activity-appended") {
          return Effect.gen(function* () {
            const trackedRun = yield* runRegistry.getTrackedRun(event.payload.threadId);
            if (trackedRun === null) {
              return;
            }

            if (trackedRun.kind === "task") {
              const userInputRequest = toTaskRuntimeUserInputRequestEvent(event, trackedRun);
              if (userInputRequest !== null) {
                yield* postTaskRuntimeUserInputRequestEvent(userInputRequest);
              }
              return;
            }

            const activityPayload = toActivityEvent(event, trackedRun);
            if (activityPayload === null) {
              return;
            }

            yield* postActivityEvent(activityPayload);
          }).pipe(
            Effect.catch((error: Error) =>
              Effect.logWarning("execution bridge failed to forward activity event", {
                eventId: event.eventId,
                threadId: String(event.payload.threadId),
                message: error.message,
              }),
            ),
          );
        }

        if (event.type === "thread.turn-diff-completed") {
          return Effect.gen(function* () {
            const trackedRun = yield* runRegistry.getTrackedRun(event.payload.threadId);
            if (trackedRun === null) {
              return;
            }
            if (trackedRun.kind === "task") {
              // Checkpoint diff completion can reference a non-final assistant message.
              // Task runtimes relay their final response when the provider session returns to ready.
              return;
            }
            const lifecycle = {
              type: "completed" as const,
              turnId: event.payload.turnId,
            };
            if (
              !shouldForwardLifecycleCheckpoint({
                type: lifecycle.type,
                trackedRun,
                turnId: lifecycle.turnId,
              })
            ) {
              return;
            }

            const payload = buildLifecycleEvent({
              trackedRun,
              type: lifecycle.type,
              eventId: event.eventId,
              occurredAt: event.occurredAt,
              t3TurnId: lifecycle.turnId,
            });
            yield* postLifecycleEvent(payload);

            yield* runRegistry.markLifecycleDelivered({
              threadId: trackedRun.threadId,
              type: lifecycle.type,
              eventId: event.eventId,
              turnId: lifecycle.turnId,
            });
          }).pipe(
            Effect.catch((error: Error) =>
              Effect.logWarning("execution bridge failed to forward lifecycle event", {
                eventId: event.eventId,
                threadId: String(event.payload.threadId),
                message: error.message,
              }),
            ),
          );
        }

        if (event.type !== "thread.session-set") {
          return Effect.void;
        }

        return Effect.gen(function* () {
          const trackedRun = yield* runRegistry.getTrackedRun(event.payload.threadId);
          if (trackedRun === null) {
            return;
          }

          const lifecycle = toLifecycleCheckpoint(event);
          if (lifecycle === null) {
            return;
          }
          if (
            !shouldForwardLifecycleCheckpoint({
              type: lifecycle.type,
              trackedRun,
              ...(lifecycle.turnId !== undefined ? { turnId: lifecycle.turnId } : {}),
            })
          ) {
            return;
          }

          if (trackedRun.kind === "task") {
            const completedTurnId =
              lifecycle.type === "completed"
                ? (lifecycle.turnId ?? trackedRun.lastTurnId ?? undefined)
                : undefined;

            const immediateFinalResponseEntry =
              lifecycle.type === "completed" && completedTurnId !== undefined
                ? yield* resolveAssistantResponseEntry({
                    cache: assistantResponseCache,
                    threadId: event.payload.threadId,
                    turnId: completedTurnId,
                  })
                : undefined;
            const immediateFinalRelayed =
              lifecycle.type === "completed" && completedTurnId !== undefined
                ? yield* postResolvedFinalTaskRuntimeAssistantMessage({
                    cache: assistantResponseCache,
                    trackedRun,
                    eventId: `${String(event.eventId)}:assistant-final`,
                    occurredAt: event.occurredAt,
                    turnId: completedTurnId,
                    firstRelays: firstAssistantMessageTurnKeys,
                    finalRelays: finalAssistantMessageTurnKeys,
                    finalRelayMutex: finalAssistantMessageRelayMutex,
                  })
                : false;
            if (
              lifecycle.type === "completed" &&
              completedTurnId !== undefined &&
              !immediateFinalRelayed
            ) {
              yield* scheduleFinalTaskRuntimeAssistantMessageRetries({
                cache: assistantResponseCache,
                getTrackedRun: runRegistry.getTrackedRun,
                threadId: event.payload.threadId,
                turnId: completedTurnId,
                completionEventId: String(event.eventId),
                occurredAt: event.occurredAt,
                firstRelays: firstAssistantMessageTurnKeys,
                finalRelays: finalAssistantMessageTurnKeys,
                finalRelayMutex: finalAssistantMessageRelayMutex,
              });
            }
            const finalResponseForLifecycle =
              immediateFinalRelayed && immediateFinalResponseEntry !== undefined
                ? immediateFinalResponseEntry.text
                : undefined;
            const payload = buildTaskRuntimeLifecycleEvent({
              trackedRun,
              type: lifecycle.type,
              eventId: event.eventId,
              occurredAt: event.occurredAt,
              ...(completedTurnId !== undefined ? { t3TurnId: completedTurnId } : {}),
              ...(lifecycle.failureSummary !== undefined
                ? { failureSummary: lifecycle.failureSummary }
                : {}),
              ...(finalResponseForLifecycle !== undefined
                ? { assistantResponse: finalResponseForLifecycle }
                : {}),
            });
            yield* postTaskRuntimeLifecycleEvent(payload);
          } else {
            const payload = buildLifecycleEvent({
              trackedRun,
              type: lifecycle.type,
              eventId: event.eventId,
              occurredAt: event.occurredAt,
              ...(lifecycle.turnId !== undefined ? { t3TurnId: lifecycle.turnId } : {}),
              ...(lifecycle.failureSummary !== undefined
                ? { failureSummary: lifecycle.failureSummary }
                : {}),
            });
            yield* postLifecycleEvent(payload);
          }

          yield* runRegistry.markLifecycleDelivered({
            threadId: trackedRun.threadId,
            type: lifecycle.type,
            eventId: event.eventId,
            ...(lifecycle.turnId !== undefined
              ? { turnId: lifecycle.turnId }
              : trackedRun.kind === "task" &&
                  lifecycle.type === "completed" &&
                  trackedRun.lastTurnId !== null
                ? { turnId: trackedRun.lastTurnId }
                : {}),
          });
        }).pipe(
          Effect.catch((error: Error) =>
            Effect.logWarning("execution bridge failed to forward lifecycle event", {
              eventId: event.eventId,
              threadId: String(event.payload.threadId),
              message: error.message,
            }),
          ),
        );
      }),
    );
  }),
);
