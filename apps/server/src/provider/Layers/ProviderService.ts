/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const threadLocks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());
  const threadGenerations = yield* Ref.make(new Map<ThreadId, number>());
  const getThreadLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((created) => [created, new Map(current).set(threadId, created)] as const),
      );
    });
  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getThreadLock(threadId), (lock) => lock.withPermit(effect));
  const getThreadGeneration = (threadId: ThreadId) =>
    Ref.get(threadGenerations).pipe(Effect.map((generations) => generations.get(threadId) ?? 0));
  const advanceThreadGeneration = (threadId: ThreadId) =>
    Ref.update(threadGenerations, (generations) => {
      const next = new Map(generations);
      next.set(threadId, (next.get(threadId) ?? 0) + 1);
      return next;
    });

  interface PreparedMcpSession {
    readonly previous: McpProviderSession.McpProviderSessionConfig | undefined;
    readonly current: McpProviderSession.McpProviderSessionConfig | undefined;
  }
  const prepareMcpSession = Effect.fn("ProviderService.prepareMcpSession")(function* (
    threadId: ThreadId,
    providerInstanceId: ProviderInstanceId,
  ): Effect.fn.Return<PreparedMcpSession> {
    const previous = McpProviderSession.readMcpProviderSession(threadId);
    const credential = yield* McpSessionRegistry.issueUncommittedMcpCredential({
      threadId,
      providerInstanceId,
    });
    const current = credential?.config;
    if (current) McpProviderSession.setMcpProviderSession(current);
    return { previous, current };
  });
  const commitMcpSession = Effect.fn("ProviderService.commitMcpSession")(function* (
    prepared: PreparedMcpSession,
  ) {
    if (
      prepared.previous &&
      prepared.previous.providerSessionId !== prepared.current?.providerSessionId
    ) {
      yield* McpSessionRegistry.revokeActiveMcpProviderSession(prepared.previous.providerSessionId);
    }
  });
  const rollbackMcpSession = Effect.fn("ProviderService.rollbackMcpSession")(function* (
    threadId: ThreadId,
    prepared: PreparedMcpSession,
  ) {
    if (prepared.current) {
      yield* McpSessionRegistry.revokeActiveMcpProviderSession(prepared.current.providerSessionId);
    }
    if (prepared.previous) McpProviderSession.setMcpProviderSession(prepared.previous);
    else McpProviderSession.clearMcpProviderSession(threadId);
  });
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );
  const clearMcpSessionForInstance = Effect.fn("ProviderService.clearMcpSessionForInstance")(
    function* (threadId: ThreadId, providerInstanceId: ProviderInstanceId) {
      const current = McpProviderSession.readMcpProviderSession(threadId);
      if (!current || current.providerInstanceId !== providerInstanceId) return;
      yield* McpSessionRegistry.revokeActiveMcpProviderSession(current.providerSessionId);
      McpProviderSession.clearMcpProviderSession(threadId);
    },
  );

  const compensateFailedSessionBinding = Effect.fn(
    "ProviderService.compensateFailedSessionBinding",
  )(function* (input: {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly threadId: ThreadId;
    readonly mcp: PreparedMcpSession;
  }) {
    yield* rollbackMcpSession(input.threadId, input.mcp).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.binding-compensation-mcp-clear-failed", {
          threadId: input.threadId,
          provider: input.adapter.provider,
          cause,
        }),
      ),
    );
    yield* input.adapter.stopSession(input.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.binding-compensation-stop-failed", {
          threadId: input.threadId,
          provider: input.adapter.provider,
          cause,
        }),
      ),
    );
  });

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const upsertSessionBindingIfCurrent = Effect.fn("ProviderService.upsertSessionBindingIfCurrent")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly instanceId: ProviderInstanceId;
      readonly generation: number;
      readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    }) {
      yield* withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const current = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
          if (current?.providerInstanceId !== input.instanceId) return;
          if ((yield* getThreadGeneration(input.threadId)) !== input.generation) return;
          yield* directory.upsert(input.binding);
        }),
      );
    },
  );

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(Effect.andThen(publishRuntimeEvent(canonicalEvent))),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
  }) {
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      if (!binding) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.threadId}' because no persisted provider binding exists.`,
        );
      }
      const bindingInstanceId = yield* requireBindingInstanceId(input.operation, binding);
      metricProvider = binding.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "recover-session",
        "provider.kind": binding.provider,
        "provider.instance_id": bindingInstanceId,
        "provider.thread_id": binding.threadId,
      });
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor = binding.resumeCursor !== null && binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find((session) => session.threadId === binding.threadId);
        if (existing) {
          yield* persistCommittedSession({
            threadId: binding.threadId,
            currentInstanceId: bindingInstanceId,
            persistence: upsertSessionBinding(
              { ...existing, providerInstanceId: bindingInstanceId },
              binding.threadId,
            ),
          });
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, instanceId: bindingInstanceId, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(binding.runtimePayload);

      const mcp = yield* prepareMcpSession(binding.threadId, bindingInstanceId);
      const resumed = yield* adapter
        .startSession({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: binding.resumeCursor } : {}),
          runtimeMode: binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => rollbackMcpSession(binding.threadId, mcp)));
      if (resumed.provider !== adapter.provider) {
        yield* compensateFailedSessionBinding({
          adapter,
          threadId: binding.threadId,
          mcp,
        });
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* persistCommittedSession({
        threadId: binding.threadId,
        currentInstanceId: bindingInstanceId,
        mcp,
        persistence: upsertSessionBinding(
          { ...resumed, providerInstanceId: bindingInstanceId },
          binding.threadId,
        ).pipe(
          Effect.onError(() =>
            compensateFailedSessionBinding({
              adapter,
              threadId: binding.threadId,
              mcp,
            }),
          ),
        ),
      });
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, instanceId: bindingInstanceId, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: () => providerMetricAttributes(metricProvider, { operation: "recover" }),
      }),
      (effect) => withThreadLock(input.threadId, effect),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      threadId: input.threadId,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId: recovered.instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const finalizeCommittedSession = Effect.fn("ProviderService.finalizeCommittedSession")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly currentInstanceId: ProviderInstanceId;
      readonly mcp?: PreparedMcpSession;
    }) {
      if (input.mcp) yield* commitMcpSession(input.mcp);
      yield* stopStaleSessionsForThread(input);
    },
    Effect.uninterruptible,
  );
  const persistCommittedSession = <E, R>(input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
    readonly persistence: Effect.Effect<void, E, R>;
    readonly mcp?: PreparedMcpSession;
  }) =>
    Effect.uninterruptibleMask((restore) =>
      restore(input.persistence).pipe(
        Effect.andThen(advanceThreadGeneration(input.threadId)),
        Effect.andThen(finalizeCommittedSession(input)),
      ),
    );

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(function* (
    threadId,
    rawInput,
    options = { activeSession: "replace" as const },
  ) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.startSession",
      schema: ProviderSessionStartInput,
      payload: rawInput,
    });

    const resolvedInstanceId = yield* requireBindingInstanceId(
      "ProviderService.startSession",
      parsed,
    );
    let metricProvider = parsed.provider ?? String(resolvedInstanceId);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "start-session",
      "provider.instance_id": resolvedInstanceId,
      "provider.thread_id": threadId,
      "provider.runtime_mode": parsed.runtimeMode,
    });
    return yield* Effect.gen(function* () {
      const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
      const resolvedProvider = instanceInfo.driverKind;
      metricProvider = resolvedProvider;
      if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
        );
      }
      const input = {
        ...parsed,
        threadId,
        provider: resolvedProvider,
      };
      if (!instanceInfo.enabled) {
        return yield* toValidationError(
          "ProviderService.startSession",
          `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
        );
      }
      const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const effectiveResumeCursor =
        input.resumeCursor ??
        (persistedBinding?.providerInstanceId === resolvedInstanceId
          ? persistedBinding.resumeCursor
          : undefined);
      const effectiveCwd =
        input.cwd ??
        (persistedBinding?.providerInstanceId === resolvedInstanceId
          ? readPersistedCwd(persistedBinding.runtimePayload)
          : undefined);
      yield* Effect.annotateCurrentSpan({
        "provider.kind": resolvedProvider,
        "provider.resume_cursor.source":
          input.resumeCursor !== undefined
            ? "request"
            : effectiveResumeCursor !== undefined &&
                persistedBinding?.providerInstanceId === resolvedInstanceId
              ? "persisted"
              : "none",
        "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
        "provider.cwd.source":
          input.cwd !== undefined
            ? "request"
            : effectiveCwd !== undefined &&
                persistedBinding?.providerInstanceId === resolvedInstanceId
              ? "persisted"
              : "none",
        "provider.cwd.effective": effectiveCwd ?? "",
      });
      const adapter = yield* registry.getByInstance(resolvedInstanceId);
      if (yield* adapter.hasSession(threadId)) {
        const existing = (yield* adapter.listSessions()).find(
          (session) => session.threadId === threadId,
        );
        const currentMcpSession = McpProviderSession.readMcpProviderSession(threadId);
        const canReuse =
          existing !== undefined &&
          options.activeSession === "reuse" &&
          persistedBinding?.providerInstanceId === resolvedInstanceId &&
          (currentMcpSession === undefined ||
            currentMcpSession.providerInstanceId === resolvedInstanceId);
        if (existing && canReuse) {
          const existingWithInstance = {
            ...existing,
            providerInstanceId: resolvedInstanceId,
          };
          yield* persistCommittedSession({
            threadId,
            currentInstanceId: resolvedInstanceId,
            persistence: upsertSessionBinding(existingWithInstance, threadId, {
              modelSelection: input.modelSelection,
            }),
          });
          return existingWithInstance;
        }
        yield* advanceThreadGeneration(threadId);
        yield* adapter.stopSession(threadId);
        yield* clearMcpSessionForInstance(threadId, resolvedInstanceId);
      }
      const mcp = yield* prepareMcpSession(threadId, resolvedInstanceId);
      const session = yield* adapter
        .startSession({
          ...input,
          providerInstanceId: resolvedInstanceId,
          ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        })
        .pipe(Effect.onError(() => rollbackMcpSession(threadId, mcp)));

      if (session.provider !== adapter.provider) {
        yield* compensateFailedSessionBinding({
          adapter,
          threadId,
          mcp,
        });
        return yield* toValidationError(
          "ProviderService.startSession",
          `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
        );
      }
      const sessionWithInstance = {
        ...session,
        providerInstanceId: resolvedInstanceId,
      };

      yield* persistCommittedSession({
        threadId,
        currentInstanceId: resolvedInstanceId,
        mcp,
        persistence: upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        }).pipe(
          Effect.onError(() =>
            compensateFailedSessionBinding({
              adapter,
              threadId,
              mcp,
            }),
          ),
        ),
      });
      yield* analytics.record("provider.session.started", {
        provider: sessionWithInstance.provider,
        runtimeMode: input.runtimeMode,
        hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
        hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
        hasModel:
          typeof input.modelSelection?.model === "string" &&
          input.modelSelection.model.trim().length > 0,
      });

      return sessionWithInstance;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "start",
          }),
      }),
      (effect) => withThreadLock(threadId, effect),
    );
  });

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      const generation = yield* withThreadLock(input.threadId, getThreadGeneration(input.threadId));
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      yield* upsertSessionBindingIfCurrent({
        threadId: input.threadId,
        instanceId: routed.instanceId,
        generation,
        binding: {
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: yield* nowIso,
          },
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        yield* advanceThreadGeneration(input.threadId);
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* clearMcpSession(input.threadId);
        yield* Effect.uninterruptible(
          directory
            .upsert({
              threadId: input.threadId,
              provider: routed.adapter.provider,
              providerInstanceId: routed.instanceId,
              status: "stopped",
              runtimePayload: {
                activeTurnId: null,
              },
            })
            .pipe(Effect.asVoid),
        );
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
        (effect) => withThreadLock(input.threadId, effect),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(
                  Effect.orElseSucceed(() =>
                    Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
                  ),
                ),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
