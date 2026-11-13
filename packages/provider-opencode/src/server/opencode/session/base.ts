/**
 * OpenCode v1 provider session state: services, native caches and the low-level SDK call helpers.
 */
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as OpenCodeRuntime from "../../OpenCodeRuntime.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  OpenCodeProviderCapabilitiesV2,
} from "../capabilities.ts";
import {
  isOpenCodeNotFound,
} from "../projection.ts";
import {
  makeOpenCodeProtocolLogger,
  sdkResponseForRawLog,
} from "../protocol.ts";
import {
  OPENCODE_PROVIDER,
} from "../provider.ts";
import type {
  OpenCodeAdapterV2Options,
  OpenCodeSubagentContext,
  OpenCodeThreadState,
  PendingOpenCodeRequest,
} from "../types.ts";

type OpenCodeRuntimeService = (typeof OpenCodeRuntime.OpenCodeRuntime)["Service"];
type OpenCodeConnection = Effect.Success<ReturnType<OpenCodeRuntimeService["connectToOpenCodeServer"]>>;
type OpenCodeClient = ReturnType<OpenCodeRuntimeService["createOpenCodeSdkClient"]>;

export interface OpenCodeSessionDeps {
  readonly options: OpenCodeAdapterV2Options;
  readonly input: ProviderAdapter.ProviderAdapterV2OpenSessionInput;
  readonly connection: OpenCodeConnection;
  readonly client: OpenCodeClient;
  readonly cwd: string;
  readonly scope: Scope.Scope;
  readonly mcpSession: Effect.Success<ReturnType<(typeof McpProviderSessions.McpProviderSessions)["Service"]["read"]>>;
  readonly hasT3Mcp: boolean;
  readonly orchestrationSystemPrompt: string | undefined;
  readonly runtime: (typeof OpenCodeRuntime.OpenCodeRuntime)["Service"];
  readonly idAllocator: (typeof IdAllocator.IdAllocatorV2)["Service"];
  readonly host: (typeof ProviderHost.ProviderHost)["Service"];
  readonly mcpSessions: (typeof McpProviderSessions.McpProviderSessions)["Service"];
  readonly messageIdClock: Ref.Ref<{ readonly epochMillis: number; readonly counter: number }>;
}

