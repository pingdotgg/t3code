// ACP session state shared by the extracted session behaviour modules.

import {
  acpSubagentStatusIsTerminal,
  type ActiveAcpTurn,
  type AcpNativeChildSession,
  type AcpNativeBuildConfiguration,
  type AcpRuntimeTeardownState,
  type PendingRuntimeRequest,
  type SnapshotMessageState,
  type AcpCarryoverSubagents,
} from "./acpTurnModel.ts";
import {
  type T3AcpInstructionState,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  type ThreadTokenUsageSnapshot,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ProviderThread,
  type ModelSelection,
  type ProviderInteractionMode,
  type OrchestrationV2ProviderTurn,
  type ThreadId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import { makeAcpClientPolicyGrants } from "./clientPolicy.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { parseSessionUpdateEvent, type AcpToolCallState } from "./runtimeModel.ts";
import { toolStatus } from "./acpToolCallProjection.ts";
import { type AcpAdapterV2RuntimeInput } from "./acpAdapterConfig.ts";
import { type AcpMcpContext } from "./acpThreadContext.ts";
import { type AcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";
import { type BackgroundWorkReport } from "@t3tools/provider-core/server/notification";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/compat";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { AcpSessionDeps } from "./acpSessionDeps.ts";
import type { AcpSessionLateBindings } from "./acpSessionLate.ts";

export const createAcpSessionCore = Effect.fn("acpSession.core")(function* (deps: AcpSessionDeps) {
  const late = {} as AcpSessionLateBindings;
  const clientPolicyGrants = makeAcpClientPolicyGrants();
  let latestRuntimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy =
    deps.input.runtimePolicy;
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const activeTurn = yield* Ref.make<ActiveAcpTurn | null>(null);
  const steerInjections = new Map<string, Deferred.Deferred<void>>();
  const steerInjection = (steerId: string) => {
    const existing = steerInjections.get(steerId);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<void>();
    steerInjections.set(steerId, created);
    return created;
  };
  let pendingStopCloseTurn: ActiveAcpTurn | null = null;
  let followsAgentWorkState = false;
  let agentWork: Extract<
    EffectAcpSchema.SessionUpdate,
    { sessionUpdate: "state_update" }
  > | null = null;
  const agentRequests = new Set<object>();
  const nativeChildren = new Map<string, AcpNativeChildSession>();
  const extractSubagentUpdate = (tool: AcpToolCallState) =>
    deps.flavor.extractSubagentSessionEvent !== undefined && !followsAgentWorkState
      ? undefined
      : deps.flavor.extractSubagentUpdate?.(tool);
  let turnAttached = yield* Deferred.make<boolean>();
  const activeSessionId = yield* Ref.make<string | null>(null);
  const contextUsageBySessionId = yield* Ref.make(
    new Map<string, ThreadTokenUsageSnapshot>(),
  );
  const nativeMetadataBySessionId = yield* Ref.make(
    new Map<string, OrchestrationV2ProviderThreadNativeMetadata>(),
  );
  const providerThreadByNativeSessionId = yield* Ref.make(
    new Map<string, OrchestrationV2ProviderThread>(),
  );
  const nativeBuildConfigurationBySessionId = new Map<string, AcpNativeBuildConfiguration>();
  const initialSessionActivationFailure = yield* Ref.make<{
    readonly sessionId: string;
    readonly error: EffectAcpErrors.AcpError;
  } | null>(null);
  const activeSessionSetup =
    yield* Ref.make<AcpSessionRuntime.AcpSessionRuntimeStartResult | null>(null);
  const setActiveSessionSetup = Effect.fnUntraced(function* (
    setup: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ) {
    followsAgentWorkState =
      deps.flavor.followAgentWorkState === true &&
      deps.continuationRequests !== undefined &&
      setup.initializeResult.protocolVersion === 2;
    agentWork = null;
    agentRequests.clear();
    nativeChildren.clear();
    yield* Ref.set(activeSessionSetup, setup);
  });
  const activeSelection = yield* Ref.make<ModelSelection | null>(null);
  const activeInteractionMode = yield* Ref.make<ProviderInteractionMode | null>(null);
  const promptInstructionStates = yield* Ref.make(new Map<string, T3AcpInstructionState>());
  const compactionMarkers = yield* Ref.make(new Map<string, symbol>());
  const runtimeRestartRequired = yield* Ref.make(false);
  const runtimeTeardownState = yield* Ref.make<AcpRuntimeTeardownState>({ _tag: "Idle" });
  const runtimeCallbackGeneration = yield* Ref.make(0);
  const runtimeCallbackGenerationCounter = yield* Ref.make(0);
  const allocateRuntimeCallbackGeneration = Ref.updateAndGet(
    runtimeCallbackGenerationCounter,
    (generation) => generation + 1,
  );
  const advanceRuntimeCallbackGeneration = allocateRuntimeCallbackGeneration.pipe(
    Effect.tap((generation) => Ref.set(runtimeCallbackGeneration, generation)),
  );
  const runtimeCallbackPermit = yield* Semaphore.make(1);
  const runtimeTransitionPermit = yield* Semaphore.make(1);
  const nativeResponseAcknowledgements = yield* Ref.make(
    new Map<
      string,
      {
        readonly acknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
        readonly generation: number;
      }
    >(),
  );
  const pendingRuntimeRequests = yield* Ref.make(new Map<string, PendingRuntimeRequest>());
  const emitNativeResponseLifecycle =
    deps.options.testHooks?.onNativeResponseLifecycle ?? (() => Effect.void);
  const nextElicitationOrdinal = yield* Ref.make(0);
  const providerTurns = yield* Ref.make(new Map<string, OrchestrationV2ProviderTurn>());
  const snapshot = yield* Ref.make<SnapshotMessageState>({
    order: [],
    messages: new Map(),
    loadingRole: null,
    loadingMessageId: null,
    loadingIndex: 0,
  });
  const awaitRuntimeTeardown = Effect.fnUntraced(function* () {
    const state = yield* Ref.get(runtimeTeardownState);
    if (state._tag === "InProgress") {
      yield* Deferred.await(state.completed);
    } else if (state._tag === "Failed") {
      return yield* state.error;
    }
  });
  const runRuntimeCallbackAtGeneration = <A, E, R>(
    generation: number,
    effect: Effect.Effect<A, E, R>,
  ) =>
    runtimeCallbackPermit.withPermit(
      Effect.gen(function* () {
        if ((yield* Ref.get(runtimeTeardownState))._tag !== "Idle") {
          return Option.none<A>();
        }
        if ((yield* Ref.get(runtimeCallbackGeneration)) !== generation) {
          return Option.none<A>();
        }
        return Option.some(yield* effect);
      }),
    );
  const registerNativeResponseAcknowledgement =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      generation: number,
      transportRequestId: string,
      acknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>,
    ) {
      yield* Ref.update(nativeResponseAcknowledgements, (current) => {
        const updated = new Map(current);
        updated.set(transportRequestId, { acknowledgement, generation });
        return updated;
      });
      yield* emitNativeResponseLifecycle({
        type: "registered",
        generation,
        requestId: transportRequestId,
      });
      if (!(yield* Deferred.isDone(acknowledgement))) return;
      yield* Ref.update(nativeResponseAcknowledgements, (current) => {
        if (current.get(transportRequestId)?.acknowledgement !== acknowledgement) {
          return current;
        }
        const updated = new Map(current);
        updated.delete(transportRequestId);
        return updated;
      });
    });
  const acknowledgeNativeResponse = (generation: number, transportRequestId: string) =>
    runRuntimeCallbackAtGeneration(generation, Effect.void).pipe(
      Effect.flatMap((registered) =>
        Option.isSome(registered)
          ? Effect.void
          : emitNativeResponseLifecycle({
              type: "admission_rejected",
              generation,
              requestId: transportRequestId,
            }).pipe(
              Effect.andThen(
                new EffectAcpErrors.AcpTransportError({
                  detail: "The ACP runtime closed before its response could be admitted",
                  cause: "Native response registration rejected during teardown",
                }),
              ),
            ),
      ),
    );
  const awaitNativeResponseAcknowledgements = Effect.fnUntraced(function* (
    acknowledgements: ReadonlyArray<
      readonly [string | undefined, Deferred.Deferred<void, EffectAcpErrors.AcpError>]
    >,
  ) {
    if (acknowledgements.length === 0) return true;
    const completed = yield* Deferred.make<"settled" | "timeout">();
    yield* emitNativeResponseLifecycle({ type: "watcher_started" });
    const acknowledgementFiber = yield* Effect.forEach(
      acknowledgements,
      ([, acknowledgement]) => Deferred.await(acknowledgement).pipe(Effect.exit),
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.andThen(Deferred.succeed(completed, "settled")),
      Effect.interruptible,
      Effect.ensuring(emitNativeResponseLifecycle({ type: "watcher_exited" })),
      Effect.forkDetach,
    );
    yield* emitNativeResponseLifecycle({ type: "timer_started" });
    const timerFiber = yield* Effect.sleep("2 seconds").pipe(
      Effect.andThen(Deferred.succeed(completed, "timeout")),
      Effect.interruptible,
      Effect.ensuring(emitNativeResponseLifecycle({ type: "timer_exited" })),
      Effect.forkDetach,
    );
    const outcome = yield* Deferred.await(completed);
    yield* Fiber.interrupt(acknowledgementFiber);
    yield* Fiber.interrupt(timerFiber);
    if (outcome === "settled") return true;

    yield* Ref.update(nativeResponseAcknowledgements, (current) => {
      const updated = new Map(current);
      for (const [requestId, acknowledgement] of acknowledgements) {
        if (
          requestId !== undefined &&
          updated.get(requestId)?.acknowledgement === acknowledgement
        ) {
          updated.delete(requestId);
        }
      }
      return updated;
    });
    yield* Effect.forEach(
      acknowledgements,
      ([requestId]) =>
        emitNativeResponseLifecycle({
          type: "removed",
          ...(requestId === undefined ? {} : { requestId }),
        }),
      { concurrency: "unbounded", discard: true },
    );
    const timeoutError = new EffectAcpErrors.AcpTransportError({
      detail: "Timed out waiting for an admitted ACP response to reach the transport queue",
      cause: "Native response acknowledgement timed out",
    });
    yield* Effect.forEach(
      acknowledgements,
      ([requestId, acknowledgement]) =>
        Deferred.fail(acknowledgement, timeoutError).pipe(
          Effect.andThen(
            emitNativeResponseLifecycle({
              type: "failed",
              ...(requestId === undefined ? {} : { requestId }),
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
    return false;
  });
  const awaitAdmittedNativeResponses = Ref.get(nativeResponseAcknowledgements).pipe(
    Effect.flatMap((current) =>
      awaitNativeResponseAcknowledgements(
        [...current.entries()].map(
          ([requestId, entry]) => [requestId, entry.acknowledgement] as const,
        ),
      ),
    ),
  );
  const quarantineNativeTransportAtGeneration = Effect.fnUntraced(function* (
    generation: number,
  ) {
    const quarantined = yield* Ref.modify(nativeResponseAcknowledgements, (current) => {
      const updated = new Map(current);
      const acknowledgements: Array<Deferred.Deferred<void, EffectAcpErrors.AcpError>> = [];
      for (const [requestId, entry] of updated) {
        if (entry.generation !== generation) continue;
        updated.delete(requestId);
        acknowledgements.push(entry.acknowledgement);
      }
      return [acknowledgements, updated] as const;
    });
    const error = new EffectAcpErrors.AcpTransportError({
      detail: "The ACP runtime was replaced before its response reached the transport queue",
      cause: "ACP runtime transport was quarantined during teardown",
    });
    yield* Effect.forEach(
      quarantined,
      (acknowledgement) => Deferred.fail(acknowledgement, error),
      { concurrency: "unbounded", discard: true },
    );
  });
  const closeNativeTransport = runtimeCallbackPermit.withPermit(
    Effect.gen(function* () {
      yield* advanceRuntimeCallbackGeneration;
      const acknowledgements = yield* Ref.getAndSet(
        nativeResponseAcknowledgements,
        new Map(),
      );
      const error = new EffectAcpErrors.AcpTransportError({
        detail: "The ACP session closed before its admitted response reached the transport",
        cause: "ACP session transport closed",
      });
      yield* Effect.forEach(
        acknowledgements,
        ([requestId, entry]) =>
          Deferred.fail(entry.acknowledgement, error).pipe(
            Effect.andThen(
              emitNativeResponseLifecycle({
                type: "removed",
                generation: entry.generation,
                requestId,
              }),
            ),
            Effect.andThen(
              emitNativeResponseLifecycle({
                type: "failed",
                generation: entry.generation,
                requestId,
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
      return acknowledgements.size > 0;
    }),
  );
  const lastTurnRoute = yield* Ref.make<{
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
  } | null>(null);
  const wakeBuffer = yield* Ref.make<Array<EffectAcpSchema.SessionNotification>>([]);
  const noWakeReports = {
    reports: new Map<string, BackgroundWorkReport>(),
    offered: new Set<string>(),
  };
  const wakeReports = yield* Ref.make<{
    readonly reports: ReadonlyMap<string, BackgroundWorkReport>;
    readonly offered: ReadonlySet<string>;
  }>(noWakeReports);
  const recordWakeReport = Effect.fnUntraced(function* (
    key: string,
    report: BackgroundWorkReport,
  ) {
    const context = yield* Ref.get(activeTurn);
    if (context !== null && !context.promptSettled && !context.finalized) return;
    yield* Ref.update(wakeReports, ({ reports, offered }) => ({
      reports: new Map(reports).set(key, report),
      offered,
    }));
  });
  const continuationRequested = yield* Ref.make(false);
  const continuationGeneration = yield* Ref.make(0);
  const continuationPermit = yield* Semaphore.make(1);
  const continuationClosed = yield* Ref.make(false);
  const stoppedRunQuarantine = yield* Ref.make(false);
  const carryoverSubagents = yield* Ref.make<AcpCarryoverSubagents | null>(null);
  const handledBackgroundTaskIdsInActiveTurn = yield* Ref.make<ReadonlySet<string>>(
    new Set(),
  );
  const midTurnUnreportedCompletedTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  const suppressPostSettleMonitorPrompt = yield* Ref.make(false);
  const runningBackgroundTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  const endedBackgroundTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  const endedBackgroundTaskIdLimit = 128;
  const setBackgroundTaskRunning =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (taskId: string, running: boolean) {
      if (running && (yield* Ref.get(endedBackgroundTaskIds)).has(taskId)) {
        return;
      }
      yield* Ref.update(runningBackgroundTaskIds, (current) => {
        if (current.has(taskId) === running) return current;
        const next = new Set(current);
        if (running) {
          next.add(taskId);
        } else {
          next.delete(taskId);
        }
        return next;
      });
    });
  const markBackgroundTaskEnded = (taskId: string) =>
    Ref.update(endedBackgroundTaskIds, (current) => {
      if (current.has(taskId)) return current;
      const next = new Set(current).add(taskId);
      for (const oldest of next) {
        if (next.size <= endedBackgroundTaskIdLimit) break;
        next.delete(oldest);
      }
      return next;
    }).pipe(Effect.andThen(setBackgroundTaskRunning(taskId, false)));
  const applyBackgroundTaskMutationRunning = (mutation: {
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
  }) =>
    mutation.status === "running"
      ? setBackgroundTaskRunning(mutation.taskId, true)
      : markBackgroundTaskEnded(mutation.taskId);
  const trackRunningBackgroundTools =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (
      notification: EffectAcpSchema.SessionNotification,
    ): Effect.fn.Return<void> {
      if (deps.flavor.extractBackgroundTaskId === undefined) return;
      for (const event of parseSessionUpdateEvent(notification).events) {
        if (event._tag !== "ToolCallUpdated") continue;
        const toolCall = deps.flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
        const taskId = deps.flavor.extractBackgroundTaskId(toolCall);
        if (taskId === undefined) continue;
        const status = toolStatus(toolCall.status);
        yield* setBackgroundTaskRunning(taskId, status === "pending" || status === "running");
      }
    });
  const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Queue.offer(events, event).pipe(Effect.asVoid);
  let scheduleDeferredFinalize: (context: ActiveAcpTurn) => Effect.Effect<void> = () =>
    Effect.void;
  const nativeLogging = deps.options.nativeLogging?.(deps.input.threadId);
  const handleRuntimeTerminationAtGeneration = (runtimeGeneration: number) =>
    runRuntimeCallbackAtGeneration(
      runtimeGeneration,
      Effect.gen(function* () {
        yield* Ref.set(runtimeRestartRequired, true);
        if (!followsAgentWorkState) return;
        agentWork = { sessionUpdate: "state_update", state: "idle", stopReason: "error" };
        for (const child of nativeChildren.values()) {
          if (child.status !== "running") continue;
          child.status = "failed";
          child.result = null;
        }
        for (const child of nativeChildren.values()) {
          if (
            child.subagent === undefined ||
            acpSubagentStatusIsTerminal(child.subagent.task.status)
          )
            continue;
          child.result = null;
          yield* late.publishNativeChildStatus(child, "failed");
        }
        agentRequests.clear();
        yield* Ref.set(wakeBuffer, []);
        yield* Ref.set(continuationRequested, false);
        yield* late.cancelPendingRuntimeRequests();
        const context = yield* Ref.get(activeTurn);
        if (context !== null)
          yield* late.finalizeTurn(
            context,
            "failed",
            makeProviderFailure({ class: "transport_error" }),
          );
      }),
    ).pipe(Effect.asVoid);
  const makeRuntimeInput = (
    runtimeGeneration: number,
    mcpContext: AcpMcpContext,
    resumeSessionId?: string,
    onTermination: AcpAdapterV2RuntimeInput["onTermination"] = () =>
      handleRuntimeTerminationAtGeneration(runtimeGeneration),
  ): AcpAdapterV2RuntimeInput => {
    return {
      cwd: deps.input.runtimePolicy.cwd ?? process.cwd(),
      runtimePolicy: deps.input.runtimePolicy,
      mcpServers: mcpContext.servers,
      acpMcpServers: mcpContext.acpServers,
      httpMcpServers: mcpContext.httpServers,
      ...(mcpContext.processEnvironment === undefined
        ? {}
        : { processEnvironment: mcpContext.processEnvironment }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      interruptPromptOnCancel: deps.flavor.interruptPromptOnCancel ?? false,
      clientCapabilities: {
        fs: {
          readTextFile: deps.flavor.clientFileSystem !== undefined,
          writeTextFile: deps.flavor.clientFileSystem?.writeTextFile !== undefined,
        },
        terminal: late.clientTerminals !== undefined,
        elicitation: { form: {}, ...(deps.flavor.onUrlElicitation ? { url: {} } : {}) },
        ...(deps.flavor.clientCapabilitiesMeta ? { _meta: deps.flavor.clientCapabilitiesMeta } : {}),
      },
      clientInfo: { name: "t3-code", version: "0.0.0" },
      onTermination,
      onOutgoingResponseFailure: (requestId, error) =>
        Ref.modify(nativeResponseAcknowledgements, (current) => {
          const entry = current.get(requestId);
          if (entry === undefined || entry.generation !== runtimeGeneration) {
            return [
              emitNativeResponseLifecycle({
                type: "late_noop",
                generation: runtimeGeneration,
                requestId,
              }),
              current,
            ] as const;
          }
          const updated = new Map(current);
          updated.delete(requestId);
          return [
            Deferred.fail(entry.acknowledgement, error).pipe(
              Effect.andThen(
                emitNativeResponseLifecycle({
                  type: "removed",
                  generation: runtimeGeneration,
                  requestId,
                }),
              ),
              Effect.asVoid,
            ),
            updated,
          ] as const;
        }).pipe(Effect.flatten),
      onOutgoingResponse: (requestId) =>
        Ref.modify(nativeResponseAcknowledgements, (current) => {
          const entry = current.get(requestId);
          if (entry === undefined || entry.generation !== runtimeGeneration) {
            return [
              emitNativeResponseLifecycle({
                type: "late_noop",
                generation: runtimeGeneration,
                requestId,
              }),
              current,
            ] as const;
          }
          const updated = new Map(current);
          updated.delete(requestId);
          return [
            Deferred.succeed(entry.acknowledgement, undefined).pipe(
              Effect.andThen(
                emitNativeResponseLifecycle({
                  type: "removed",
                  generation: runtimeGeneration,
                  requestId,
                }),
              ),
              Effect.asVoid,
            ),
            updated,
          ] as const;
        }).pipe(Effect.flatten),
      ...(nativeLogging?.requestLogger === undefined
        ? {}
        : { requestLogger: nativeLogging.requestLogger }),
      protocolLogging: nativeLogging?.protocolLogging ?? {
        logIncoming: false,
        logOutgoing: false,
        logger: () => Effect.void,
      },
    };
  };
  let runtimeScope: Scope.Closeable | undefined;
  let runtime!: AcpSessionRuntime.AcpSessionRuntime["Service"];
  let runtimeMcpBridge: AcpMcpOverAcpBridge | undefined;
  yield* Effect.addFinalizer(() =>
    runtimeScope === undefined
      ? Effect.void
      : Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore),
  );
  return {
    ...deps,
    late,
    clientPolicyGrants,
    events,
    activeTurn,
    steerInjections,
    steerInjection,
    agentRequests,
    nativeChildren,
    extractSubagentUpdate,
    activeSessionId,
    contextUsageBySessionId,
    nativeMetadataBySessionId,
    providerThreadByNativeSessionId,
    nativeBuildConfigurationBySessionId,
    initialSessionActivationFailure,
    activeSessionSetup,
    setActiveSessionSetup,
    activeSelection,
    activeInteractionMode,
    promptInstructionStates,
    compactionMarkers,
    runtimeRestartRequired,
    runtimeTeardownState,
    runtimeCallbackGeneration,
    runtimeCallbackGenerationCounter,
    allocateRuntimeCallbackGeneration,
    advanceRuntimeCallbackGeneration,
    runtimeCallbackPermit,
    runtimeTransitionPermit,
    nativeResponseAcknowledgements,
    pendingRuntimeRequests,
    emitNativeResponseLifecycle,
    nextElicitationOrdinal,
    providerTurns,
    snapshot,
    awaitRuntimeTeardown,
    runRuntimeCallbackAtGeneration,
    registerNativeResponseAcknowledgement,
    acknowledgeNativeResponse,
    awaitNativeResponseAcknowledgements,
    awaitAdmittedNativeResponses,
    quarantineNativeTransportAtGeneration,
    closeNativeTransport,
    lastTurnRoute,
    wakeBuffer,
    noWakeReports,
    wakeReports,
    recordWakeReport,
    continuationRequested,
    continuationGeneration,
    continuationPermit,
    continuationClosed,
    stoppedRunQuarantine,
    carryoverSubagents,
    handledBackgroundTaskIdsInActiveTurn,
    midTurnUnreportedCompletedTaskIds,
    suppressPostSettleMonitorPrompt,
    runningBackgroundTaskIds,
    endedBackgroundTaskIds,
    endedBackgroundTaskIdLimit,
    setBackgroundTaskRunning,
    markBackgroundTaskEnded,
    applyBackgroundTaskMutationRunning,
    trackRunningBackgroundTools,
    emitProviderEvent,
    nativeLogging,
    handleRuntimeTerminationAtGeneration,
    makeRuntimeInput,
    get latestRuntimePolicy() {
      return latestRuntimePolicy;
    },
    set latestRuntimePolicy(value) {
      latestRuntimePolicy = value;
    },
    get pendingStopCloseTurn() {
      return pendingStopCloseTurn;
    },
    set pendingStopCloseTurn(value) {
      pendingStopCloseTurn = value;
    },
    get followsAgentWorkState() {
      return followsAgentWorkState;
    },
    set followsAgentWorkState(value) {
      followsAgentWorkState = value;
    },
    get agentWork() {
      return agentWork;
    },
    set agentWork(value) {
      agentWork = value;
    },
    get turnAttached() {
      return turnAttached;
    },
    set turnAttached(value) {
      turnAttached = value;
    },
    get scheduleDeferredFinalize() {
      return scheduleDeferredFinalize;
    },
    set scheduleDeferredFinalize(value) {
      scheduleDeferredFinalize = value;
    },
    get runtimeScope() {
      return runtimeScope;
    },
    set runtimeScope(value) {
      runtimeScope = value;
    },
    get runtime() {
      return runtime;
    },
    set runtime(value) {
      runtime = value;
    },
    get runtimeMcpBridge() {
      return runtimeMcpBridge;
    },
    set runtimeMcpBridge(value) {
      runtimeMcpBridge = value;
    },
  };
});
