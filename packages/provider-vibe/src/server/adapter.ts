import {
  NodeId,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  RuntimeRequestId,
  type ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { VibeSettings } from "../settings.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
    supportsRuntimeModeSwitchInSession: true,
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
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
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

type VibeClient = VibeAppServer.VibeAppServerClient["Service"];

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

/** Maps a vibe turn error/stop reason to the native failure contract; `-31001` is Vibe's rate limit. */
export function vibeTurnFailure(turn: {
  readonly status?: unknown;
  readonly error?: unknown;
  readonly stopReason?: unknown;
}): ReturnType<typeof makeProviderFailure> | undefined {
  const error = asRecord(turn.error);
  const code = error?.["code"];
  const message = str(error?.["message"]) ?? str(turn.stopReason) ?? "Vibe turn failed.";
  return makeProviderFailure({
    message,
    ...(typeof code === "number" || typeof code === "string"
      ? {
          code: String(code),
          class:
            code === MISTRAL_VIBE_RATE_LIMITED
              ? ("usage_limit" as const)
              : ("provider_error" as const),
        }
      : { class: "provider_error" as const }),
  });
}

interface AdapterState {
  session: OrchestrationV2ProviderSession;
  thread: OrchestrationV2ProviderThread | undefined;
  activeTurn:
    | { readonly providerTurnId: ProviderTurnId; readonly nativeTurnId: string }
    | undefined;
  turnOrdinals: Map<string, number>;
  lastRunOrdinal: number;
  /** The current run's identity, attached to every turn/message/item projection. */
  currentRun:
    | {
        readonly runId: RunId;
        readonly runAttemptId: RunAttemptId;
        readonly rootNodeId: NodeId;
      }
    | undefined;
  /** History entries by native id, so `history/entryUpdated` patches can be applied. */
  entries: Map<string, Record<string, unknown>>;
  /** T3 instructions ride on the prompt, so send each block once per app-server session. */
  instructionsDelivered: { orchestration: boolean; device: boolean };
  /** Maps a T3 runtime-request id to the native callback id answered via `callback/result`. */
  callbackByRequest: Map<
    RuntimeRequestId,
    { readonly callbackId: string; readonly kind: "permission" | "user_input" }
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

  const openSessionInner = Effect.fn("VibeAdapterV2.openSession")(function* (
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
      if (entry["type"] !== "message") {
        const timestamp = yield* DateTime.now;
        const turnItem = vibeHistoryTurnItem(
          {
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: VIBE_PROVIDER,
              nativeItemId,
            }),
            threadId,
            runId: state.currentRun?.runId ?? null,
            nodeId: state.currentRun?.rootNodeId ?? null,
            providerThreadId: state.thread.id,
            providerTurnId: state.activeTurn?.providerTurnId ?? null,
            nativeItemRef: nativeRef(nativeItemId),
            parentItemId: null,
            ordinal: 0,
            startedAt: null,
            completedAt:
              entry["type"] === "reasoning" || vibeEffectSettled(entry) ? timestamp : null,
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
        runId: state.currentRun?.runId ?? null,
        nodeId: state.currentRun?.rootNodeId ?? null,
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const item = {
        id: turnItemId,
        threadId,
        runId: state.currentRun?.runId ?? null,
        nodeId: state.currentRun?.rootNodeId ?? null,
        providerThreadId: state.thread.id,
        providerTurnId: state.activeTurn?.providerTurnId ?? null,
        nativeItemRef: nativeRef(nativeItemId),
        parentItemId: null,
        ordinal: 0,
        status: "completed" as const,
        title: null,
        startedAt: null,
        completedAt: timestamp,
        updatedAt: timestamp,
        type: "assistant_message" as const,
        messageId,
        text,
        textOmitted: true as const,
        streaming: false as const,
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
      lastRunOrdinal: 0,
      currentRun: undefined,
      entries: new Map(),
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
    yield* client.handleUnknownServerNotification(
      Effect.fn("VibeAdapterV2.onNotification")(function* (method: string, params: unknown) {
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
          state.activeTurn = { providerTurnId, nativeTurnId };
          const startedAt = yield* DateTime.now;
          const providerTurn: OrchestrationV2ProviderTurn = {
            id: providerTurnId,
            providerThreadId: state.thread.id,
            nodeId: state.currentRun?.rootNodeId ?? NodeId.make(`vibe-root-${nativeTurnId}`),
            runAttemptId: state.currentRun?.runAttemptId ?? null,
            nativeTurnRef: nativeRef(nativeTurnId),
            ordinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
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
          const { providerTurnId } = state.activeTurn;
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
          yield* emit({
            type: "provider_turn.updated",
            driver: VIBE_PROVIDER,
            providerTurn: {
              id: providerTurnId,
              providerThreadId: state.thread.id,
              nodeId: state.currentRun?.rootNodeId ?? NodeId.make(`vibe-root-${nativeTurnId}`),
              runAttemptId: state.currentRun?.runAttemptId ?? null,
              nativeTurnRef: nativeRef(nativeTurnId),
              ordinal: state.turnOrdinals.get(nativeTurnId) ?? 1,
              status: terminalStatus === "failed" ? "failed" : terminalStatus,
              startedAt: null,
              completedAt,
            },
          });
          const failure =
            terminalStatus === "failed"
              ? vibeTurnFailure({
                  status,
                  error: turn?.["error"],
                  stopReason: turn?.["stopReason"],
                })
              : undefined;
          if (failure === undefined) {
            yield* emit({
              type: "turn.terminal",
              driver: VIBE_PROVIDER,
              providerThreadId: state.thread.id,
              providerTurnId,
              runOrdinal: Math.max(1, state.lastRunOrdinal),
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
              runOrdinal: Math.max(1, state.lastRunOrdinal),
              failureItemOrdinal: 1,
              status: "failed",
              failure,
              threadDisposition: "reusable",
            });
          }
          state.activeTurn = undefined;
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
      }),
    );

    // Approvals and structured questions arrive as the `callback/call` server request:
    // surface them as a live runtime request, ack the call, and answer later via `callback/result`.
    const fileSystem = yield* FileSystem.FileSystem;
    const onServerRequest = Effect.fn("VibeAdapterV2.onServerRequest")(function* (
      method: string,
      params: unknown,
    ) {
      const toWireError = (cause: unknown) =>
        new VibeAppServerError.VibeAppServerRequestError({
          method,
          code: "internal_error",
          detail: "Failed to allocate runtime request.",
          data: cause,
        });
      // Advertised client tools get matching handlers: serve file read/write from the session checkout.
      if (method === "clientTool/readTextFile" || method === "clientTool/writeTextFile") {
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
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
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
      const callback = asRecord(asRecord(params)?.["callback"]);
      const callbackId = str(callback?.["callbackId"]) ?? str(callback?.["callback_id"]);
      if (!callbackId) {
        return { accepted: false };
      }
      const requestId = yield* idAllocator.allocate
        .runtimeRequest({
          driver: VIBE_PROVIDER,
          ...(state.activeTurn !== undefined
            ? { providerTurnId: state.activeTurn.providerTurnId }
            : {}),
          nativeRequestId: callbackId,
        })
        .pipe(Effect.mapError(toWireError));
      const kind =
        str(callback?.["kind"]) === "user_input"
          ? ("user_input" as const)
          : ("permission" as const);
      state.callbackByRequest.set(requestId, { callbackId, kind });
      const createdAt = yield* DateTime.now;
      yield* emit({
        type: "runtime_request.updated",
        driver: VIBE_PROVIDER,
        threadId: input.threadId,
        runtimeRequest: {
          id: requestId,
          nodeId: state.currentRun?.rootNodeId ?? NodeId.make(`vibe-request-${requestId}`),
          providerTurnId: state.activeTurn?.providerTurnId ?? null,
          nativeRequestRef: nativeRef(callbackId),
          kind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId },
          createdAt,
          resolvedAt: null,
        } satisfies OrchestrationV2RuntimeRequest,
      });
      return { callbackId, accepted: true };
    });
    yield* client.handleUnknownServerRequest((method, params) =>
      Effect.provideService(
        Effect.provideService(onServerRequest(method, params), FileSystem.FileSystem, fileSystem),
        Path.Path,
        path,
      ),
    );

    const ensureThread: ProviderAdapter.ProviderAdapterV2SessionRuntime["ensureThread"] = Effect.fn(
      "VibeAdapterV2.ensureThread",
    )(function* (ensureInput) {
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
        mcpServers: vibeMcpServers(mcpSession),
        cwd: threadCwd,
        headless: true,
        trustWorkspace: options.settings.trustWorkspace,
        agent: agent.agent,
        autoApprove: agent.autoApprove,
      };
      const started = nativeId
        ? yield* Effect.mapError(
            client.sessionResume({ sessionId: nativeId, agentConfig }),
            protocolError,
          )
        : yield* Effect.mapError(
            client.sessionStart({
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
        ownerNodeId: null,
        nativeThreadRef: nativeRef(nativeThreadId),
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
      };
      state.thread = thread;
      yield* emit({
        type: "provider_thread.updated",
        driver: VIBE_PROVIDER,
        providerThread: thread,
      });
      return thread;
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
      state.lastRunOrdinal = turnInput.runOrdinal;
      state.currentRun = {
        runId: turnInput.runId,
        runAttemptId: turnInput.attemptId,
        rootNodeId: turnInput.rootNodeId,
      };
      // A rejected model write must not silently run the turn with the previous model.
      const modelAlias = resolveVibeModelId(turnInput.modelSelection.model);
      yield* client
        .configModelWrite({
          sessionId: nativeSessionId,
          modelAlias,
          reasoningEffort: getModelSelectionStringOptionValue(turnInput.modelSelection, "thinking"),
          sessionOnly: true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: VIBE_PROVIDER,
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                runId: turnInput.runId,
                cause: vibeModelWriteError(modelAlias, cause),
              }),
          ),
        );
      const mcpSession = yield* mcpSessions.read(turnInput.threadId);
      const hasDeviceTools = mcpSession?.capabilities?.has("device") === true;
      const promptText = t3OrchestrationPrompt({
        prompt: turnInput.message.text,
        hasT3Mcp: mcpSession !== undefined,
        hasDeviceTools,
        orchestrationDelivered: state.instructionsDelivered.orchestration,
        deviceInstructionsDelivered: state.instructionsDelivered.device,
      });
      yield* Effect.mapError(
        client.sessionTurnEnqueue({
          sessionId: nativeSessionId,
          entries: [{ role: "user", content: [{ type: "text", text: promptText }] }],
        }),
        protocolError,
      );
      if (mcpSession !== undefined) {
        state.instructionsDelivered = {
          orchestration: true,
          device: state.instructionsDelivered.device || hasDeviceTools,
        };
      }
      yield* updateThread({ status: "active" });
    });

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
      yield* Effect.mapError(
        client.turnSteer({
          sessionId: nativeSessionId,
          expectedTurnId: state.activeTurn.nativeTurnId,
          message: [{ type: "text", text: steerInput.message.text }],
        }),
        protocolError,
      );
    });

    const interruptTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["interruptTurn"] =
      Effect.fn("VibeAdapterV2.interruptTurn")(function* () {
        const nativeSessionId = sessionIdOf();
        if (!nativeSessionId) {
          return yield* new ProviderAdapter.ProviderAdapterSessionStoppedError({
            driver: VIBE_PROVIDER,
          });
        }
        const nativeTurnId = state.activeTurn?.nativeTurnId;
        if (nativeTurnId === undefined) return;
        yield* Effect.mapError(
          client.turnInterrupt({ sessionId: nativeSessionId, expectedTurnId: nativeTurnId }),
          protocolError,
        ).pipe(Effect.ignore);
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
        const callbackId = pending?.callbackId ?? responseInput.requestId;
        const requestKind = pending?.kind ?? "permission";
        // An answer-only response (no decision) on a user_input callback must still deliver the
        // answers; defaulting to cancel here would discard them.
        const decision =
          responseInput.decision ?? (requestKind === "user_input" ? undefined : "cancel");
        // vibe-app-server CallbackOutput contract: approvals and user input have distinct envelopes.
        const output =
          requestKind === "user_input"
            ? {
                type: "user_input" as const,
                result: {
                  answers: Object.entries(responseInput.answers ?? {}).map(
                    ([question, answer]) => ({ question, answer: String(answer) }),
                  ),
                  cancelled: decision === "cancel",
                },
              }
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
          client.callbackResult({
            sessionId: nativeSessionId,
            callbackId,
            result: output,
          }),
          protocolError,
        );
        state.callbackByRequest.delete(responseInput.requestId);
        const resolvedAt = yield* DateTime.now;
        yield* emit({
          type: "runtime_request.updated",
          driver: VIBE_PROVIDER,
          runtimeRequest: {
            id: responseInput.requestId,
            nodeId:
              state.currentRun?.rootNodeId ??
              NodeId.make(`vibe-request-${responseInput.requestId}`),
            providerTurnId: state.activeTurn?.providerTurnId ?? null,
            nativeRequestRef: nativeRef(callbackId),
            kind: requestKind,
            status: "resolved",
            responseCapability: { type: "live", providerSessionId },
            createdAt: resolvedAt,
            resolvedAt,
            decision,
            ...(responseInput.answers ? { answers: responseInput.answers } : {}),
          } satisfies OrchestrationV2RuntimeRequest,
        });
      });

    // Reads every history page (following nextCursor), so long threads are not truncated.
    const readAllHistoryEntries = Effect.fn("VibeAdapterV2.readAllHistoryEntries")(function* (
      nativeSessionId: string,
    ) {
      const entries: Array<Record<string, unknown>> = [];
      let cursor: string | null | undefined = null;
      while (true) {
        const page: {
          readonly items: ReadonlyArray<unknown>;
          readonly nextCursor?: string | null | undefined;
        } = yield* Effect.mapError(
          client.sessionHistoryList({ sessionId: nativeSessionId, limit: 500, cursor }),
          protocolError,
        );
        for (const item of page.items) {
          const entry = asRecord(item);
          if (entry) entries.push(entry);
        }
        cursor = page.nextCursor ?? null;
        if (cursor === null) break;
      }
      return entries;
    });

    const readThreadSnapshot: ProviderAdapter.ProviderAdapterV2SessionRuntime["readThreadSnapshot"] =
      Effect.fn("VibeAdapterV2.readThreadSnapshot")(function* (snapshotInput) {
        const nativeSessionId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
        if (!nativeSessionId) {
          return yield* new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
            driver: VIBE_PROVIDER,
            providerThreadId: snapshotInput.providerThread.id,
          });
        }
        const historyEntries = yield* readAllHistoryEntries(nativeSessionId);
        const turns = yield* Effect.mapError(
          client.sessionTurnsList({ sessionId: nativeSessionId, limit: 500 }),
          protocolError,
        );
        const now = yield* DateTime.now;
        const messages: OrchestrationV2ConversationMessage[] = [];
        for (const entry of historyEntries) {
          const role = str(entry["role"]) === "user" ? "user" : "assistant";
          const text =
            role === "user" ? stripT3PromptInstructions(entryText(entry)) : entryText(entry);
          if (!text) continue;
          const nativeItemId = str(entry["id"]) ?? `entry-${messages.length}`;
          messages.push({
            createdBy: "agent",
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
            createdAt: now,
            updatedAt: now,
          });
        }
        const providerTurns: OrchestrationV2ProviderTurn[] = turns.map((turn, index) => ({
          id: idAllocator.derive.providerTurn({ driver: VIBE_PROVIDER, nativeTurnId: turn.id }),
          providerThreadId: snapshotInput.providerThread.id,
          nodeId: snapshotInput.providerThread.ownerNodeId ?? NodeId.make(`vibe-root-${turn.id}`),
          runAttemptId: null,
          nativeTurnRef: nativeRef(turn.id),
          ordinal: index + 1,
          status: (turn.status === "in_progress"
            ? "running"
            : turn.status) as OrchestrationV2ProviderTurn["status"],
          startedAt: utcFromMillis(turn.startedAt),
          completedAt: utcFromMillis(turn.completedAt),
        }));
        return {
          providerThread: snapshotInput.providerThread,
          providerTurns,
          messages,
          runtimeRequests: [],
        } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
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
        const entryId = historyEntries.find(
          (entry) => str(entry["turnId"]) === targetTurnId && str(entry["role"]) === "user",
        )?.["id"] as string | undefined;
        if (typeof entryId !== "string" || entryId.length === 0) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: VIBE_PROVIDER,
            providerThreadId: rollbackInput.providerThread.id,
            checkpointId: rollbackInput.target.checkpointId,
          });
        }
        yield* Effect.mapError(
          client.request("session/rewind", { sessionId: nativeSessionId, entryId }),
          (cause) =>
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: VIBE_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              checkpointId: rollbackInput.target.checkpointId,
              cause,
            }),
        );
        return yield* readThreadSnapshot({ providerThread: rollbackInput.providerThread });
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
        Stream.fromEffect(Effect.mapError(client.awaitTermination, protocolError)),
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
    getCapabilities: Effect.fn("VibeAdapterV2.getCapabilities")(function* () {
      return VibeProviderCapabilitiesV2;
    }),
    planSelectionTransition: Effect.fn("VibeAdapterV2.planSelectionTransition")(function* () {
      return turnScopedSelectionTransition();
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
