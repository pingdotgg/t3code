import {
  NodeId,
  ProviderInstanceId,
  ProviderTurnId,
  type OrchestrationV2ConversationMessage,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as VibeAppServer from "@t3tools/vibe-app-server/client";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  MISTRAL_VIBE_RATE_LIMITED,
  VIBE_PROVIDER,
  buildVibeSpawnInput,
  resolveVibeModelId,
  vibeAgentForRuntimeMode,
  vibeWorktreeInputForCwd,
} from "./appServerSupport.ts";

const VibeProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
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
  const message = str(error?.["message"]) ?? str(turn.stopReason) ?? "Mistral Vibe turn failed.";
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
}

export const makeVibeAdapterV2 = Effect.fn("makeVibeAdapterV2")(function* (
  options: VibeAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const random = yield* SecureRandom.SecureRandom;

  const protocolError = (cause: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: VIBE_PROVIDER,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const openSessionInner = Effect.fn("VibeAdapterV2.openSession")(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
    const spawn = buildVibeSpawnInput(options.settings, cwd, options.environment);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawn.command, [...spawn.args], {
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
          clientTools: ["filesystem/read", "filesystem/write", "terminal"],
        },
      }),
      protocolError,
    );
    yield* Effect.mapError(client.initialized(), protocolError);

    const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      Effect.asVoid(PubSub.publish(events, event));

    const now = yield* DateTime.now;
    const providerSessionId = idAllocator.derive.providerSession({
      providerInstanceId: options.instanceId,
    });
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
          const ordinal = (state.turnOrdinals.get(nativeTurnId) ?? state.turnOrdinals.size) + 1;
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
            nodeId: state.thread.ownerNodeId ?? NodeId.make(`vibe-root-${nativeTurnId}`),
            runAttemptId: null,
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
          const terminalStatus =
            status === "failed" || status === "cancelled"
              ? "failed"
              : status === "interrupted"
                ? "interrupted"
                : "completed";
          yield* emit({
            type: "provider_turn.updated",
            driver: VIBE_PROVIDER,
            providerTurn: {
              id: providerTurnId,
              providerThreadId: state.thread.id,
              nodeId: state.thread.ownerNodeId ?? NodeId.make(`vibe-root-${nativeTurnId}`),
              runAttemptId: null,
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
              status: terminalStatus === "failed" ? "cancelled" : terminalStatus,
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
        if (method === "history/entryAdded" || method === "history/entryUpdated") {
          const entry = asRecord(record["entry"]);
          if (!entry || !state.thread) return;
          const role = str(entry["role"]);
          const text = entryText(entry);
          if (!text) return;
          const nativeItemId = str(entry["id"]) ?? `${method}:${yield* random.uuidV4()}`;
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
            createdBy: role === "user" ? "user" : "agent",
            creationSource: "provider",
            id: messageId,
            threadId: input.threadId,
            runId: null,
            nodeId: null,
            role: role === "user" ? "user" : "assistant",
            text,
            attachments: [],
            streaming: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          const item = {
            id: turnItemId,
            threadId: input.threadId,
            runId: null,
            nodeId: null,
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
            type: role === "user" ? ("user_message" as const) : ("assistant_message" as const),
            messageId,
            text,
            textOmitted: true as const,
            ...(role === "user"
              ? { inputIntent: "turn_start" as const, attachments: [] as const }
              : { streaming: false as const }),
          };
          yield* emit({ type: "message.updated", driver: VIBE_PROVIDER, message });
          yield* emit({
            type: "turn_item.updated",
            driver: VIBE_PROVIDER,
            turnItem: item as OrchestrationV2TurnItem,
          });
          return;
        }
      }),
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
      const agentConfig = {
        cwd: threadCwd,
        headless: true,
        trustWorkspace: options.settings.trustWorkspace,
        worktree: vibeWorktreeInputForCwd(threadCwd),
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
      yield* Effect.mapError(
        client.configModelWrite({
          sessionId: nativeSessionId,
          modelAlias: resolveVibeModelId(turnInput.modelSelection.model),
          sessionOnly: true,
        }),
        protocolError,
      ).pipe(Effect.ignore);
      yield* Effect.mapError(
        client.sessionTurnEnqueue({
          sessionId: nativeSessionId,
          entries: [{ role: "user", content: [{ type: "text", text: turnInput.message.text }] }],
        }),
        protocolError,
      );
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
        const decision = responseInput.decision ?? "cancel";
        const result =
          decision === "cancel"
            ? { outcome: "cancelled" as const }
            : decision === "decline"
              ? { outcome: "denied" as const }
              : {
                  outcome: "approved" as const,
                  ...(responseInput.answers ? { answers: responseInput.answers } : {}),
                };
        yield* Effect.mapError(
          client.callbackResult({
            sessionId: nativeSessionId,
            callbackId: responseInput.requestId,
            result,
          }),
          protocolError,
        );
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
        const history = yield* Effect.mapError(
          client.sessionHistoryList({ sessionId: nativeSessionId, limit: 500 }),
          protocolError,
        );
        const turns = yield* Effect.mapError(
          client.sessionTurnsList({ sessionId: nativeSessionId, limit: 200 }),
          protocolError,
        );
        const now = yield* DateTime.now;
        const messages: OrchestrationV2ConversationMessage[] = [];
        for (const item of history.items) {
          const entry = asRecord(item);
          const text = entryText(entry);
          if (!entry || !text) continue;
          const role = str(entry["role"]) === "user" ? "user" : "assistant";
          const nativeItemId = str(entry["id"]) ?? `entry-${messages.length}`;
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
        if (rollbackInput.target.type === "provider_turn") {
          const entryId = rollbackInput.target.providerTurn.nativeTurnRef?.nativeId;
          if (entryId) {
            yield* Effect.mapError(
              client.request("session/rewind", { sessionId: nativeSessionId, entryId }),
              protocolError,
            ).pipe(Effect.ignore);
          }
        }
        return yield* readThreadSnapshot({ providerThread: rollbackInput.providerThread });
      });

    const forkThread: ProviderAdapter.ProviderAdapterV2SessionRuntime["forkThread"] = Effect.fn(
      "VibeAdapterV2.forkThread",
    )(function* (forkInput) {
      const sourceId = forkInput.sourceProviderThread.nativeThreadRef?.nativeId;
      if (!sourceId) {
        return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
          driver: VIBE_PROVIDER,
          providerThreadId: forkInput.sourceProviderThread.id,
        });
      }
      const forked = yield* Effect.mapError(
        client.request("session/fork", {
          sourceSessionId: sourceId,
          ...(forkInput.providerTurnId !== undefined
            ? { afterTurnId: forkInput.providerTurnId }
            : {}),
        }),
        protocolError,
      );
      const nativeThreadId = str(
        asRecord(asRecord(asRecord(forked)?.["state"])?.["session"])?.["id"],
      );
      if (!nativeThreadId) {
        return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
          driver: VIBE_PROVIDER,
          providerThreadId: forkInput.sourceProviderThread.id,
        });
      }
      const createdAt = yield* DateTime.now;
      return {
        id: idAllocator.derive.providerThread({
          driver: VIBE_PROVIDER,
          providerInstanceId: options.instanceId,
          nativeThreadId,
        }),
        driver: VIBE_PROVIDER,
        providerInstanceId: options.instanceId,
        providerSessionId,
        appThreadId: forkInput.targetThreadId,
        ownerNodeId: forkInput.ownerNodeId ?? null,
        nativeThreadRef: nativeRef(nativeThreadId),
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: { providerThreadId: forkInput.sourceProviderThread.id },
        createdAt,
        updatedAt: createdAt,
      } satisfies OrchestrationV2ProviderThread;
    });

    return {
      instanceId: options.instanceId,
      driver: VIBE_PROVIDER,
      providerSessionId,
      providerSession: state.session,
      events: Stream.fromPubSub(events),
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
        openSessionInner(input),
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      );
    }),
  });
});

export type VibeAdapterV2Env =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost;
