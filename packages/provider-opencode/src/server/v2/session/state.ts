/**
 * Shared state for one OpenCode 2 provider session: threads, turn items and model windows.
 */
import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as OpenCode2Server from "../OpenCode2Server.ts";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER } from "../../adapter.ts";
import { ref } from "./protocol.ts";
import type { ActiveTurn, EventOf, ModelRef, PendingRequest, SubagentCall, ThreadState, TurnOwner } from "./types.ts";
import { OpenCode2ProviderCapabilities } from "../capabilities.ts";

interface SessionLive {
  connection: OpenCode2Server.OpenCode2Connection;
  client: OpenCode2Server.OpenCode2Connection["client"];
  currentScope: Scope.Closeable;
  streamFailure: string | undefined;
  reconnected: Deferred.Deferred<void>;
  session: OrchestrationV2ProviderSession;
}

export interface StateDeps {
  readonly instanceId: ProviderInstanceId;
  readonly driver: typeof OPENCODE_PROVIDER;
  readonly host: (typeof ProviderHost.ProviderHost)["Service"];
  readonly idAllocator: (typeof IdAllocator.IdAllocatorV2)["Service"];
  readonly mcpSessions: (typeof McpProviderSessions.McpProviderSessions)["Service"];
  readonly fileSystem: (typeof FileSystem.FileSystem)["Service"];
  readonly continuationRequests: (typeof ProviderContinuationRequests.ProviderContinuationRequests)["Service"];
  readonly mcpServerNameFor: (threadId: string) => Effect.Effect<string>;
  readonly borrow: Effect.Effect<
    OpenCode2Server.OpenCode2Connection,
    OpenCodeRuntime.OpenCodeRuntimeError,
    Scope.Scope
  >;
  readonly input: Parameters<ProviderAdapter.ProviderAdapterV2["Service"]["openSession"]>[0];
  readonly initial: {
    readonly connection: OpenCode2Server.OpenCode2Connection;
    readonly scope: Scope.Closeable;
  };
}

