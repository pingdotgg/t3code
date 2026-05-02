import {
  type ExecutionRunLifecycleEvent,
  type ExecutionRunActivityEvent,
  ExecutionRunCreateRequest,
  ExecutionRunContinueRequest,
  ExecutionRunInterruptRequest,
  ExecutionRunStatusQuery,
  TaskRuntimeMaterializeRequest,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authenticateExecutionBridgeRequest, ExecutionBridgeAuthError } from "./routeAuth.ts";
import {
  buildLifecycleEvent,
  buildTaskRuntimeLifecycleEvent,
  type ExecutionLifecycleCheckpoint,
  ExecutionBridgeRunRegistry,
  ExecutionBridgeRunStartError,
  startExecutionRun,
  continueExecutionRun,
  interruptExecutionRun,
  materializeTaskRuntime,
  type TrackedExecutionRun,
} from "./runStart.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

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
  if (event.payload.session.status === "ready") {
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

  // Thread startup briefly emits a ready session before the first turn begins.
  // We should only treat ready as a completion after we've already observed a started turn.
  if (input.type === "completed" && input.trackedRun.startedEventId === null) {
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

export const executionBridgeStatusQueryRouteLayer = HttpRouter.add(
  "POST",
  "/api/execution/runs/status",
  Effect.gen(function* () {
    yield* authenticateExecutionBridgeRequest;
    const query = yield* HttpServerRequest.schemaBodyJson(ExecutionRunStatusQuery);
    const orchestrationEngine = yield* OrchestrationEngineService;
    const snapshot = yield* orchestrationEngine.getReadModel();
    const thread = snapshot.threads.find((t) => String(t.id) === String(query.t3ThreadId));

    if (!thread) {
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
        sessionStatus: thread.session?.status ?? "unknown",
        activeTurnId: thread.session?.activeTurnId ?? null,
        lastError: thread.session?.lastError ?? null,
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

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.activity-appended") {
          return Effect.gen(function* () {
            const trackedRun = yield* runRegistry.getTrackedRun(event.payload.threadId);
            if (trackedRun === null) {
              return;
            }
            if (trackedRun.kind !== "execution") {
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
          if (!shouldForwardLifecycleCheckpoint({ type: lifecycle.type, trackedRun })) {
            return;
          }

          if (trackedRun.kind === "task") {
            const payload = buildTaskRuntimeLifecycleEvent({
              trackedRun,
              type: lifecycle.type,
              eventId: event.eventId,
              occurredAt: event.occurredAt,
              ...(lifecycle.turnId !== undefined ? { t3TurnId: lifecycle.turnId } : {}),
              ...(lifecycle.failureSummary !== undefined
                ? { failureSummary: lifecycle.failureSummary }
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
          // We only mark the lifecycle after a successful POST so retries can be
          // attempted on later session updates if the callback target is briefly down.
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
