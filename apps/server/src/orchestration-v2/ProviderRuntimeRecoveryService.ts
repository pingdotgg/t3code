import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class ProviderRuntimeRecoveryError extends Schema.TaggedErrorClass<ProviderRuntimeRecoveryError>()(
  "ProviderRuntimeRecoveryError",
  {
    operation: Schema.Literals([
      "read-projections",
      "resume-session",
      "terminalize",
      "drain-outbox",
    ]),
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider runtime recovery failed during ${this.operation}.`;
  }
}

export interface ProviderRuntimeRecoverySummary {
  readonly resumedSessions: number;
  readonly terminalizedRuns: number;
  readonly executedEffects: number;
}

export const ProviderRuntimeFailureKind = Schema.Literals([
  "process_exited",
  "transport_unavailable",
  "network_unavailable",
  "provider_rate_limited",
  "provider_quota_exceeded",
  "auth_invalid",
  "permission_denied",
  "invalid_request",
  "unsupported_model",
]);
export type ProviderRuntimeFailureKind = typeof ProviderRuntimeFailureKind.Type;

export type ProviderRuntimeRecoveryDecision =
  | { readonly type: "retry_now" }
  | { readonly type: "retry_after"; readonly delayMs: number }
  | { readonly type: "wait_for_connectivity" }
  | { readonly type: "terminalize"; readonly reason: string };

export function decideProviderRuntimeRecovery(input: {
  readonly kind: ProviderRuntimeFailureKind;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly idempotent: boolean;
  readonly retryAfterMs?: number;
  readonly online: boolean;
}): ProviderRuntimeRecoveryDecision {
  if (input.attempt >= input.maxAttempts) {
    return { type: "terminalize", reason: "Provider recovery retry budget was exhausted." };
  }
  switch (input.kind) {
    case "process_exited":
    case "transport_unavailable":
      return input.idempotent
        ? { type: "retry_now" }
        : { type: "terminalize", reason: "The interrupted operation is not idempotent." };
    case "network_unavailable":
      return input.online ? { type: "retry_now" } : { type: "wait_for_connectivity" };
    case "provider_rate_limited":
      return input.idempotent && input.retryAfterMs !== undefined
        ? { type: "retry_after", delayMs: Math.max(0, input.retryAfterMs) }
        : {
            type: "terminalize",
            reason: "Rate-limit recovery requires retry-after and an idempotent operation.",
          };
    case "provider_quota_exceeded":
    case "auth_invalid":
    case "permission_denied":
    case "invalid_request":
    case "unsupported_model":
      return { type: "terminalize", reason: `Provider failure ${input.kind} is not recoverable.` };
  }
}

export interface ConnectivityServiceShape {
  readonly isOnline: Effect.Effect<boolean>;
  readonly awaitOnline: Effect.Effect<void>;
}

export class ConnectivityService extends Context.Reference<ConnectivityServiceShape>(
  "t3/orchestration-v2/ConnectivityService",
  {
    defaultValue: () => ({ isOnline: Effect.succeed(true), awaitOnline: Effect.void }),
  },
) {}

export interface ClassifiedProviderRuntimeFailure {
  readonly kind: ProviderRuntimeFailureKind;
  readonly retryAfterMs?: number;
}

export function classifyProviderRuntimeFailure(cause: unknown): ClassifiedProviderRuntimeFailure {
  const record =
    cause !== null && typeof cause === "object"
      ? (cause as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const serialized = (() => {
    try {
      return JSON.stringify(cause);
    } catch {
      return "";
    }
  })();
  const description = [
    record._tag,
    record.code,
    record.status,
    record.message,
    record.detail,
    serialized,
  ]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ")
    .toLowerCase();
  const nestedCause =
    record.cause !== null && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : undefined;
  const retryAfter =
    record.retryAfterMs ??
    record.retry_after_ms ??
    nestedCause?.retryAfterMs ??
    nestedCause?.retry_after_ms;
  const retryAfterMs = typeof retryAfter === "number" ? retryAfter : undefined;
  if (description.includes("rate") && description.includes("limit")) {
    return {
      kind: "provider_rate_limited",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (description.includes("quota")) return { kind: "provider_quota_exceeded" };
  if (description.includes("auth") || description.includes("unauthorized")) {
    return { kind: "auth_invalid" };
  }
  if (description.includes("permission") || description.includes("forbidden")) {
    return { kind: "permission_denied" };
  }
  if (description.includes("unsupported") && description.includes("model")) {
    return { kind: "unsupported_model" };
  }
  if (description.includes("invalid") && description.includes("request")) {
    return { kind: "invalid_request" };
  }
  if (
    description.includes("network") ||
    description.includes("offline") ||
    description.includes("econnreset") ||
    description.includes("enotfound")
  ) {
    return { kind: "network_unavailable" };
  }
  if (description.includes("exit") || description.includes("terminated")) {
    return { kind: "process_exited" };
  }
  return { kind: "transport_unavailable" };
}

export class ProviderRuntimeFailureClassifier extends Context.Reference<{
  readonly classify: (cause: unknown) => ClassifiedProviderRuntimeFailure;
}>("t3/orchestration-v2/ProviderRuntimeFailureClassifier", {
  defaultValue: () => ({ classify: classifyProviderRuntimeFailure }),
}) {}

export class ProviderRuntimeRecoveryPolicy extends Context.Reference<{
  readonly maxAttempts: number;
}>("t3/orchestration-v2/ProviderRuntimeRecoveryPolicy", {
  defaultValue: () => ({ maxAttempts: 3 }),
}) {}

export function recoverWithPolicy<A, E>(input: {
  readonly operation: Effect.Effect<A, E>;
  readonly classify: (cause: E) => ClassifiedProviderRuntimeFailure;
  readonly connectivity: ConnectivityServiceShape;
  readonly maxAttempts: number;
  readonly idempotent: boolean;
}): Effect.Effect<A, E> {
  const attempt = (attemptNumber: number): Effect.Effect<A, E> =>
    input.operation.pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const classified = input.classify(cause);
          const online = yield* input.connectivity.isOnline;
          const decision = decideProviderRuntimeRecovery({
            kind: classified.kind,
            attempt: attemptNumber,
            maxAttempts: input.maxAttempts,
            idempotent: input.idempotent,
            online,
            ...(classified.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: classified.retryAfterMs }),
          });
          switch (decision.type) {
            case "retry_now":
              return yield* attempt(attemptNumber + 1);
            case "retry_after":
              yield* Effect.sleep(Duration.millis(decision.delayMs));
              return yield* attempt(attemptNumber + 1);
            case "wait_for_connectivity":
              yield* input.connectivity.awaitOnline;
              return yield* attempt(attemptNumber + 1);
            case "terminalize":
              return yield* Effect.fail(cause);
          }
        }),
      ),
    );
  return attempt(1);
}

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("t3/orchestration-v2/ProviderRuntimeRecoveryService") {}

function activeRuns(projection: OrchestrationV2ThreadProjection) {
  return projection.runs.filter(
    (run) => run.status === "starting" || run.status === "running" || run.status === "waiting",
  );
}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const connectivity = yield* ConnectivityService;
  const classifier = yield* ProviderRuntimeFailureClassifier;
  const recoveryPolicy = yield* ProviderRuntimeRecoveryPolicy;

  const terminalize = Effect.fn("ProviderRuntimeRecoveryService.terminalize")(function* (
    projection: OrchestrationV2ThreadProjection,
    detail: string,
  ) {
    const now = yield* DateTime.now;
    const runs = activeRuns(projection);
    if (runs.length === 0) return 0;
    const commandId = CommandId.make(`command:recovery:terminalize:${projection.thread.id}`);
    const allocateEventId = () =>
      ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeRecoveryError({
              operation: "terminalize",
              threadId: projection.thread.id,
              cause,
            }),
        ),
      );
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const run of runs) {
      events.push({
        id: yield* allocateEventId(),
        type: "run.updated",
        threadId: projection.thread.id,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "failed", completedAt: now },
      });
      for (const node of projection.nodes.filter(
        (candidate) =>
          candidate.runId === run.id &&
          (candidate.status === "pending" ||
            candidate.status === "running" ||
            candidate.status === "waiting"),
      )) {
        events.push({
          id: yield* allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "failed", completedAt: now },
        });
      }
    }
    yield* eventSink
      .commitCommand({
        commandId,
        threadId: projection.thread.id,
        commandType: "provider-runtime.recovery-terminalize",
        acceptedAt: now,
        events,
        effects: [],
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeRecoveryError({
              operation: "terminalize",
              threadId: projection.thread.id,
              cause: { detail, cause },
            }),
        ),
      );
    return runs.length;
  });

  const expireOrphanedRequests = Effect.fn("ProviderRuntimeRecoveryService.expireOrphanedRequests")(
    function* (projection: OrchestrationV2ThreadProjection) {
      const requests = projection.runtimeRequests.filter((request) => request.status === "pending");
      if (requests.length === 0) return;
      const now = yield* DateTime.now;
      const commandId = CommandId.make(`command:recovery:expire-requests:${projection.thread.id}`);
      const events: Array<OrchestrationV2DomainEvent> = [];
      for (const request of requests) {
        events.push({
          id: yield* ids.allocate.event({ threadId: projection.thread.id, commandId }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderRuntimeRecoveryError({
                  operation: "terminalize",
                  threadId: projection.thread.id,
                  cause,
                }),
            ),
          ),
          type: "runtime-request.updated",
          threadId: projection.thread.id,
          nodeId: request.nodeId,
          occurredAt: now,
          payload: {
            ...request,
            status: "expired",
            responseCapability: {
              type: "not_resumable",
              reason: "The server restarted before this runtime request was resolved.",
            },
            resolvedAt: now,
          },
        });
      }
      yield* eventSink
        .commitCommand({
          commandId,
          threadId: projection.thread.id,
          commandType: "provider-runtime.expire-orphaned-requests",
          acceptedAt: now,
          events,
          effects: [],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderRuntimeRecoveryError({
                operation: "terminalize",
                threadId: projection.thread.id,
                cause,
              }),
          ),
        );
    },
  );

  const recoverProjection = Effect.fn("ProviderRuntimeRecoveryService.recoverProjection")(
    function* (projection: OrchestrationV2ThreadProjection) {
      yield* expireOrphanedRequests(projection);
      let resumedSessions = 0;
      for (const session of projection.providerSessions.filter(
        (candidate) => candidate.status !== "stopped" && candidate.status !== "error",
      )) {
        const resume = sessions
          .open({
            threadId: projection.thread.id,
            providerSessionId: session.id,
            modelSelection: projection.thread.modelSelection,
            runtimePolicy: {
              runtimeMode: projection.thread.runtimeMode,
              interactionMode: projection.thread.interactionMode,
              cwd: session.cwd,
            },
            resumeFromSession: session,
          })
          .pipe(
            Effect.flatMap((runtime) =>
              Effect.forEach(
                projection.providerThreads.filter(
                  (providerThread) =>
                    providerThread.providerSessionId === session.id &&
                    providerThread.appThreadId === projection.thread.id &&
                    providerThread.status !== "closed" &&
                    providerThread.status !== "archived",
                ),
                (providerThread) =>
                  runtime.resumeThread({
                    providerThread,
                    threadId: projection.thread.id,
                    modelSelection: projection.thread.modelSelection,
                    runtimePolicy: {
                      runtimeMode: projection.thread.runtimeMode,
                      interactionMode: projection.thread.interactionMode,
                      cwd: session.cwd,
                    },
                  }),
                { discard: true },
              ),
            ),
          );
        const recovered = yield* Effect.result(
          recoverWithPolicy({
            operation: resume,
            classify: classifier.classify,
            connectivity,
            maxAttempts: recoveryPolicy.maxAttempts,
            idempotent: true,
          }),
        );
        if (recovered._tag === "Failure") {
          const terminalizedRuns = yield* terminalize(
            projection,
            `Unable to resume provider session ${session.id}.`,
          );
          return { resumedSessions, terminalizedRuns };
        }
        resumedSessions += 1;
      }
      if (
        resumedSessions === 0 &&
        projection.runs.some((run) => run.status === "running" || run.status === "waiting")
      ) {
        const terminalizedRuns = yield* terminalize(
          projection,
          "No resumable provider session remained for the active run.",
        );
        return { resumedSessions, terminalizedRuns };
      }
      return { resumedSessions, terminalizedRuns: 0 };
    },
  );

  const recover = Effect.gen(function* () {
    const shell = yield* projections
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "read-projections", cause }),
        ),
      );
    let resumedSessions = 0;
    let terminalizedRuns = 0;
    for (const thread of shell.threads) {
      const projection = yield* projections.getThreadProjection(thread.id).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderRuntimeRecoveryError({
              operation: "read-projections",
              threadId: thread.id,
              cause,
            }),
        ),
      );
      const result = yield* recoverProjection(projection);
      resumedSessions += result.resumedSessions;
      terminalizedRuns += result.terminalizedRuns;
    }
    let executedEffects = 0;
    yield* outbox.reclaimRunning.pipe(
      Effect.mapError(
        (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
      ),
    );
    while (
      yield* worker.runOnce.pipe(
        Effect.mapError(
          (cause) => new ProviderRuntimeRecoveryError({ operation: "drain-outbox", cause }),
        ),
      )
    ) {
      executedEffects += 1;
    }
    return { resumedSessions, terminalizedRuns, executedEffects };
  });

  return ProviderRuntimeRecoveryService.of({ recover });
});

export const layer = Layer.effect(ProviderRuntimeRecoveryService, make);