/** Everything one OpenCode 2 provider session shares between its helpers. */
export const createSessionState = Effect.fnUntraced(function* (deps: StateDeps) {
  const {
    instanceId,
    driver,
    host,
    idAllocator,
    mcpSessions,
    fileSystem,
    continuationRequests,
    mcpServerNameFor,
    borrow,
    input,
    initial,
  } = deps;
  const sessionScope = yield* Effect.scope;
  // Project config changes model limits; key by directory because this runtime serves all instance threads.
  const contextWindows = new Map<string, Map<string, number>>();
  const directoryOf = (cwd: string | null | undefined) => cwd ?? host.paths.cwd;
  const windowOf = (cwd: string | null | undefined, model: string) =>
    contextWindows.get(directoryOf(cwd))?.get(model);
  const now = yield* DateTime.now;
  // Cells that outlive a reconnect stay mutable behind one object the helpers close over.
  const live: SessionLive = {
    connection: initial.connection,
    client: initial.connection.client,
    currentScope: initial.scope,
    streamFailure: undefined,
    reconnected: yield* Deferred.make<void>(),
    session: {
      id: input.providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: input.runtimePolicy.cwd ?? host.paths.cwd,
      model: input.modelSelection.model,
      capabilities: OpenCode2ProviderCapabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  };

  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
  const threads = new Map<string, ThreadState>();
  const childOwners = new Map<string, ThreadState>();
  const announced = new Map<string, EventOf<"session.created">["data"]>();
  const strays = new Map<string, ThreadState>();
  const busy = new Set<string>();
  const pending = new Map<RuntimeRequestId, PendingRequest>();
  const lock = yield* Semaphore.make(1);
  const clearing = new Map<string, Deferred.Deferred<void>>();
  const stagedReverts = new Set<string>();
  const sessionGates = yield* KeyedLock.make<string>();
  const exclusive =
    (providerThread: OrchestrationV2ProviderThread) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const sessionId = providerThread.nativeThreadRef?.nativeId;
      if (sessionId == null) return effect;
      return sessionGates.withLock(sessionId, effect);
    };
  const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Queue.offer(events, event).pipe(Effect.asVoid);
  const ownerOf = (sessionId: string) => childOwners.get(sessionId) ?? threads.get(sessionId);
  const markUnsettled = (state: ThreadState) => {
    state.unsettled = true;
    state.unsettledStarted = busy.has(state.sessionId);
  };

  const newThreadState = (
    sessionId: string,
    providerThread: OrchestrationV2ProviderThread,
    directory: string,
    subagent: ThreadState["subagent"],
  ): ThreadState => ({
    sessionId,
    providerThread,
    providerTurns: new Map(),
    active: undefined,
    model: undefined,
    unsettled: false,
    unsettledStarted: false,
    directory,
    agent: "build",
    title: undefined,
    rules: undefined,
    policy: input.runtimePolicy,
    grants: [],
    calls: new Map(),
    subagent,
    wakes: [],
    reports: new Map(),
    stoppedChildren: new Set(),
    strandedSteers: new Set(),
    mcp: undefined,
    instructions: undefined,
  });

  const rootOf = (state: ThreadState): ThreadState => {
    let current = state;
    while (current.subagent !== undefined) current = current.subagent.call.state;
    return current;
  };

  const sessionsOf = (thread: ThreadState): ReadonlyArray<ThreadState> => [
    thread,
    ...[...threads.values()].filter((state) => {
      for (let above = state.subagent?.call.state; above; above = above.subagent?.call.state) {
        if (above === thread) return true;
      }
      return false;
    }),
  ];

  const runningCalls = (thread: ThreadState): ReadonlyArray<SubagentCall> =>
    sessionsOf(thread).flatMap((state) => [...state.calls.values()]);

  /**
   * The calls a subagent session answers for: the one that launched it and
   * the ones that joined it while it ran.
   */
  const callsAttachedTo = (child: ThreadState): ReadonlyArray<SubagentCall> => {
    const parent = child.subagent?.call.state;
    if (parent === undefined) return [];
    return [...parent.calls.values()].filter((candidate) => candidate.child === child);
  };

  const callsAbove = (sessionId: string) => {
    const calls: Array<SubagentCall> = [];
    let current = threads.get(sessionId);
    while (current?.subagent !== undefined) {
      calls.push(current.subagent.call);
      current = current.subagent.call.state;
    }
    return calls;
  };

  const requestTurn = (sessionId: string) => {
    const state = ownerOf(sessionId);
    if (state === undefined) return undefined;
    const background = callsAbove(sessionId).findLast((call) => call.background);
    if (background !== undefined) {
      return isOrchestrationV2WorkActive(background.status)
        ? { state, turn: background.turn }
        : undefined;
    }
    return state.active === undefined ? undefined : { state, turn: state.active };
  };

  const owesWork = (state: ThreadState) =>
    state.wakes.length > 0 ||
    state.reports.size > 0 ||
    (state.subagent !== undefined && busy.has(state.sessionId)) ||
    [...state.calls.values()].some((call) => call.background);

  const hasBackground = (thread: ThreadState) => sessionsOf(thread).some(owesWork);

  const ordinalOf = (turn: ActiveTurn, nativeId: string) => {
    const known = turn.ordinals.get(nativeId);
    if (known !== undefined) return known;
    const next = turn.nextOrdinal++;
    turn.ordinals.set(nativeId, next);
    return next;
  };

  const itemBase = (
    state: ThreadState,
    turn: ActiveTurn,
    nativeId: string,
    status: OrchestrationV2TurnItem["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
    updatedAt: DateTime.Utc,
  ) => ({
    id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId: nativeId }),
    threadId: turn.input.threadId,
    runId: turn.input.runId,
    nodeId: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
    providerThreadId: state.providerThread.id,
    providerTurnId: turn.providerTurn.id,
    nativeItemRef: ref(nativeId),
    parentItemId: null,
    ordinal: ordinalOf(turn, nativeId),
    status,
    title: null,
    startedAt,
    completedAt,
    updatedAt,
  });

  const makeTurn = (
    owner: TurnOwner,
    providerTurn: OrchestrationV2ProviderTurn,
    options: { readonly scope: string; readonly awaitingStart: boolean },
  ): ActiveTurn => ({
    input: owner,
    providerTurn,
    texts: new Map(),
    tools: new Map(),
    startedAt: new Map(),
    ordinals: new Map(),
    nextOrdinal: providerTurn.ordinal * 100 + 1,
    usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    startedSteps: 0,
    missedEvents: false,
    steps: 0,
    models: new Set(),
    lastStep: undefined,
    before: undefined,
    compaction: undefined,
    compactions: 0,
    retry: undefined,
    interrupted: false,
    unsent: false,
    steers: new Set(),
    settledInbox: new Set(),
    heldEnd: undefined,
    awaitingStart: options.awaitingStart,
    scope: options.scope,
    usedSubagents: false,
  });

  const withReportedModel = (
    providerThread: OrchestrationV2ProviderThread,
    model: ModelRef | undefined,
  ): OrchestrationV2ProviderThread => {
    if (model === undefined) return providerThread;
    const modelSelection: ModelSelection = {
      instanceId,
      model: `${model.providerID}/${model.id}`,
      options: model.variant === undefined ? [] : [{ id: "variant", value: model.variant }],
    };
    if (
      providerThread.nativeMetadata?.modelSelection !== undefined &&
      modelSelectionsEqual(providerThread.nativeMetadata.modelSelection, modelSelection)
    )
      return providerThread;
    return {
      ...providerThread,
      nativeMetadata: { ...providerThread.nativeMetadata, modelSelection },
    };
  };

  const readModels = (directory: string) =>
    Effect.suspend(() => {
      const windows = contextWindows.get(directory) ?? new Map<string, number>();
      contextWindows.set(directory, windows);
      return live.client.model.list({ location: { directory } }).pipe(
        Effect.timeout("5 seconds"),
        Effect.tap((models) =>
          Effect.sync(() => {
            for (const model of models.data) {
              windows.set(
                `${model.providerID}/${model.id}`,
                model.limit.input ?? model.limit.context,
              );
            }
          }),
        ),
        Effect.ignore({ log: true }),
      );
    });
  const readModelsOnce = (cwd: string | null | undefined) =>
    contextWindows.has(directoryOf(cwd)) ? Effect.void : readModels(directoryOf(cwd));

  return {
    instanceId,
    driver,
    host,
    idAllocator,
    mcpSessions,
    fileSystem,
    continuationRequests,
    mcpServerNameFor,
    borrow,
    input,
    live,
    sessionScope,
    contextWindows,
    directoryOf,
    windowOf,
    events,
    threads,
    childOwners,
    announced,
    strays,
    busy,
    pending,
    lock,
    clearing,
    stagedReverts,
    sessionGates,
    exclusive,
    emit,
    ownerOf,
    markUnsettled,
    newThreadState,
    rootOf,
    sessionsOf,
    runningCalls,
    callsAttachedTo,
    callsAbove,
    requestTurn,
    owesWork,
    hasBackground,
    ordinalOf,
    itemBase,
    makeTurn,
    withReportedModel,
    readModels,
    readModelsOnce,
  };
});

export type State = Effect.Success<ReturnType<typeof createSessionState>>;
