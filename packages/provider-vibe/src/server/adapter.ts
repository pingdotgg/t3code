import {
  NodeId,
  ProviderInstanceId,
  RunId,
  RunAttemptId,
  RuntimeRequestId,
  type ChatAttachment,
  type ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { vibeCallback, vibeQuestionResult } from "./callbacks.ts";
import type { VibeSettings } from "../settings.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as VibeAppServer from "@t3tools/vibe-app-server/client";
import * as VibeAppServerError from "@t3tools/vibe-app-server/errors";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { withAgentDeviceEnvironment } from "@t3tools/provider-core/server/mcpSession";
import { t3OrchestrationPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  MISTRAL_VIBE_RATE_LIMITED,
  applyVibeHistoryPatch,
  stripT3PromptInstructions,
  vibeMcpServers,
  VIBE_PROVIDER,
  buildVibeSpawnInput,
  resolveVibeModelId,
  vibeAgentForRuntimeMode,
  vibeModelWriteError,
} from "./appServerSupport.ts";
import { vibeEffectSettled, vibeHistoryTurnItem } from "./historyItems.ts";

const VibeProviderCapabilitiesV2 = {
  sessions: {
    // A vibe-app-server connection streams events for only its last attached session.
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    // T3 owns the waiting queue so model settings are applied only when a turn starts.
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
  runtimePolicy: { enforcement: "native" },
} as const satisfies OrchestrationV2ProviderCapabilities;

export interface VibeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: VibeSettings;
  readonly environment: NodeJS.ProcessEnv;
}

const decodeNativeSessionState = Schema.decodeUnknownOption(VibeAppServer.PublicSessionState);

type VibeClient = VibeAppServer.VibeAppServerClient["Service"];

interface VibePage<A> {
  readonly items: ReadonlyArray<A>;
  readonly nextCursor?: string | null | undefined;
}

const nativeRef = (nativeId: string) => ({
  driver: VIBE_PROVIDER,
  nativeId,
  strength: "strong" as const,
});

const utcFromMillis = (millis: number | null | undefined): DateTime.Utc | null =>
  millis === undefined || millis === null ? null : Option.getOrNull(DateTime.make(millis));

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const entryTime = (
  entry: Record<string, unknown>,
  key: "createdAt" | "updatedAt" | "startedAt" | "completedAt",
) => {
  const millis = entry[key];
  return typeof millis === "number" ? utcFromMillis(millis) : null;
};

function entryText(entry: unknown): string {
  const record = asRecord(entry);
  const content = record?.["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = asRecord(block);
      return b?.["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
    })
    .join("");
}

/** `-31001` is Vibe's rate-limit code. */
export function vibeTurnFailure(error: unknown): ReturnType<typeof makeProviderFailure> {
  const code = asRecord(error)?.["code"];
  const rateLimited = code === MISTRAL_VIBE_RATE_LIMITED || code === "rate_limit";
  return makeProviderFailure({
    message: rateLimited ? "Vibe usage limit reached." : "Vibe turn failed.",
    class: rateLimited ? "usage_limit" : "provider_error",
    code: typeof code === "number" || typeof code === "string" ? String(code) : null,
  });
}

interface RunIdentity {
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly ordinal: number;
}

interface AdapterState {
  session: OrchestrationV2ProviderSession;
  thread: OrchestrationV2ProviderThread | undefined;
  activeTurn:
    | {
        readonly providerTurn: OrchestrationV2ProviderTurn;
        readonly nativeTurnId: string;
        readonly run: RunIdentity | undefined;
        readonly runOrdinal: number;
      }
    | undefined;
  turnOrdinals: Map<string, number>;
  observedTurns: Map<string, OrchestrationV2ProviderTurn>;
  startingRun: RunIdentity | undefined;
  adoptingThread: Array<Effect.Effect<void>> | undefined;
  planMode: boolean;
  /** History entries by native id, so `history/entryUpdated` patches can be applied. */
  entries: Map<string, Record<string, unknown>>;
  /** Assistant/reasoning entries last projected as streaming; finalized at turn end if Vibe never does. */
  streamingEntries: Set<string>;
  /** T3 instructions ride on the prompt, so send each block once per app-server session. */
  instructionsDelivered: { orchestration: boolean; device: boolean };
  /** Maps a T3 runtime-request id to the native callback id answered via `callback/result`. */
  callbackByRequest: Map<
    RuntimeRequestId,
    {
      readonly callbackId: string;
      readonly runtimeRequest: OrchestrationV2RuntimeRequest;
      readonly turnItem?: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>;
    }
  >;
}

export const makeVibeAdapterV2 = Effect.fn("makeVibeAdapterV2")(function* (
  options: VibeAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const random = yield* SecureRandom.SecureRandom;

  // Fixed detail only: raw server text stays in `cause` and must not reach the UI.
  const protocolError = (cause: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: VIBE_PROVIDER,
      detail: "Vibe app-server request failed.",
      cause,
    });

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;

  const openSessionInner = Effect.fnUntraced(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
    const spawn = buildVibeSpawnInput(
      options.settings,
      cwd,
      withAgentDeviceEnvironment(
        // Lets tools run from the agent's shell find their T3 thread, as Claude and Codex do.
        { ...(options.environment ?? process.env), T3CODE_THREAD_ID: input.threadId },
        yield* mcpSessions.read(input.threadId),
      ),
    );
    const sessionScope = yield* Scope.Scope;
    const termination = yield* Deferred.make<never, ProviderAdapter.ProviderAdapterProtocolError>();

    const spawnClient = Effect.fn("VibeAdapterV2.spawnClient")(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawn.command, [...spawn.args], {
            forceKillAfter: "1 second",
            ...(spawn.cwd !== undefined ? { cwd: spawn.cwd } : {}),
            ...(spawn.env !== undefined ? { env: spawn.env } : {}),
          }),
        )
        .pipe(Effect.mapError(protocolError));
      const client: VibeClient = Context.get(
        yield* Layer.build(VibeAppServer.layerChildProcess(child)),
        VibeAppServer.VibeAppServerClient,
      );
      yield* Effect.addFinalizer(() =>
        child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore),
      );
      yield* Effect.mapError(
        client.initialize({
          clientName: "t3-code",
          clientVersion: "0.0.0",
          capabilities: {
            callbackKinds: ["approval", "user_input"],
            clientTools: ["filesystem/read", "filesystem/write"],
          },
        }),
        protocolError,
      );
      yield* Effect.mapError(client.initialized(), protocolError);

      return client;
    });

    const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.asVoid(PubSub.publish(events, event));

    /** Projects a stored history entry to message + turn-item events, tagged with the current run. */
    const projectHistoryEntry = Effect.fn("VibeAdapterV2.projectHistoryEntry")(function* (
      entry: Record<string, unknown>,
      nativeItemId: string,
      threadId: ThreadId,
    ) {
      if (!state.thread) return;
      const streaming = entry["generationStatus"] === "in_progress";
      if (entry["type"] === "message" || entry["type"] === "reasoning") {
        if (streaming) state.streamingEntries.add(nativeItemId);
        else state.streamingEntries.delete(nativeItemId);
      }
      if (entry["type"] !== "message") {
        const timestamp = yield* DateTime.now;
        const turnItem = vibeHistoryTurnItem(
          {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: VIBE_PROVIDER,
              nativeItemId,
            }),
            threadId,
            runId: state.activeTurn?.run?.runId ?? null,
            nodeId: state.activeTurn?.run?.rootNodeId ?? null,
            providerThreadId: state.thread.id,
            providerTurnId: state.activeTurn?.providerTurn.id ?? null,
            nativeItemRef: nativeRef(nativeItemId),
            parentItemId: null,
            ordinal: 0,
            startedAt: null,
            completedAt:
              (entry["type"] === "reasoning" && !streaming) || vibeEffectSettled(entry)
                ? timestamp
                : null,
            updatedAt: timestamp,
          },
          entry,
        );
        if (turnItem) yield* emit({ type: "turn_item.updated", driver: VIBE_PROVIDER, turnItem });
        return;
      }
      const role = str(entry["role"]);
      // User input is echoed back as a history entry and the app already owns it; system
      // entries are not conversation. Only assistant entries become messages.
      if (str(entry["type"]) !== "message" || role !== "assistant") return;
      const text = entryText(entry);
      if (!text) return;
      const messageId = idAllocator.derive.messageFromProviderItem({
        driver: VIBE_PROVIDER,
        nativeItemId,
      });
      const turnItemId = idAllocator.derive.turnItemFromProviderItem({
        driver: VIBE_PROVIDER,
        nativeItemId,
      });
      const timestamp = yield* DateTime.now;
      const message: OrchestrationV2ConversationMessage = {
        createdBy: "agent",
        creationSource: "provider",
        id: messageId,
        threadId,
        runId: state.activeTurn?.run?.runId ?? null,
        nodeId: state.activeTurn?.run?.rootNodeId ?? null,
        role: "assistant",
        text,
        attachments: [],
        streaming,
        createdAt: entryTime(entry, "createdAt") ?? timestamp,
        updatedAt: timestamp,
      };
      const item = {
        id: turnItemId,
        threadId,
        runId: state.activeTurn?.run?.runId ?? null,
        nodeId: state.activeTurn?.run?.rootNodeId ?? null,
        providerThreadId: state.thread.id,
        providerTurnId: state.activeTurn?.providerTurn.id ?? null,
        nativeItemRef: nativeRef(nativeItemId),
        parentItemId: null,
        ordinal: 0,
        status: streaming ? ("running" as const) : ("completed" as const),
        title: null,
        startedAt: null,
        completedAt: streaming ? null : timestamp,
        updatedAt: timestamp,
        type: "assistant_message" as const,
        messageId,
        text,
        textOmitted: true as const,
        streaming,
      };
      yield* emit({ type: "message.updated", driver: VIBE_PROVIDER, message });
      yield* emit({
        type: "turn_item.updated",
        driver: VIBE_PROVIDER,
        turnItem: item as OrchestrationV2TurnItem,
      });
    });

    const now = yield* DateTime.now;
    const providerSessionId = input.providerSessionId;
    const state: AdapterState = {
      session: {
        id: providerSessionId,
        driver: VIBE_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model || null,
        capabilities: VibeProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      thread: undefined,
      activeTurn: undefined,
      turnOrdinals: new Map(),
      observedTurns: new Map(),
      startingRun: undefined,
      adoptingThread: undefined,
      planMode: input.runtimePolicy.interactionMode === "plan",
      entries: new Map(),
      streamingEntries: new Set(),
      callbackByRequest: new Map(),
      instructionsDelivered: { orchestration: false, device: false },
    };

    const sessionIdOf = () => state.thread?.nativeThreadRef?.nativeId ?? undefined;

    const updateThread = Effect.fnUntraced(function* (
      patch: Partial<OrchestrationV2ProviderThread>,
    ) {
      if (!state.thread) return;
      state.thread = { ...state.thread, ...patch, updatedAt: yield* DateTime.now };
      yield* emit({
        type: "provider_thread.updated",
        driver: VIBE_PROVIDER,
        providerThread: state.thread,
      });
    });

    // Translate app-server notifications into V2 projection events.
    const onNotification = Effect.fn("VibeAdapterV2.onNotification")(function* (
      method: string,
      params: unknown,
    ) {
      const record = asRecord(params) ?? {};
      const notificationSessionId = str(record["sessionId"]);
      const currentSessionId = sessionIdOf();
      if (
        notificationSessionId !== undefined &&
        currentSessionId !== undefined &&
        notificationSessionId !== currentSessionId
      ) {
        return;
      }
      if (method === "turn/started") {
        const turn = asRecord(record["turn"]);
        const nativeTurnId = str(turn?.["id"]);
        if (!nativeTurnId || !state.thread) return;
        const ordinal = state.turnOrdinals.get(nativeTurnId) ?? state.turnOrdinals.size + 1;
        state.turnOrdinals.set(nativeTurnId, ordinal);
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: VIBE_PROVIDER,
          nativeTurnId,
        });
        if (state.observedTurns.has(nativeTurnId)) return;
        const run = state.startingRun;
        state.startingRun = undefined;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: providerTurnId,
          providerThreadId: state.thread.id,
          nodeId:
            run?.rootNodeId ?? state.thread.ownerNodeId ?? NodeId.make(`vibe-root-${nativeTurnId}`),
          runAttemptId: run?.runAttemptId ?? null,
          nativeTurnRef: nativeRef(nativeTurnId),
          ordinal,
          status: "running",
          startedAt: entryTime(turn ?? {}, "startedAt") ?? (yield* DateTime.now),
          completedAt: null,
        };
        state.activeTurn = {
          providerTurn,
          nativeTurnId,
          run,
          runOrdinal: run?.ordinal ?? state.thread.lastRunOrdinal ?? 1,
        };
        state.observedTurns.set(nativeTurnId, providerTurn);
        yield* emit({
          type: "provider_turn.updated",
          driver: VIBE_PROVIDER,
          providerTurn,
        });
        return;
      }
      if (
        method === "turn/completed" ||
        method === "turn/interrupted" ||
        method === "turn/failed"
      ) {
        const turn = asRecord(record["turn"]);
        const nativeTurnId = str(turn?.["id"]);
        if (!nativeTurnId || !state.activeTurn || !state.thread) return;
        if (state.activeTurn.nativeTurnId !== nativeTurnId) return;
        const { providerTurn, runOrdinal } = state.activeTurn;
        const providerTurnId = providerTurn.id;
        // Turn mode hides streaming text until a final snapshot, so never end a turn without one.
        for (const entryId of state.streamingEntries) {
          const entry = state.entries.get(entryId);
          if (entry)
            yield* projectHistoryEntry(
              { ...entry, generationStatus: "completed" },
              entryId,
              input.threadId,
            );
        }
        state.streamingEntries.clear();
        const completedAt = yield* DateTime.now;
        const status = str(turn?.["status"]) ?? method.replace("turn/", "");
        // A user-cancelled turn is its own terminal status, not a failure.
        const terminalStatus =
          status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "cancelled"
              : status === "interrupted"
                ? "interrupted"
                : "completed";
        const completedTurn = {
          ...providerTurn,
          status: terminalStatus,
          completedAt: entryTime(turn ?? {}, "completedAt") ?? completedAt,
        } satisfies OrchestrationV2ProviderTurn;
        state.observedTurns.set(nativeTurnId, completedTurn);
        yield* emit({
          type: "provider_turn.updated",
          driver: VIBE_PROVIDER,
          providerTurn: completedTurn,
        });
        state.activeTurn = undefined;
        const failure = terminalStatus === "failed" ? vibeTurnFailure(turn?.["error"]) : undefined;
        if (failure === undefined) {
          yield* emit({
            type: "turn.terminal",
            driver: VIBE_PROVIDER,
            providerThreadId: state.thread.id,
            providerTurnId,
            runOrdinal,
            status: terminalStatus as "cancelled" | "completed" | "interrupted",
            failure: null,
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: VIBE_PROVIDER,
            providerThreadId: state.thread.id,
            providerTurnId,
            runOrdinal,
            failureItemOrdinal: 1,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
        }
        return;
      }
      if (method === "history/entryAdded") {
        const entry = asRecord(record["entry"]);
        if (!entry || !state.thread) return;
        const nativeItemId = str(entry["id"]) ?? `${method}:${yield* random.uuidV4()}`;
        state.entries.set(nativeItemId, entry);
        yield* projectHistoryEntry(entry, nativeItemId, input.threadId);
        return;
      }
      if (method === "history/entryUpdated") {
        // Updates carry `entryId` + a JSON patch, not the full entry: apply the patch to the stored entry.
        const entryId = str(record["entryId"]);
        const stored = entryId !== undefined ? state.entries.get(entryId) : undefined;
        if (!entryId || !stored || !state.thread) return;
        const patch = Array.isArray(record["patch"]) ? record["patch"] : [];
        const patched = applyVibeHistoryPatch(stored, patch);
        state.entries.set(entryId, patched);
        yield* projectHistoryEntry(patched, entryId, input.threadId);
        return;
      }
    });
    const receiveNotification = (method: string, params: unknown) =>
      Effect.suspend(() => {
        const projection = onNotification(method, params);
        if (!state.adoptingThread) return projection;
        state.adoptingThread.push(projection);
        return Effect.void;
      });

    // Approvals and structured questions arrive as the `callback/call` server request:
    // surface them as a live runtime request, ack the call, and answer later via `callback/result`.
    const fileSystem = yield* FileSystem.FileSystem;
    const projectCallback = Effect.fn("VibeAdapterV2.projectCallback")(function* (
      callback: NonNullable<ReturnType<typeof vibeCallback>>,
    ) {
      const { callbackId, kind, questions, sessionId, turnId } = callback;
      if (sessionId !== undefined && sessionId !== sessionIdOf()) return;
      const turn = state.activeTurn;
      if (
        (turnId !== undefined && turnId !== turn?.nativeTurnId) ||
        [...state.callbackByRequest.values()].some((request) => request.callbackId === callbackId)
      )
        return;
      const requestId = yield* idAllocator.allocate
        .runtimeRequest({
          driver: VIBE_PROVIDER,
          ...(turn !== undefined ? { providerTurnId: turn.providerTurn.id } : {}),
          nativeRequestId: callbackId,
        })
        .pipe(Effect.orElseSucceed(() => undefined));
      if (requestId === undefined) return;
      const createdAt = yield* DateTime.now;
      const turnItem: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }> | undefined =
        kind === "user_input"
          ? {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: VIBE_PROVIDER,
                nativeItemId: callbackId,
              }),
              threadId: input.threadId,
              runId: turn?.run?.runId ?? null,
              nodeId: turn?.providerTurn.nodeId ?? null,
              providerThreadId: state.thread?.id ?? null,
              providerTurnId: turn?.providerTurn.id ?? null,
              nativeItemRef: nativeRef(callbackId),
              parentItemId: null,
              ordinal: 0,
              status: "waiting",
              title: null,
              startedAt: createdAt,
              completedAt: null,
              updatedAt: createdAt,
              type: "user_input_request",
              requestId,
              questions,
            }
          : undefined;
      const runtimeRequest: OrchestrationV2RuntimeRequest = {
        id: requestId,
        nodeId: turn?.providerTurn.nodeId ?? NodeId.make(`vibe-request-${requestId}`),
        providerTurnId: turn?.providerTurn.id ?? null,
        nativeRequestRef: nativeRef(callbackId),
        kind,
        status: "pending",
        responseCapability: { type: "live", providerSessionId },
        createdAt,
        resolvedAt: null,
      };
      state.callbackByRequest.set(requestId, {
        callbackId,
        runtimeRequest,
        ...(turnItem ? { turnItem } : {}),
      });
      if (turnItem) yield* emit({ type: "turn_item.updated", driver: VIBE_PROVIDER, turnItem });
      yield* emit({
        type: "runtime_request.updated",
        driver: VIBE_PROVIDER,
        threadId: input.threadId,
        runtimeRequest,
      });
    });

    const onServerRequest = Effect.fn("VibeAdapterV2.onServerRequest")(function* (
      method: string,
      params: unknown,
    ) {
      // Advertised client tools get matching handlers: serve file read/write from the session checkout.
      if (method === "clientTool/readTextFile" || method === "clientTool/writeTextFile") {
        if (state.planMode && method === "clientTool/writeTextFile") {
          return yield* new VibeAppServerError.VibeAppServerRequestError({
            method,
            code: "permission_denied",
            detail: "Vibe Plan mode cannot write files.",
          });
        }
        const record = asRecord(params) ?? {};
        const filePath = str(record["path"]);
        if (!filePath) {
          return yield* new VibeAppServerError.VibeAppServerRequestError({
            method,
            code: "invalid_params",
            detail: "path is required",
          });
        }
        // Confine reads/writes to the session checkout: resolve and reject paths outside it.
        const outsideWorkspace = () =>
          new VibeAppServerError.VibeAppServerRequestError({
            method,
            code: "invalid_params",
            detail: "path is outside the workspace",
          });
        const root = yield* fileSystem
          .realPath(cwd)
          .pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
        const absolute = path.resolve(root, filePath);
        const isInside = (candidate: string) => {
          const relative = path.relative(root, candidate);
          return !relative.startsWith("..") && !path.isAbsolute(relative);
        };
        if (!isInside(absolute)) {
          return yield* outsideWorkspace();
        }
        // Canonicalize the parent directory so a symlinked ancestor cannot redirect the I/O
        // outside the checkout, then contain-check the canonical target. The canonical path is
        // what gets read/written, so the check and the I/O cannot diverge.
        const parent = yield* fileSystem
          .realPath(path.dirname(absolute))
          .pipe(Effect.orElseSucceed(() => path.dirname(absolute)));
        const candidate = path.join(parent, path.basename(absolute));
        const resolvedOption = yield* Effect.option(fileSystem.realPath(candidate));
        const resolved = Option.getOrElse(resolvedOption, () => candidate);
        // A dangling symlink at the final component resolves nowhere: reject it explicitly.
        const linkOption = yield* Effect.option(fileSystem.readLink(candidate));
        if (Option.isSome(linkOption) && Option.isNone(resolvedOption)) {
          return yield* new VibeAppServerError.VibeAppServerRequestError({
            method,
            code: "invalid_params",
            detail: "path is a dangling symlink",
          });
        }
        if (!isInside(resolved)) {
          return yield* outsideWorkspace();
        }
        if (method === "clientTool/readTextFile") {
          const content = yield* fileSystem.readFileString(resolved).pipe(
            Effect.mapError(
              (cause) =>
                new VibeAppServerError.VibeAppServerRequestError({
                  method,
                  code: "internal_error",
                  detail: "read failed",
                  data: cause,
                }),
            ),
          );
          return { content };
        }
        const content = record["content"];
        if (typeof content !== "string") {
          return yield* new VibeAppServerError.VibeAppServerRequestError({
            method,
            code: "invalid_params",
            detail: "content is required",
          });
        }
        yield* fileSystem.writeFileString(resolved, content).pipe(
          Effect.mapError(
            (cause) =>
              new VibeAppServerError.VibeAppServerRequestError({
                method,
                code: "internal_error",
                detail: "write failed",
                data: cause,
              }),
          ),
        );
        return {};
      }
      if (method !== "callback/call") {
        return yield* new VibeAppServerError.VibeAppServerRequestError({
          method,
          code: "method_not_found",
          detail: `Unsupported vibe-app-server request: ${method}`,
        });
      }
      const callback = vibeCallback(params);
      if (!callback) return { accepted: false };
      const projection = projectCallback(callback);
      if (state.adoptingThread) state.adoptingThread.push(projection);
      else yield* projection;
      return { callbackId: callback.callbackId, accepted: true };
    });

    const openConnection = Effect.fn("VibeAdapterV2.openConnection")(function* () {
      const scope = yield* Scope.fork(sessionScope);
      const client = yield* spawnClient().pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      const connection = { client, scope, closing: false };
      yield* client.handleUnknownServerNotification((method, params) =>
        Effect.suspend(() =>
          connection.closing ? Effect.void : receiveNotification(method, params),
        ),
      );
      yield* client.handleUnknownServerRequest((method, params) =>
        Effect.suspend(() =>
          connection.closing
            ? Effect.succeed<unknown>({ accepted: false })
            : onServerRequest(method, params),
        ),
      );
      yield* client.awaitTermination.pipe(
        Effect.catch((cause) =>
          connection.closing ? Effect.void : Deferred.fail(termination, protocolError(cause)),
        ),
        Effect.forkIn(scope),
      );
      return connection;
    });
    let connection = yield* openConnection();

    const replaceConnection = Effect.fn("VibeAdapterV2.replaceConnection")(function* () {
      const old = connection;
      const next = yield* openConnection();
      old.closing = true;
      connection = next;
      const nativeSessionId = sessionIdOf();
      if (nativeSessionId) {
        yield* old.client
          .sessionStop({ sessionId: nativeSessionId })
          .pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
      }
      yield* Scope.close(old.scope, Exit.void);
    });

    // Vibe pages newest-first and `nextCursor` points at older items, so reverse the pages.
    const readAllPages = Effect.fn("VibeAdapterV2.readAllPages")(function* <A>(
      readPage: (
        cursor: string | null,
      ) => Effect.Effect<VibePage<A>, VibeAppServerError.VibeAppServerError>,
    ) {
      const pages: Array<ReadonlyArray<A>> = [];
      let cursor: string | null = null;
      do {
        const page: VibePage<A> = yield* Effect.mapError(readPage(cursor), protocolError);
        pages.push(page.items);
        cursor = page.nextCursor ?? null;
      } while (cursor !== null);
      return pages.reverse().flat();
    });

    const readAllHistoryEntries = Effect.fn("VibeAdapterV2.readAllHistoryEntries")(function* (
      nativeSessionId: string,
    ) {
      const items = yield* readAllPages((cursor) =>
        connection.client.sessionHistoryList({ sessionId: nativeSessionId, limit: 500, cursor }),
      );
      return items.flatMap((item) => {
        const entry = asRecord(item);
        return entry ? [entry] : [];
      });
    });

    const retainedTurnIds = (
      history: ReadonlyArray<Record<string, unknown>>,
      turns: ReadonlyArray<VibeAppServer.PublicTurn>,
    ) => {
      const ids = new Set<string>();
      for (const entry of history) {
        const id = str(entry["turnId"]);
        if (id) ids.add(id);
      }
      for (const turn of turns) ids.add(turn.id);
      return [...ids];
    };

    const ensureNativeThread = Effect.fn("VibeAdapterV2.ensureThread")(function* (
      ensureInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      bufferedNotifications: Array<Effect.Effect<void>>,
    ) {
      const planMode = ensureInput.runtimePolicy.interactionMode === "plan";
      if (state.thread !== undefined && planMode !== state.planMode) {
        if (state.activeTurn || state.startingRun) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: VIBE_PROVIDER,
            detail: "Let the active Vibe turn finish before switching interaction mode.",
          });
        }
        yield* replaceConnection();
      }
      const agent = vibeAgentForRuntimeMode(
        ensureInput.runtimePolicy.runtimeMode,
        ensureInput.runtimePolicy.interactionMode,
      );
      const threadCwd = ensureInput.runtimePolicy.cwd ?? cwd;
      const nativeId = ensureInput.existingProviderThread?.nativeThreadRef?.nativeId ?? undefined;
      const mcpSession = yield* mcpSessions.read(ensureInput.threadId);
      // No `worktree`: T3 already owns the checkout, so Vibe runs in place at `cwd`. Vibe
      // rejects `worktree` on resume, and `existing` fails outside linked worktrees.
      const agentConfig = {
        mcpServers: planMode ? [] : vibeMcpServers(mcpSession),
        cwd: threadCwd,
        headless: true,
        trustWorkspace: options.settings.trustWorkspace,
        ...agent,
      };
      const started = nativeId
        ? yield* Effect.mapError(
            connection.client.sessionResume({ sessionId: nativeId, agentConfig }),
            protocolError,
          )
        : yield* Effect.mapError(
            connection.client.sessionStart({
              agentConfig,
              ...(ensureInput.title ? { title: ensureInput.title } : {}),
              ...(ensureInput.modelSelection.model
                ? {
                    model: resolveVibeModelId(ensureInput.modelSelection.model),
                    sessionOnly: true,
                  }
                : {}),
              ...(getModelSelectionStringOptionValue(ensureInput.modelSelection, "thinking") !==
              undefined
                ? {
                    reasoningEffort: getModelSelectionStringOptionValue(
                      ensureInput.modelSelection,
                      "thinking",
                    ),
                  }
                : {}),
            }),
            protocolError,
          );
      const nativeThreadId = started.state.session.id;
      const retainedHistory = nativeId ? yield* readAllHistoryEntries(nativeThreadId) : [];
      const nativeTurns = started.state.turns ?? [];
      state.turnOrdinals = new Map(
        retainedTurnIds(retainedHistory, nativeTurns).map((id, index) => [id, index + 1]),
      );
      const createdAt = yield* DateTime.now;
      const thread: OrchestrationV2ProviderThread = {
        id: idAllocator.derive.providerThread({
          driver: VIBE_PROVIDER,
          providerInstanceId: options.instanceId,
          nativeThreadId,
        }),
        driver: VIBE_PROVIDER,
        providerInstanceId: options.instanceId,
        providerSessionId,
        appThreadId: ensureInput.threadId,
        ownerNodeId: ensureInput.existingProviderThread?.ownerNodeId ?? null,
        nativeThreadRef: nativeRef(nativeThreadId),
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: ensureInput.existingProviderThread?.firstRunOrdinal ?? null,
        lastRunOrdinal: ensureInput.existingProviderThread?.lastRunOrdinal ?? null,
        handoffIds: [],
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
      };
      const runningTurn = nativeTurns.find((turn) => turn.status === "in_progress");
      for (const entry of retainedHistory) {
        const entryId = str(entry["id"]);
        if (!entryId) continue;
        state.entries.set(entryId, entry);
        if (entry["generationStatus"] === "in_progress") state.streamingEntries.add(entryId);
      }
      state.thread = thread;
      state.planMode = planMode;
      yield* emit({
        type: "provider_thread.updated",
        driver: VIBE_PROVIDER,
        providerThread: thread,
      });
      if (runningTurn) {
        yield* onNotification("turn/started", { sessionId: nativeThreadId, turn: runningTurn });
      }
      for (const projection of bufferedNotifications) yield* projection;
      return thread;
    });

    const turnInputLock = yield* Semaphore.make(1);

    const adoptThread: ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"] = (
      ensureInput,
    ) =>
      Effect.suspend(() => {
        const notifications: Array<Effect.Effect<void>> = [];
        state.adoptingThread = notifications;
        return ensureNativeThread(ensureInput, notifications).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.adoptingThread = undefined;
            }),
          ),
        );
      });

    const ensureThread: ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"] = (input) =>
      turnInputLock.withPermits(1)(adoptThread(input));

    const attachmentBlocks = Effect.fn("VibeAdapterV2.attachmentBlocks")(function* (
      attachments: ReadonlyArray<ChatAttachment>,
    ) {
      return yield* Effect.forEach(attachments, (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = host.resolveAttachmentPath(attachment);
          if (attachment.type !== "image" || attachmentPath === null) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: VIBE_PROVIDER,
              detail: "Vibe can only send readable image attachments.",
              reason: "attachment_unreadable",
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: VIBE_PROVIDER,
                  detail: "Vibe could not read the attached image.",
                  reason: "attachment_unreadable",
                  cause,
                }),
            ),
          );
          const data = Buffer.from(bytes).toString("base64");
          return {
            type: "image",
            attachment: {
              source: { kind: "inline", data },
              alias: attachment.name,
              mimeType: attachment.mimeType,
            },
          };
        }),
      );
    });

    const startTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = Effect.fn(
      "VibeAdapterV2.startTurn",
    )(function* (turnInput) {
      const nativeSessionId = sessionIdOf();
      if (!nativeSessionId) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: VIBE_PROVIDER,
          detail: "No Mistral Vibe session owns this thread.",
        });
      }
      if (state.activeTurn || state.startingRun) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: VIBE_PROVIDER,
          detail: "Wait for the active Vibe turn to finish before starting another.",
        });
      }
      if ((turnInput.runtimePolicy.interactionMode === "plan") !== state.planMode) {
        yield* adoptThread({
          threadId: turnInput.threadId,
          existingProviderThread: turnInput.providerThread,
          runtimePolicy: turnInput.runtimePolicy,
          modelSelection: turnInput.modelSelection,
        });
      }
      const images = yield* attachmentBlocks(turnInput.message.attachments);
      const modelAlias = resolveVibeModelId(turnInput.modelSelection.model);
      const modelWriteRejected = (cause: unknown) =>
        new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: VIBE_PROVIDER,
          threadId: turnInput.threadId,
          providerThreadId: turnInput.providerThread.id,
          runId: turnInput.runId,
          cause: vibeModelWriteError(modelAlias, cause),
        });
      const modelWrite = yield* connection.client
        .configModelWrite({
          sessionId: nativeSessionId,
          modelAlias,
          reasoningEffort: getModelSelectionStringOptionValue(turnInput.modelSelection, "thinking"),
          sessionOnly: true,
        })
        .pipe(Effect.mapError(modelWriteRejected));
      if (modelWrite.rejected || modelWrite.failures?.length) {
        return yield* modelWriteRejected(modelWrite);
      }
      const mcpSession = yield* mcpSessions.read(turnInput.threadId);
      const hasDeviceTools = !state.planMode && mcpSession?.capabilities?.has("device") === true;
      const promptText = t3OrchestrationPrompt({
        prompt: turnInput.message.text,
        hasT3Mcp: !state.planMode && mcpSession !== undefined,
        hasDeviceTools,
        orchestrationDelivered: state.instructionsDelivered.orchestration,
        deviceInstructionsDelivered: state.instructionsDelivered.device,
      });
      state.startingRun = {
        runId: turnInput.runId,
        runAttemptId: turnInput.attemptId,
        rootNodeId: turnInput.rootNodeId,
        ordinal: turnInput.runOrdinal,
      };
      const { turn } = yield* connection.client
        .turnStart({
          sessionId: nativeSessionId,
          message: [{ type: "text", text: promptText }, ...images],
        })
        .pipe(
          Effect.mapError(protocolError),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.sync(() => {
                  state.startingRun = undefined;
                })
              : Effect.void,
          ),
        );
      yield* onNotification("turn/started", { sessionId: nativeSessionId, turn });
      if (!state.planMode && mcpSession !== undefined) {
        state.instructionsDelivered = {
          orchestration: true,
          device: state.instructionsDelivered.device || hasDeviceTools,
        };
      }
      yield* updateThread({ status: "active" });
    }, turnInputLock.withPermits(1));

    const steerTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["steerTurn"] = Effect.fn(
      "VibeAdapterV2.steerTurn",
    )(function* (steerInput) {
      const nativeSessionId = sessionIdOf();
      if (!nativeSessionId || !state.activeTurn) {
        return yield* new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
          driver: VIBE_PROVIDER,
          providerThreadId: steerInput.providerThread.id,
        });
      }
      const activeTurn = state.activeTurn;
      if (activeTurn.providerTurn.id !== steerInput.providerTurnId) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: VIBE_PROVIDER,
          detail: "The Vibe turn to steer is no longer active.",
        });
      }
      const images = yield* attachmentBlocks(steerInput.message.attachments);
      yield* Effect.mapError(
        connection.client.turnSteer({
          sessionId: nativeSessionId,
          expectedTurnId: activeTurn.nativeTurnId,
          message: [{ type: "text", text: steerInput.message.text }, ...images],
        }),
        protocolError,
      );
    });

    const interruptTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"] =
      Effect.fn("VibeAdapterV2.interruptTurn")(function* (interruptInput) {
        const nativeSessionId = sessionIdOf();
        if (!nativeSessionId) {
          return yield* new ProviderAdapter.ProviderAdapterSessionStoppedError({
            driver: VIBE_PROVIDER,
          });
        }
        const activeTurn = state.activeTurn;
        if (!activeTurn) return;
        if (activeTurn.providerTurn.id !== interruptInput.providerTurnId) {
          if (interruptInput.requestRuntimeRestart) return;
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: VIBE_PROVIDER,
            detail: "The Vibe turn to stop is no longer active.",
          });
        }
        yield* Effect.mapError(
          connection.client.turnInterrupt({
            sessionId: nativeSessionId,
            expectedTurnId: activeTurn.nativeTurnId,
          }),
          protocolError,
        );
      });

    const respondToRuntimeRequest: ProviderAdapter.ProviderAdapterV2SessionRuntime["respondToRuntimeRequest"] =
      Effect.fn("VibeAdapterV2.respondToRuntimeRequest")(function* (responseInput) {
        const nativeSessionId = sessionIdOf();
        if (!nativeSessionId) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: VIBE_PROVIDER,
            detail: "No Mistral Vibe session owns this runtime request.",
          });
        }
        const pending = state.callbackByRequest.get(responseInput.requestId);
        if (!pending) {
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: VIBE_PROVIDER,
            detail: "The Vibe runtime request is no longer pending.",
          });
        }
        const { callbackId, runtimeRequest } = pending;
        const requestKind = runtimeRequest.kind;
        // An answer-only response (no decision) on a user_input callback must still deliver the
        // answers; defaulting to cancel here would discard them.
        const decision =
          responseInput.decision ?? (requestKind === "user_input" ? undefined : "cancel");
        // vibe-app-server CallbackOutput contract: approvals and user input have distinct envelopes.
        const output =
          requestKind === "user_input"
            ? vibeQuestionResult(
                pending.turnItem?.questions ?? [],
                responseInput.answers ?? {},
                decision === "cancel",
              )
            : {
                type: "approval" as const,
                decision: {
                  type: (decision === "accept"
                    ? "approve"
                    : decision === "acceptForSession"
                      ? "approve_for_session"
                      : decision === "acceptAlways"
                        ? "approve_permanently"
                        : decision === "decline"
                          ? "deny"
                          : "cancel_turn") as string,
                },
                ...(responseInput.feedback ? { feedback: responseInput.feedback } : {}),
              };
        yield* Effect.mapError(
          connection.client.callbackResult({
            sessionId: nativeSessionId,
            callbackId,
            result: output,
          }),
          protocolError,
        );
        state.callbackByRequest.delete(responseInput.requestId);
        const resolvedAt = yield* DateTime.now;
        if (pending.turnItem) {
          yield* emit({
            type: "turn_item.updated",
            driver: VIBE_PROVIDER,
            turnItem: {
              ...pending.turnItem,
              status: decision === "cancel" ? "cancelled" : "completed",
              completedAt: resolvedAt,
              updatedAt: resolvedAt,
            },
          });
        }
        yield* emit({
          type: "runtime_request.updated",
          driver: VIBE_PROVIDER,
          runtimeRequest: {
            ...runtimeRequest,
            status: "resolved",
            resolvedAt,
            decision,
            ...(responseInput.answers ? { answers: responseInput.answers } : {}),
          } satisfies OrchestrationV2RuntimeRequest,
        });
      });

    const buildThreadSnapshot = Effect.fn("VibeAdapterV2.buildThreadSnapshot")(function* (
      providerThread: OrchestrationV2ProviderThread,
      historyEntries: ReadonlyArray<Record<string, unknown>>,
      nativeTurns: ReadonlyArray<VibeAppServer.PublicTurn>,
      persistedTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
    ) {
      const nativeSessionId = providerThread.nativeThreadRef?.nativeId;
      const now = yield* DateTime.now;
      const messages: OrchestrationV2ConversationMessage[] = [];
      for (const entry of historyEntries) {
        const role = entry["role"];
        if (entry["type"] !== "message" || (role !== "user" && role !== "assistant")) continue;
        const text =
          role === "user" ? stripT3PromptInstructions(entryText(entry)) : entryText(entry);
        if (!text) continue;
        const nativeItemId = str(entry["id"]) ?? `entry-${messages.length}`;
        const createdAt = entryTime(entry, "createdAt") ?? now;
        messages.push({
          createdBy: role === "user" ? "user" : "agent",
          creationSource: "provider",
          id: idAllocator.derive.messageFromProviderItem({
            driver: VIBE_PROVIDER,
            nativeItemId,
          }),
          threadId: input.threadId,
          runId: null,
          nodeId: null,
          role,
          text,
          attachments: [],
          streaming: false,
          createdAt,
          updatedAt: entryTime(entry, "updatedAt") ?? createdAt,
        });
      }
      // Vibe 3.1.2 exposes authoritative state for the latest turn. Older statuses
      // come from T3's observations when available; history supplies their order.
      const latestTurns = new Map(nativeTurns.map((turn) => [turn.id, turn]));
      const knownTurns = new Map(persistedTurns.map((turn) => [turn.id, turn]));
      const historyTimes = new Map<
        string,
        { startedAt: DateTime.Utc | null; completedAt: DateTime.Utc | null }
      >();
      for (const entry of historyEntries) {
        const id = str(entry["turnId"]);
        if (!id) continue;
        const previous = historyTimes.get(id);
        historyTimes.set(id, {
          startedAt: previous?.startedAt ?? entryTime(entry, "createdAt"),
          completedAt: entryTime(entry, "updatedAt") ?? previous?.completedAt ?? null,
        });
      }
      const providerTurns: OrchestrationV2ProviderTurn[] = retainedTurnIds(
        historyEntries,
        nativeTurns,
      ).map((id, index) => {
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: VIBE_PROVIDER,
          nativeTurnId: id,
        });
        const observed =
          (nativeSessionId === sessionIdOf() ? state.observedTurns.get(id) : undefined) ??
          knownTurns.get(providerTurnId);
        const latest = latestTurns.get(id);
        const status = latest?.status;
        const times = historyTimes.get(id);
        return {
          id: providerTurnId,
          providerThreadId: providerThread.id,
          nodeId: observed?.nodeId ?? providerThread.ownerNodeId ?? NodeId.make(`vibe-root-${id}`),
          runAttemptId: observed?.runAttemptId ?? null,
          nativeTurnRef: nativeRef(id),
          ordinal: index + 1,
          status:
            status === "in_progress"
              ? "running"
              : status === "interrupted" ||
                  status === "failed" ||
                  status === "cancelled" ||
                  status === "completed"
                ? status
                : (observed?.status ?? "completed"),
          startedAt:
            utcFromMillis(latest?.startedAt) ?? observed?.startedAt ?? times?.startedAt ?? null,
          completedAt:
            latest !== undefined
              ? utcFromMillis(latest.completedAt)
              : (observed?.completedAt ?? times?.completedAt ?? null),
        };
      });
      return {
        providerThread,
        providerTurns,
        messages,
        runtimeRequests: [],
      } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
    });

    const readThreadSnapshot = Effect.fn("VibeAdapterV2.readThreadSnapshot")(function* (
      snapshotInput: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput,
    ) {
      const nativeSessionId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
      if (!nativeSessionId) {
        return yield* new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
          driver: VIBE_PROVIDER,
          providerThreadId: snapshotInput.providerThread.id,
        });
      }
      const historyEntries = yield* readAllHistoryEntries(nativeSessionId);
      const { state: nativeState } = yield* connection.client
        .sessionRead({ sessionId: nativeSessionId, history: null, turns: { limit: 1 } })
        .pipe(Effect.mapError(protocolError));
      return yield* buildThreadSnapshot(
        snapshotInput.providerThread,
        historyEntries,
        nativeState.turns ?? [],
        [],
      );
    });

    const rollbackThread: ProviderAdapter.ProviderAdapterV2SessionRuntime["rollbackThread"] =
      Effect.fn("VibeAdapterV2.rollbackThread")(function* (rollbackInput) {
        const nativeSessionId = rollbackInput.providerThread.nativeThreadRef?.nativeId;
        if (!nativeSessionId) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: VIBE_PROVIDER,
            providerThreadId: rollbackInput.providerThread.id,
          });
        }
        if (rollbackInput.target.type === "thread_start") {
          // Vibe has no native "reset conversation" call; report it as unsupported instead of
          // returning an unchanged snapshot that would leave history intact.
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: VIBE_PROVIDER,
            providerThreadId: rollbackInput.providerThread.id,
            checkpointId: rollbackInput.target.checkpointId,
          });
        }
        // session/rewind takes a history entry id, not a turn id: resolve the input entry of the target turn.
        const targetTurnId = rollbackInput.target.providerTurn.nativeTurnRef?.nativeId;
        if (!targetTurnId) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: VIBE_PROVIDER,
            providerThreadId: rollbackInput.providerThread.id,
            checkpointId: rollbackInput.target.checkpointId,
          });
        }
        // session/rewind takes a history entry id, not a turn id: resolve the input entry of the
        // target turn across all history pages so older targets are found too.
        const historyEntries = yield* readAllHistoryEntries(nativeSessionId);
        const anchor = historyEntries.findIndex(
          (entry) => str(entry["turnId"]) === targetTurnId && str(entry["role"]) === "user",
        );
        const entryId = str(historyEntries[anchor]?.["id"]);
        if (entryId === undefined) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: VIBE_PROVIDER,
            providerThreadId: rollbackInput.providerThread.id,
            checkpointId: rollbackInput.target.checkpointId,
          });
        }
        const rewind = yield* Effect.mapError(
          connection.client.request("session/rewind", {
            sessionId: nativeSessionId,
            entryId,
            inplace: true,
          }),
          (cause) =>
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: VIBE_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              checkpointId: rollbackInput.target.checkpointId,
              cause,
            }),
        );
        // Rewind removes its anchor. Use the retained prefix and returned state without
        // another RPC, so an acknowledgement is enough to finish T3's checkpoint restore.
        const nativeState = decodeNativeSessionState(asRecord(rewind)?.["state"]);
        const retainedHistory = historyEntries.slice(0, anchor);
        const snapshot = yield* buildThreadSnapshot(
          rollbackInput.providerThread,
          retainedHistory,
          Option.getOrUndefined(nativeState)?.turns ?? [],
          rollbackInput.providerThreadTurns,
        );
        if (nativeSessionId === sessionIdOf()) {
          state.turnOrdinals.clear();
          state.entries.clear();
          state.streamingEntries.clear();
          for (const entry of retainedHistory) {
            const id = str(entry["id"]);
            if (id) state.entries.set(id, entry);
          }
          for (const turn of snapshot.providerTurns) {
            const nativeTurnId = turn.nativeTurnRef?.nativeId;
            if (nativeTurnId) state.turnOrdinals.set(nativeTurnId, turn.ordinal);
          }
          for (const nativeTurnId of state.observedTurns.keys()) {
            if (!state.turnOrdinals.has(nativeTurnId)) state.observedTurns.delete(nativeTurnId);
          }
        }
        return snapshot;
      });

    const forkThread: ProviderAdapter.ProviderAdapterV2SessionRuntime["forkThread"] = (forkInput) =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterForkThreadError({
          driver: VIBE_PROVIDER,
          providerThreadId: forkInput.sourceProviderThread.id,
          cause: "Vibe forks go through T3's context handoff.",
        }),
      );

    return {
      instanceId: options.instanceId,
      driver: VIBE_PROVIDER,
      providerSessionId,
      providerSession: state.session,
      // Fail the event stream when the app-server process dies so pumps don't wait forever.
      events: Stream.merge(
        Stream.fromPubSub(events),
        Stream.fromEffect(Deferred.await(termination)),
      ),
      ensureThread,
      resumeThread: (resumeInput) =>
        ensureThread({
          threadId: resumeInput.threadId ?? input.threadId,
          modelSelection: resumeInput.modelSelection ?? input.modelSelection,
          runtimePolicy: resumeInput.runtimePolicy ?? input.runtimePolicy,
          providerSessionId,
          existingProviderThread: resumeInput.providerThread,
        }),
      startTurn,
      steerTurn,
      interruptTurn,
      respondToRuntimeRequest,
      readThreadSnapshot,
      rollbackThread,
      forkThread,
    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: VIBE_PROVIDER,
    getCapabilities: Effect.fn("VibeAdapterV2.getCapabilities")(function () {
      return Effect.succeed(VibeProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("VibeAdapterV2.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("VibeAdapterV2.openSession")(function* (input) {
      return yield* Effect.provideService(
        Effect.provideService(
          Effect.provideService(
            openSessionInner(input),
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
          FileSystem.FileSystem,
          fileSystem,
        ),
        Path.Path,
        path,
      );
    }),
  });
});

export type VibeAdapterV2Env =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | SecureRandom.SecureRandom
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;
