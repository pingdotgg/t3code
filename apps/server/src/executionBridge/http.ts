import {
  type ExecutionRunActivityEvent,
  type ExecutionRunLifecycleEvent,
  type TaskRuntimeAssistantMessageEvent,
  type TaskRuntimeUserInputRequestEvent,
  ExecutionRunContinueRequest,
  ExecutionRunCreateRequest,
  ExecutionRunInterruptRequest,
  ExecutionRunStatusQuery,
  TaskPullRequestEnsureRequest,
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
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { authenticateExecutionBridgeRequest, ExecutionBridgeAuthError } from "./routeAuth.ts";
import {
  buildLifecycleEvent,
  buildTaskRuntimeLifecycleEvent,
  continueExecutionRun,
  ensureTaskPullRequest,
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

      const response = await fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.sharedSecret}`,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `Execution bridge callback rejected (${response.status}): ${detail || "Unknown error"}`,
        );
      }
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

const postTaskRuntimeUserInputRequestEvent = (event: TaskRuntimeUserInputRequestEvent) =>
  postToOrchestrator("/t3/task-runtime-user-input-requests", event);

const MAX_LIFECYCLE_ASSISTANT_RESPONSE_CHARS = 12_000;

interface AssistantResponseCacheEntry {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly text: string;
}

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

function cacheAssistantMessage(
  cache: Map<string, AssistantResponseCacheEntry[]>,
  event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>,
) {
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

export function collectCompletedAssistantMessage(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly event: Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
}) {
  const { cache, event } = input;
  cacheAssistantMessage(cache, event);
  if (event.payload.role !== "assistant" || event.payload.streaming) {
    return undefined;
  }

  return (
    normalizeAssistantResponse(event.payload.text) ??
    readCachedAssistantResponse({
      cache,
      threadId: event.payload.threadId,
      assistantMessageId: String(event.payload.messageId),
      ...(event.payload.turnId !== null ? { turnId: event.payload.turnId } : {}),
    })
  );
}

function readCachedAssistantResponse(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly assistantMessageId?: string | null;
}) {
  const entries = input.cache.get(String(input.threadId)) ?? [];
  if (input.assistantMessageId !== undefined && input.assistantMessageId !== null) {
    const byMessage = entries.find((entry) => entry.messageId === String(input.assistantMessageId));
    if (byMessage !== undefined) {
      return byMessage.text;
    }
  }
  if (input.turnId !== undefined) {
    const byTurn = entries.findLast((entry) => entry.turnId === String(input.turnId));
    if (byTurn !== undefined) {
      return byTurn.text;
    }
  }
  return entries.at(-1)?.text;
}

function resolveAssistantResponse(input: {
  readonly cache: Map<string, AssistantResponseCacheEntry[]>;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly assistantMessageId?: string | null;
}) {
  const cached = readCachedAssistantResponse(input);
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
        return normalizeAssistantResponse(byMessage.text);
      }
    }

    if (input.turnId !== undefined) {
      const byTurn = thread.value.messages.findLast(
        (message) =>
          message.role === "assistant" && String(message.turnId) === String(input.turnId),
      );
      if (byTurn !== undefined) {
        return normalizeAssistantResponse(byTurn.text);
      }
    }

    return normalizeAssistantResponse(
      thread.value.messages.findLast((message) => message.role === "assistant")?.text ?? "",
    );
  }).pipe(Effect.catch(() => Effect.void));
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
}) {
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
    Effect.catchTag("ExecutionBridgeAuthError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
    Effect.catchTag("ExecutionBridgeRunStartError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
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
    Effect.catchTag("ExecutionBridgeAuthError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
    Effect.catchTag("ExecutionBridgeRunStartError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
  ),
);

export const taskPullRequestEnsureRouteLayer = HttpRouter.add(
  "POST",
  "/api/tasks/pull-request/ensure",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const request = yield* HttpServerRequest.schemaBodyJson(TaskPullRequestEnsureRequest);
    const result = yield* ensureTaskPullRequest(request);
    return HttpServerResponse.jsonUnsafe(result, { status: 202 });
  }).pipe(
    Effect.catchTag("ExecutionBridgeAuthError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
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
    Effect.catchTag("ExecutionBridgeAuthError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
    Effect.catchTag("ExecutionBridgeRunStartError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
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
    Effect.catchTag("ExecutionBridgeAuthError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
    Effect.catchTag("ExecutionBridgeRunStartError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
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
    Effect.catchTag("ExecutionBridgeAuthError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
    Effect.catchTag("ExecutionBridgeRunStartError", (error) =>
      Effect.succeed(respondToExecutionBridgeError(error)),
    ),
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

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.message-sent") {
          const assistantMessage = collectCompletedAssistantMessage({
            cache: assistantResponseCache,
            event,
          });
          if (assistantMessage === undefined) {
            return Effect.void;
          }

          return Effect.gen(function* () {
            const trackedRun = yield* runRegistry.getTrackedRun(event.payload.threadId);
            if (trackedRun === null || trackedRun.kind !== "task") {
              return;
            }

            yield* postTaskRuntimeAssistantMessageEvent({
              eventId: event.eventId,
              taskId: trackedRun.taskId!,
              workSessionId: trackedRun.workSessionId!,
              occurredAt: event.occurredAt,
              t3ThreadId: trackedRun.threadId,
              t3MessageId: event.payload.messageId,
              ...(event.payload.turnId !== null ? { t3TurnId: event.payload.turnId } : {}),
              assistantMessage,
            });
          }).pipe(
            Effect.catch((error: Error) =>
              Effect.logWarning("execution bridge failed to forward assistant message event", {
                eventId: event.eventId,
                threadId: String(event.payload.threadId),
                message: error.message,
              }),
            ),
          );
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
            const lifecycle = {
              type: "completed" as const,
              turnId: event.payload.turnId,
            };
            if (
              !shouldForwardLifecycleCheckpoint({
                type: lifecycle.type,
                trackedRun,
              })
            ) {
              return;
            }

            if (trackedRun.kind === "task") {
              const assistantResponse = yield* resolveAssistantResponse({
                cache: assistantResponseCache,
                threadId: event.payload.threadId,
                turnId: event.payload.turnId,
                assistantMessageId:
                  event.payload.assistantMessageId === null
                    ? null
                    : String(event.payload.assistantMessageId),
              });
              const payload = buildTaskRuntimeLifecycleEvent({
                trackedRun,
                type: lifecycle.type,
                eventId: event.eventId,
                occurredAt: event.occurredAt,
                t3TurnId: lifecycle.turnId,
                ...(assistantResponse !== undefined ? { assistantResponse } : {}),
              });
              yield* postTaskRuntimeLifecycleEvent(payload);
            } else {
              const payload = buildLifecycleEvent({
                trackedRun,
                type: lifecycle.type,
                eventId: event.eventId,
                occurredAt: event.occurredAt,
                t3TurnId: lifecycle.turnId,
              });
              yield* postLifecycleEvent(payload);
            }

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
            hasLifecycleAlreadyBeenDelivered({
              type: lifecycle.type,
              trackedRun,
            })
          ) {
            return;
          }
          if (!shouldForwardLifecycleCheckpoint({ type: lifecycle.type, trackedRun })) {
            return;
          }

          if (trackedRun.kind === "task") {
            if (lifecycle.type === "completed" && lifecycle.turnId === undefined) {
              // Claude can mark the session ready before the turn completion identifies the
              // assistant message. Wait for the turn event so intake replies use the AI output.
              return;
            }

            const assistantResponse =
              lifecycle.type === "completed"
                ? yield* resolveAssistantResponse({
                    cache: assistantResponseCache,
                    threadId: event.payload.threadId,
                    ...(lifecycle.turnId !== undefined ? { turnId: lifecycle.turnId } : {}),
                  })
                : undefined;
            const payload = buildTaskRuntimeLifecycleEvent({
              trackedRun,
              type: lifecycle.type,
              eventId: event.eventId,
              occurredAt: event.occurredAt,
              ...(lifecycle.turnId !== undefined ? { t3TurnId: lifecycle.turnId } : {}),
              ...(lifecycle.failureSummary !== undefined
                ? { failureSummary: lifecycle.failureSummary }
                : {}),
              ...(assistantResponse !== undefined ? { assistantResponse } : {}),
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
            ...(lifecycle.turnId !== undefined ? { turnId: lifecycle.turnId } : {}),
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