export const createOpenCodeSessionState = Effect.fnUntraced(function* (deps: OpenCodeSessionDeps) {
  const {
    options,
    input,
    connection,
    client,
    cwd,
    scope,
    mcpSession,
    hasT3Mcp,
    orchestrationSystemPrompt,
    runtime,
    idAllocator,
    host,
    mcpSessions,
    messageIdClock,
  } = deps;
  const now = yield* DateTime.now;
  let sessionEntity: OrchestrationV2ProviderSession = {
    id: input.providerSessionId,
    driver: OPENCODE_PROVIDER,
    providerInstanceId: options.instanceId,
    status: "ready",
    cwd,
    model: input.modelSelection.model,
    capabilities: OpenCodeProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
  let nativeStreamFailure: OrchestrationV2ProviderFailure | null = null;
  const threads = new Map<string, OpenCodeThreadState>();
  const commandReceipts = new Map<string, Deferred.Deferred<void>>();
  const commandControllers = new Map<string, Set<AbortController>>();
  const pendingRequests = new Map<string, PendingOpenCodeRequest>();
  const pendingRequestsByNativeId = new Map<string, PendingOpenCodeRequest>();
  const subagentsByNativeItemId = new Map<string, OpenCodeSubagentContext>();
  const subagentsByChildSessionId = new Map<string, OpenCodeSubagentContext>();
  const relatedSessionOwners = new Map<string, OpenCodeThreadState>();
  // Busy children outlive parent settlement; keep their server open.
  const busySessionIds = new Set<string>();
  // Remember settled requests across routing retries to prevent resurrection; only recent IDs matter.
  const settledNativeRequestIds = new Set<string>();
  const pendingChildRequestRoutes = new Set<string>();
  const rememberSettledRequest = (nativeRequestId: string) => {
    if (settledNativeRequestIds.size >= 2_048) settledNativeRequestIds.clear();
    settledNativeRequestIds.add(nativeRequestId);
  };
  // @effect-diagnostics-next-line abortControllerInEffect:off - Session closure aborts this stream independently of the creation fiber.
  const abortController = new AbortController();
  let closing = false;
  let hasConnected = false;

  const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
    Queue.offer(events, event).pipe(Effect.asVoid);

  const logProtocolEvent = makeOpenCodeProtocolLogger({
    nativeEventLogger: options.nativeEventLogger,
    idAllocator,
    providerInstanceId: options.instanceId,
    providerSessionId: input.providerSessionId,
    threadId: input.threadId,
  });

  const sdkCall = <A>(
    method: string,
    payload: unknown,
    call: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, OpenCodeRuntime.OpenCodeRuntimeError> =>
    logProtocolEvent({
      direction: "outgoing",
      messageKind: "request",
      method,
      payload,
    }).pipe(
      Effect.andThen(OpenCodeRuntime.runOpenCodeSdk(method, call)),
      Effect.tap((response) =>
        logProtocolEvent({
          direction: "incoming",
          messageKind: "response",
          method,
          payload: sdkResponseForRawLog(response),
        }),
      ),
    );

  const abortDescendants = Effect.fn("OpencodeAdapter.abortDescendants")(function* (
    rootId: string,
  ) {
    const visited = new Set([rootId]);
    const semaphore = Semaphore.makeUnsafe(8);
    const visit = Effect.fn("OpencodeAdapter.visit")(function* (
      sessionId: string,
      abort: boolean,
    ): Effect.fn.Return<OpenCodeRuntime.OpenCodeRuntimeError | undefined> {
      const abortResult = abort
        ? yield* sdkCall("session.abort", { sessionID: sessionId }, (signal) =>
            client.session.abort({ sessionID: sessionId }, { signal }),
          ).pipe(
            semaphore.withPermit,
            Effect.catchIf(isOpenCodeNotFound, () => Effect.void),
            Effect.result,
          )
        : undefined;
      const childrenResult = yield* sdkCall(
        "session.children",
        { sessionID: sessionId },
        (signal) => client.session.children({ sessionID: sessionId }, { signal }),
      ).pipe(
        semaphore.withPermit,
        Effect.catchIf(isOpenCodeNotFound, () => Effect.void),
        Effect.result,
      );
      const firstFailure = abortResult?._tag === "Failure" ? abortResult.failure : undefined;
      if (childrenResult._tag === "Failure") return firstFailure ?? childrenResult.failure;
      const fresh = (childrenResult.success?.data ?? []).filter((child) => {
        if (visited.has(child.id)) return false;
        visited.add(child.id);
        return true;
      });
      const failures = yield* Effect.forEach(fresh, (child) => visit(child.id, true), {
        concurrency: 8,
      });
      return firstFailure ?? failures.find((failure) => failure !== undefined);
    });
    const failure = yield* visit(rootId, false);
    if (failure) return yield* failure;
  }, Effect.timeout("15 seconds"));

  const inputProviderSessionId = input.providerSessionId;

  return {
    options,
    input,
    connection,
    client,
    cwd,
    scope,
    mcpSession,
    hasT3Mcp,
    orchestrationSystemPrompt,
    runtime,
    idAllocator,
    host,
    mcpSessions,
    messageIdClock,
    now,
    events,
    threads,
    commandReceipts,
    commandControllers,
    pendingRequests,
    pendingRequestsByNativeId,
    subagentsByNativeItemId,
    subagentsByChildSessionId,
    relatedSessionOwners,
    busySessionIds,
    settledNativeRequestIds,
    pendingChildRequestRoutes,
    rememberSettledRequest,
    abortController,
    emitProviderEvent,
    logProtocolEvent,
    sdkCall,
    abortDescendants,
    inputProviderSessionId,
    mutable: {
    get sessionEntity() {
      return sessionEntity;
    },
    set sessionEntity(value) {
      sessionEntity = value;
    },
    get nativeStreamFailure() {
      return nativeStreamFailure;
    },
    set nativeStreamFailure(value) {
      nativeStreamFailure = value;
    },
    get closing() {
      return closing;
    },
    set closing(value) {
      closing = value;
    },
    get hasConnected() {
      return hasConnected;
    },
    set hasConnected(value) {
      hasConnected = value;
    },
    },
  };
});

export type State = Effect.Success<ReturnType<typeof createOpenCodeSessionState>>;
