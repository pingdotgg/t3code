import {
  type ChatAttachment,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ModelSelection,
  PiSettings as PiSettingsSchema,
  type PiSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { splitPiModelSlug } from "../../provider/Layers/PiProvider.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterEventStreamError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2ForkThreadInput,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2ReadThreadSnapshotInput,
  type ProviderAdapterV2RollbackThreadInput,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2RuntimeRequestResponseInput,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  type ProviderAdapterDriver,
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  decodePiEvent,
  projectPiEvent,
  projectPiExtensionUiRequest,
  type PiProjectedEvent,
  type PiRuntimePrompt,
} from "./PiRpcProtocol.ts";
import {
  makePiRpcTransport,
  type PiRpcRecord,
  type PiRpcResponse,
  type PiRpcTransport,
} from "./PiRpcTransport.ts";

export const PI_DRIVER_KIND = ProviderDriverKind.make("pi");
const DEFAULT_PI_SETTINGS = Schema.decodeSync(PiSettingsSchema)({});

export const PiProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
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
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
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
    supportsSubagents: false,
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
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface PiAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly attachmentsDir: string;
  readonly defaultCwd: string;
}

interface ActivePiTurn {
  readonly input: ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  nextItemOrdinal: number;
  readonly itemOrdinals: Map<string, number>;
  readonly content: Map<string, string>;
  readonly toolArgs: Map<string, unknown>;
  readonly startedAt: DateTime.Utc;
  interrupted: boolean;
  pendingTerminal?: Extract<PiProjectedEvent, { readonly type: "run.finished" }>;
}

interface PiThreadState {
  providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: Map<string, OrchestrationV2RuntimeRequest>;
  activeTurn?: ActivePiTurn;
}

interface PendingPiPrompt {
  readonly nativeRequestId: string;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly prompt: PiRuntimePrompt;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

function providerRef(nativeId: string, strength: "strong" | "weak" = "strong") {
  return { driver: PI_DRIVER_KIND, nativeId, strength } satisfies OrchestrationV2ProviderRef;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseData(response: PiRpcResponse | undefined, command: string) {
  if (response === undefined) {
    return Effect.fail(
      new ProviderAdapterProtocolError({ driver: PI_DRIVER_KIND, detail: `${command} timed out` }),
    );
  }
  if (response["success"] !== true) {
    return Effect.fail(
      new ProviderAdapterProtocolError({
        driver: PI_DRIVER_KIND,
        detail: `${command} failed: ${String(response["error"] ?? "unknown error")}`,
        payload: response,
      }),
    );
  }
  return Effect.succeed(recordValue(response["data"]) ?? {});
}

const requestData = (transport: PiRpcTransport, command: PiRpcRecord, timeoutMs = 15_000) =>
  transport
    .request(command, timeoutMs)
    .pipe(
      Effect.flatMap((response) => responseData(response, String(command["type"] ?? "request"))),
    );

function stateNativeId(data: Record<string, unknown>): string | undefined {
  const sessionFile = data["sessionFile"];
  if (typeof sessionFile === "string" && sessionFile.trim().length > 0) return sessionFile;
  const sessionId = data["sessionId"];
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId : undefined;
}

function firstAnswer(answers: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (answers === undefined) return undefined;
  for (const value of Object.values(answers)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

function itemOrdinal(turn: ActivePiTurn, nativeItemId: string): number {
  const existing = turn.itemOrdinals.get(nativeItemId);
  if (existing !== undefined) return existing;
  const ordinal = turn.nextItemOrdinal++;
  turn.itemOrdinals.set(nativeItemId, ordinal);
  return ordinal;
}

const resolvePromptImages = Effect.fnUntraced(function* (
  options: PiAdapterV2Options,
  attachments: ReadonlyArray<ChatAttachment>,
) {
  return yield* Effect.forEach(attachments, (attachment) =>
    Effect.gen(function* () {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: options.attachmentsDir,
        attachment,
      });
      if (attachmentPath === null) {
        return yield* new ProviderAdapterProtocolError({
          driver: PI_DRIVER_KIND,
          detail: `Invalid attachment id '${attachment.id}'`,
        });
      }
      const bytes = yield* options.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProtocolError({
              driver: PI_DRIVER_KIND,
              detail: `Failed to read attachment '${attachment.id}'`,
              payload: cause,
            }),
        ),
      );
      return {
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      };
    }),
  );
});

export function makePiAdapterV2(options: PiAdapterV2Options): ProviderAdapterV2Shape {
  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: PI_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(PiProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("PiAdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const cwd = input.runtimePolicy.cwd ?? options.defaultCwd;
        const launchArgs = tokenizeCliArgs(options.settings.launchArgs);
        const transport = yield* makePiRpcTransport({
          command: options.settings.binaryPath || "pi",
          args: ["--mode", "rpc", ...launchArgs],
          cwd,
          env: options.environment,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, options.spawner));
        const now = yield* DateTime.now;
        let providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver: PI_DRIVER_KIND,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd,
          model: input.modelSelection.model,
          capabilities: PiProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<
          ProviderAdapterV2Event,
          ProviderAdapterV2Error | Cause.Done<void>
        >();
        let threadState: PiThreadState | undefined;
        const pendingPrompts = new Map<string, PendingPiPrompt>();

        const emit = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        const updateSession = (
          status: OrchestrationV2ProviderSession["status"],
          error: string | null = null,
          model: OrchestrationV2ProviderSession["model"] = providerSession.model,
        ) =>
          Effect.gen(function* () {
            providerSession = {
              ...providerSession,
              status,
              model,
              lastError: error,
              updatedAt: yield* DateTime.now,
            };
            yield* emit({
              type: "provider_session.updated",
              driver: PI_DRIVER_KIND,
              providerSession,
            });
          });
        const updateThread = (
          state: PiThreadState,
          patch: Partial<OrchestrationV2ProviderThread>,
        ) =>
          Effect.gen(function* () {
            state.providerThread = {
              ...state.providerThread,
              ...patch,
              updatedAt: yield* DateTime.now,
            };
            yield* emit({
              type: "provider_thread.updated",
              driver: PI_DRIVER_KIND,
              providerThread: state.providerThread,
            });
          });

        const emitContent = Effect.fnUntraced(function* (
          state: PiThreadState,
          turn: ActivePiTurn,
          projected: Extract<PiProjectedEvent, { type: "assistant.delta" | "reasoning.delta" }>,
        ) {
          const kind = projected.type === "assistant.delta" ? "assistant" : "reasoning";
          const nativeItemId = `${turn.providerTurn.id}:${kind}:${projected.contentIndex}`;
          const text = `${turn.content.get(nativeItemId) ?? ""}${projected.delta}`;
          turn.content.set(nativeItemId, text);
          const updatedAt = yield* DateTime.now;
          const nodeId = options.idAllocator.derive.nodeFromProviderItem({
            driver: PI_DRIVER_KIND,
            nativeItemId,
          });
          const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
            driver: PI_DRIVER_KIND,
            nativeItemId,
          });
          yield* emit({
            type: "node.updated",
            driver: PI_DRIVER_KIND,
            node: {
              id: nodeId,
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              parentNodeId: turn.input.rootNodeId,
              rootNodeId: turn.input.rootNodeId,
              kind: projected.type === "assistant.delta" ? "assistant_message" : "reasoning",
              status: "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              nativeItemRef: providerRef(nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.startedAt,
              completedAt: null,
            },
          });
          const base = {
            id: turnItemId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            parentItemId: null,
            ordinal: itemOrdinal(turn, nativeItemId),
            status: "running" as const,
            title: null,
            startedAt: turn.startedAt,
            completedAt: null,
            updatedAt,
          };
          if (projected.type === "assistant.delta") {
            const messageId = options.idAllocator.derive.messageFromProviderItem({
              driver: PI_DRIVER_KIND,
              nativeItemId,
            });
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              nodeId,
              role: "assistant",
              text,
              attachments: [],
              streaming: true,
              createdAt: turn.startedAt,
              updatedAt,
            };
            state.messages.set(String(messageId), message);
            yield* emit({ type: "message.updated", driver: PI_DRIVER_KIND, message });
            yield* emit({
              type: "turn_item.updated",
              driver: PI_DRIVER_KIND,
              turnItem: { ...base, type: "assistant_message", messageId, text, streaming: true },
            });
          } else {
            yield* emit({
              type: "turn_item.updated",
              driver: PI_DRIVER_KIND,
              turnItem: { ...base, type: "reasoning", text, streaming: true },
            });
          }
        });

        const finalizeContent = Effect.fnUntraced(function* (
          state: PiThreadState,
          turn: ActivePiTurn,
          completedAt: DateTime.Utc,
          terminalStatus: "completed" | "interrupted" | "failed",
        ) {
          for (const [nativeItemId, text] of turn.content) {
            const assistant = nativeItemId.includes(":assistant:");
            const nodeId = options.idAllocator.derive.nodeFromProviderItem({
              driver: PI_DRIVER_KIND,
              nativeItemId,
            });
            const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
              driver: PI_DRIVER_KIND,
              nativeItemId,
            });
            const status: OrchestrationV2TurnItem["status"] =
              terminalStatus === "failed" ? "failed" : terminalStatus;
            yield* emit({
              type: "node.updated",
              driver: PI_DRIVER_KIND,
              node: {
                id: nodeId,
                threadId: turn.input.threadId,
                runId: turn.input.runId,
                parentNodeId: turn.input.rootNodeId,
                rootNodeId: turn.input.rootNodeId,
                kind: assistant ? "assistant_message" : "reasoning",
                status,
                countsForRun: false,
                providerThreadId: state.providerThread.id,
                providerTurnId: turn.providerTurn.id,
                nativeItemRef: providerRef(nativeItemId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: turn.startedAt,
                completedAt,
              },
            });
            const base = {
              id: turnItemId,
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              nodeId,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              nativeItemRef: providerRef(nativeItemId),
              parentItemId: null,
              ordinal: itemOrdinal(turn, nativeItemId),
              status,
              title: null,
              startedAt: turn.startedAt,
              completedAt,
              updatedAt: completedAt,
            };
            if (assistant) {
              const messageId = options.idAllocator.derive.messageFromProviderItem({
                driver: PI_DRIVER_KIND,
                nativeItemId,
              });
              const message: OrchestrationV2ConversationMessage = {
                createdBy: "agent",
                creationSource: "provider",
                id: messageId,
                threadId: turn.input.threadId,
                runId: turn.input.runId,
                nodeId,
                role: "assistant",
                text,
                attachments: [],
                streaming: false,
                createdAt: turn.startedAt,
                updatedAt: completedAt,
              };
              state.messages.set(String(messageId), message);
              yield* emit({ type: "message.updated", driver: PI_DRIVER_KIND, message });
              yield* emit({
                type: "turn_item.updated",
                driver: PI_DRIVER_KIND,
                turnItem: {
                  ...base,
                  type: "assistant_message",
                  messageId,
                  text,
                  streaming: false,
                },
              });
            } else {
              yield* emit({
                type: "turn_item.updated",
                driver: PI_DRIVER_KIND,
                turnItem: { ...base, type: "reasoning", text, streaming: false },
              });
            }
          }
        });

        const emitTool = Effect.fnUntraced(function* (
          state: PiThreadState,
          turn: ActivePiTurn,
          projected: Extract<
            PiProjectedEvent,
            { type: "tool.started" | "tool.updated" | "tool.completed" }
          >,
        ) {
          const now = yield* DateTime.now;
          const nativeItemId = projected.toolCallId;
          const nodeId = options.idAllocator.derive.nodeFromProviderItem({
            driver: PI_DRIVER_KIND,
            nativeItemId,
          });
          const turnItemId = options.idAllocator.derive.turnItemFromProviderItem({
            driver: PI_DRIVER_KIND,
            nativeItemId,
          });
          const completed = projected.type === "tool.completed";
          const args =
            projected.type === "tool.completed"
              ? (turn.toolArgs.get(nativeItemId) ?? {})
              : projected.args;
          if (completed) turn.toolArgs.delete(nativeItemId);
          else turn.toolArgs.set(nativeItemId, args);
          yield* emit({
            type: "node.updated",
            driver: PI_DRIVER_KIND,
            node: {
              id: nodeId,
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              parentNodeId: turn.input.rootNodeId,
              rootNodeId: turn.input.rootNodeId,
              kind: "tool_call",
              status: completed ? (projected.isError ? "failed" : "completed") : "running",
              countsForRun: false,
              providerThreadId: state.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              nativeItemRef: providerRef(nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: turn.startedAt,
              completedAt: completed ? now : null,
            },
          });
          const turnItem: OrchestrationV2TurnItem = {
            id: turnItemId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            parentItemId: null,
            ordinal: itemOrdinal(turn, nativeItemId),
            status: completed ? (projected.isError ? "failed" : "completed") : "running",
            title: projected.toolName,
            startedAt: turn.startedAt,
            completedAt: completed ? now : null,
            updatedAt: now,
            type: "dynamic_tool",
            toolName: projected.toolName,
            input: args,
            ...(projected.type === "tool.updated"
              ? { output: projected.partialResult }
              : projected.type === "tool.completed"
                ? { output: projected.result }
                : {}),
          };
          yield* emit({ type: "turn_item.updated", driver: PI_DRIVER_KIND, turnItem });
        });

        const emitPrompt = Effect.fnUntraced(function* (
          state: PiThreadState,
          prompt: PiRuntimePrompt,
        ) {
          const turn = state.activeTurn;
          if (turn === undefined) {
            yield* transport.send({
              type: "extension_ui_response",
              id: prompt.requestId,
              cancelled: true,
            });
            return;
          }
          const requestId = yield* options.idAllocator.allocate.runtimeRequest({
            driver: PI_DRIVER_KIND,
            providerTurnId: turn.providerTurn.id,
            nativeRequestId: prompt.requestId,
          });
          const createdAt = yield* DateTime.now;
          const nodeId = options.idAllocator.derive.approvalNode({ requestId });
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: turn.providerTurn.id,
            nativeRequestRef: providerRef(prompt.requestId),
            kind: prompt.type === "approval" ? "command" : "user_input",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt,
            resolvedAt: null,
          };
          state.runtimeRequests.set(String(requestId), runtimeRequest);
          yield* emit({
            type: "runtime_request.updated",
            driver: PI_DRIVER_KIND,
            threadId: state.providerThread.appThreadId ?? undefined,
            runtimeRequest,
          });
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind: prompt.type === "approval" ? "approval_request" : "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(prompt.requestId),
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: createdAt,
            completedAt: null,
          };
          yield* emit({
            type: "node.updated",
            driver: PI_DRIVER_KIND,
            node,
          });
          const itemBase = {
            id: options.idAllocator.derive.approvalTurnItem({ requestId }),
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId,
            providerThreadId: state.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(prompt.requestId),
            parentItemId: null,
            ordinal: itemOrdinal(turn, prompt.requestId),
            status: "waiting" as const,
            title: prompt.title,
            startedAt: createdAt,
            completedAt: null,
            updatedAt: createdAt,
          };
          const turnItem: OrchestrationV2TurnItem =
            prompt.type === "approval"
              ? {
                  ...itemBase,
                  type: "approval_request",
                  requestId,
                  requestKind: "command",
                  prompt: prompt.message,
                }
              : {
                  ...itemBase,
                  type: "user_input_request",
                  requestId,
                  questions: [
                    {
                      id: prompt.requestId,
                      header: prompt.title,
                      question: prompt.title,
                      options: (prompt.options ?? []).map((option) => ({
                        label: option,
                        description: option,
                      })),
                    },
                  ],
                };
          pendingPrompts.set(String(requestId), {
            nativeRequestId: prompt.requestId,
            runtimeRequest,
            prompt,
            node,
            turnItem,
          });
          yield* emit({ type: "turn_item.updated", driver: PI_DRIVER_KIND, turnItem });
        });

        const cancelPendingPrompts = Effect.fnUntraced(function* (
          state: PiThreadState,
          turn: ActivePiTurn,
          cancelledAt: DateTime.Utc,
        ) {
          const pending = Array.from(pendingPrompts.entries()).filter(
            ([, prompt]) => prompt.runtimeRequest.providerTurnId === turn.providerTurn.id,
          );
          yield* Effect.forEach(
            pending,
            ([requestId, prompt]) =>
              Effect.gen(function* () {
                pendingPrompts.delete(requestId);
                yield* transport
                  .send({
                    type: "extension_ui_response",
                    id: prompt.nativeRequestId,
                    cancelled: true,
                  })
                  .pipe(Effect.ignore);
                const runtimeRequest: OrchestrationV2RuntimeRequest = {
                  ...prompt.runtimeRequest,
                  status: "cancelled",
                  resolvedAt: cancelledAt,
                };
                state.runtimeRequests.set(requestId, runtimeRequest);
                yield* emit({
                  type: "runtime_request.updated",
                  driver: PI_DRIVER_KIND,
                  threadId: turn.input.threadId,
                  runtimeRequest,
                });
                yield* emit({
                  type: "node.updated",
                  driver: PI_DRIVER_KIND,
                  node: { ...prompt.node, status: "cancelled", completedAt: cancelledAt },
                });
                yield* emit({
                  type: "turn_item.updated",
                  driver: PI_DRIVER_KIND,
                  turnItem: {
                    ...prompt.turnItem,
                    status: "cancelled",
                    completedAt: cancelledAt,
                    updatedAt: cancelledAt,
                  },
                });
              }),
            { concurrency: 1, discard: true },
          );
        });

        const finalizeTurn = Effect.fnUntraced(function* (
          state: PiThreadState,
          turn: ActivePiTurn,
          projected: Extract<PiProjectedEvent, { readonly type: "run.finished" }>,
        ) {
          const completedAt = yield* DateTime.now;
          const status = turn.interrupted
            ? "interrupted"
            : projected.status === "failed"
              ? "failed"
              : projected.status === "interrupted"
                ? "interrupted"
                : "completed";
          yield* cancelPendingPrompts(state, turn, completedAt);
          yield* finalizeContent(state, turn, completedAt, status);
          turn.providerTurn = { ...turn.providerTurn, status, completedAt };
          state.providerTurns.set(String(turn.providerTurn.id), turn.providerTurn);
          yield* emit({
            type: "provider_turn.updated",
            driver: PI_DRIVER_KIND,
            threadId: turn.input.threadId,
            providerTurn: turn.providerTurn,
          });
          yield* emit(
            status === "failed"
              ? {
                  type: "turn.terminal",
                  driver: PI_DRIVER_KIND,
                  providerThreadId: state.providerThread.id,
                  providerTurnId: turn.providerTurn.id,
                  runOrdinal: turn.input.runOrdinal,
                  failureItemOrdinal: turn.nextItemOrdinal,
                  status,
                  failure: {
                    class: "provider_error",
                    message: projected.errorMessage ?? "Pi run failed.",
                    code: null,
                    retryable: null,
                  },
                  threadDisposition: "reusable",
                }
              : {
                  type: "turn.terminal",
                  driver: PI_DRIVER_KIND,
                  providerThreadId: state.providerThread.id,
                  providerTurnId: turn.providerTurn.id,
                  runOrdinal: turn.input.runOrdinal,
                  status,
                  failure: null,
                  threadDisposition: "reusable",
                },
          );
          delete state.activeTurn;
          yield* updateThread(state, { status: "idle", lastRunOrdinal: turn.input.runOrdinal });
          yield* updateSession("ready");
        });

        const handleProjected = Effect.fnUntraced(function* (
          state: PiThreadState,
          projected: PiProjectedEvent,
        ) {
          const turn = state.activeTurn;
          if (
            turn !== undefined &&
            (projected.type === "assistant.delta" || projected.type === "reasoning.delta")
          ) {
            return yield* emitContent(state, turn, projected);
          }
          if (
            turn !== undefined &&
            (projected.type === "tool.started" ||
              projected.type === "tool.updated" ||
              projected.type === "tool.completed")
          ) {
            return yield* emitTool(state, turn, projected);
          }
          if (turn !== undefined && projected.type === "run.retrying") {
            return yield* updateSession("running");
          }
          if (turn !== undefined && projected.type === "run.finished") {
            turn.pendingTerminal = projected;
            return;
          }
          if (turn !== undefined && projected.type === "run.settled") {
            return yield* finalizeTurn(
              state,
              turn,
              turn.pendingTerminal ?? { type: "run.finished", status: "completed" },
            );
          }
        });

        yield* Stream.fromQueue(transport.messages).pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              const state = threadState;
              if (message._tag === "event") {
                const decoded = yield* decodePiEvent(message.event);
                if (decoded._tag === "known" && state !== undefined) {
                  for (const projected of projectPiEvent(decoded.event)) {
                    yield* handleProjected(state, projected);
                  }
                }
              } else if (message._tag === "extension-ui" && state !== undefined) {
                const prompt = projectPiExtensionUiRequest(message.request);
                if (prompt !== undefined) yield* emitPrompt(state, prompt);
              }
            }),
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterEventStreamError({
                driver: PI_DRIVER_KIND,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.catch((error) => Queue.fail(events, error)),
          Effect.forkScoped,
        );

        const ensureThread = (ensureInput: ProviderAdapterV2EnsureThreadInput) =>
          Effect.gen(function* () {
            if (ensureInput.existingProviderThread?.nativeThreadRef?.nativeId) {
              yield* requestData(transport, {
                type: "switch_session",
                sessionPath: ensureInput.existingProviderThread.nativeThreadRef.nativeId,
              });
            }
            const data = yield* requestData(transport, { type: "get_state" });
            const nativeId = stateNativeId(data);
            if (nativeId === undefined) {
              return yield* new ProviderAdapterProtocolError({
                driver: PI_DRIVER_KIND,
                detail: "get_state returned neither sessionFile nor sessionId",
                payload: data,
              });
            }
            const createdAt = yield* DateTime.now;
            const providerThread: OrchestrationV2ProviderThread =
              ensureInput.existingProviderThread === undefined
                ? {
                    id: options.idAllocator.derive.providerThread({
                      driver: PI_DRIVER_KIND,
                      nativeThreadId: nativeId,
                    }),
                    driver: PI_DRIVER_KIND,
                    providerInstanceId: options.instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: ensureInput.threadId,
                    ownerNodeId: null,
                    nativeThreadRef: providerRef(nativeId),
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    pendingBackgroundTasks: [],
                    createdAt,
                    updatedAt: createdAt,
                  }
                : {
                    ...ensureInput.existingProviderThread,
                    providerSessionId: input.providerSessionId,
                    appThreadId: ensureInput.threadId,
                    nativeThreadRef: providerRef(nativeId),
                    status: "idle",
                    updatedAt: createdAt,
                  };
            threadState = {
              providerThread,
              providerTurns: new Map(),
              messages: new Map(),
              runtimeRequests: new Map(),
            };
            yield* emit({
              type: "provider_thread.updated",
              driver: PI_DRIVER_KIND,
              providerThread,
            });
            return providerThread;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterEnsureThreadError({
                  driver: PI_DRIVER_KIND,
                  threadId: ensureInput.threadId,
                  cause,
                }),
            ),
          );

        return {
          instanceId: options.instanceId,
          driver: PI_DRIVER_KIND,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread,
          resumeThread: (resumeInput: {
            readonly providerThread: OrchestrationV2ProviderThread;
            readonly threadId?: ThreadId;
            readonly modelSelection?: ModelSelection;
            readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
          }) =>
            ensureThread({
              threadId: resumeInput.threadId ?? resumeInput.providerThread.appThreadId!,
              modelSelection: resumeInput.modelSelection ?? input.modelSelection,
              runtimePolicy: resumeInput.runtimePolicy ?? input.runtimePolicy,
              existingProviderThread: resumeInput.providerThread,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterResumeThreadError({
                    driver: PI_DRIVER_KIND,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: resumeInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          startTurn: (turnInput: ProviderAdapterV2TurnInput) =>
            Effect.gen(function* () {
              const state = threadState;
              if (state === undefined || state.providerThread.id !== turnInput.providerThread.id) {
                return yield* new ProviderAdapterProtocolError({
                  driver: PI_DRIVER_KIND,
                  detail: "startTurn targeted a Pi thread that is not loaded",
                });
              }
              const model = splitPiModelSlug(turnInput.modelSelection.model);
              if (model === undefined) {
                return yield* new ProviderAdapterProtocolError({
                  driver: PI_DRIVER_KIND,
                  detail: `invalid Pi model slug ${turnInput.modelSelection.model}`,
                });
              }
              const images = yield* resolvePromptImages(options, turnInput.message.attachments);
              if (turnInput.message.text.length === 0 && images.length === 0) {
                return yield* new ProviderAdapterProtocolError({
                  driver: PI_DRIVER_KIND,
                  detail: "Pi turns require non-empty text or at least one attachment",
                });
              }
              yield* requestData(transport, {
                type: "set_model",
                provider: model.provider,
                modelId: model.id,
              });
              const thinking =
                getModelSelectionStringOptionValue(turnInput.modelSelection, "thinking") ??
                turnInput.runtimePolicy.reasoningEffort;
              if (
                thinking === "off" ||
                thinking === "minimal" ||
                thinking === "low" ||
                thinking === "medium" ||
                thinking === "high" ||
                thinking === "xhigh" ||
                thinking === "max"
              ) {
                yield* requestData(transport, { type: "set_thinking_level", level: thinking });
              }
              const startedAt = yield* DateTime.now;
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: options.idAllocator.derive.providerTurn({
                  driver: PI_DRIVER_KIND,
                  nativeTurnId: `${state.providerThread.nativeThreadRef?.nativeId ?? state.providerThread.id}:${turnInput.runOrdinal}:${turnInput.attemptId}`,
                }),
                providerThreadId: state.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: null,
                ordinal: turnInput.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              };
              state.providerTurns.set(String(providerTurn.id), providerTurn);
              state.activeTurn = {
                input: turnInput,
                providerTurn,
                nextItemOrdinal: 0,
                itemOrdinals: new Map(),
                content: new Map(),
                toolArgs: new Map(),
                startedAt,
                interrupted: false,
              };
              yield* updateThread(state, {
                status: "active",
                firstRunOrdinal: state.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
              });
              yield* updateSession("running", null, turnInput.modelSelection.model);
              yield* emit({
                type: "provider_turn.updated",
                driver: PI_DRIVER_KIND,
                threadId: turnInput.threadId,
                providerTurn,
              });
              yield* requestData(transport, {
                type: "prompt",
                message: turnInput.message.text,
                ...(images.length > 0 ? { images } : {}),
              }).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    const completedAt = yield* DateTime.now;
                    const failedProviderTurn: OrchestrationV2ProviderTurn = {
                      ...providerTurn,
                      status: "failed",
                      completedAt,
                    };
                    delete state.activeTurn;
                    state.providerTurns.set(String(providerTurn.id), failedProviderTurn);
                    yield* emit({
                      type: "provider_turn.updated",
                      driver: PI_DRIVER_KIND,
                      threadId: turnInput.threadId,
                      providerTurn: failedProviderTurn,
                    });
                    yield* updateThread(state, { status: "idle" });
                    yield* updateSession("ready");
                    return yield* cause;
                  }),
                ),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: PI_DRIVER_KIND,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
          steerTurn: (steerInput: ProviderAdapterV2SteerInput) =>
            resolvePromptImages(options, steerInput.message.attachments).pipe(
              Effect.flatMap((images) =>
                requestData(transport, {
                  type: "steer",
                  message: steerInput.message.text,
                  ...(images.length > 0 ? { images } : {}),
                }),
              ),
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterSteerRunError({
                    driver: PI_DRIVER_KIND,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          interruptTurn: (interruptInput: ProviderAdapterV2InterruptInput) =>
            requestData(transport, { type: "abort" }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (threadState?.activeTurn !== undefined)
                    threadState.activeTurn.interrupted = true;
                }),
              ),
              Effect.asVoid,
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver: PI_DRIVER_KIND,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (responseInput: ProviderAdapterV2RuntimeRequestResponseInput) =>
            Effect.gen(function* () {
              const pending = pendingPrompts.get(String(responseInput.requestId));
              if (pending === undefined) {
                return yield* new ProviderAdapterProtocolError({
                  driver: PI_DRIVER_KIND,
                  detail: `runtime request ${responseInput.requestId} is not live`,
                });
              }
              const response: PiRpcRecord =
                pending.prompt.type === "approval"
                  ? {
                      type: "extension_ui_response",
                      id: pending.nativeRequestId,
                      confirmed:
                        responseInput.decision === "accept" ||
                        responseInput.decision === "acceptForSession",
                    }
                  : (() => {
                      const answer = firstAnswer(responseInput.answers);
                      return answer === undefined
                        ? {
                            type: "extension_ui_response",
                            id: pending.nativeRequestId,
                            cancelled: true,
                          }
                        : {
                            type: "extension_ui_response",
                            id: pending.nativeRequestId,
                            value: answer,
                          };
                    })();
              yield* transport.send(response);
              pendingPrompts.delete(String(responseInput.requestId));
              const resolvedAt = yield* DateTime.now;
              const resolved = {
                ...pending.runtimeRequest,
                status: "resolved" as const,
                resolvedAt,
              };
              threadState?.runtimeRequests.set(String(responseInput.requestId), resolved);
              yield* emit({
                type: "runtime_request.updated",
                driver: PI_DRIVER_KIND,
                threadId: threadState?.providerThread.appThreadId ?? undefined,
                runtimeRequest: resolved,
              });
              yield* emit({
                type: "node.updated",
                driver: PI_DRIVER_KIND,
                node: { ...pending.node, status: "completed", completedAt: resolvedAt },
              });
              yield* emit({
                type: "turn_item.updated",
                driver: PI_DRIVER_KIND,
                turnItem: {
                  ...pending.turnItem,
                  status: "completed",
                  completedAt: resolvedAt,
                  updatedAt: resolvedAt,
                },
              });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRuntimeRequestResponseError({
                    driver: PI_DRIVER_KIND,
                    requestId: responseInput.requestId,
                    cause,
                  }),
              ),
            ),
          readThreadSnapshot: (snapshotInput: ProviderAdapterV2ReadThreadSnapshotInput) =>
            Effect.gen(function* () {
              const state = threadState;
              if (state?.providerThread.id !== snapshotInput.providerThread.id) {
                return yield* new ProviderAdapterProtocolError({
                  driver: PI_DRIVER_KIND,
                  detail: "requested Pi thread is not loaded",
                });
              }
              return {
                providerThread: state.providerThread,
                providerTurns: Array.from(state.providerTurns.values()),
                messages: Array.from(state.messages.values()),
                runtimeRequests: Array.from(state.runtimeRequests.values()),
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterReadThreadSnapshotError({
                    driver: PI_DRIVER_KIND,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          rollbackThread: (rollbackInput: ProviderAdapterV2RollbackThreadInput) =>
            Effect.fail(
              new ProviderAdapterRollbackThreadError({
                driver: PI_DRIVER_KIND,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause:
                  "Pi conversation rollback is not enabled until session entry ids are projected.",
              }),
            ),
          forkThread: (forkInput: ProviderAdapterV2ForkThreadInput) =>
            Effect.fail(
              new ProviderAdapterForkThreadError({
                driver: PI_DRIVER_KIND,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause: "Pi conversation fork is not enabled until session entry ids are projected.",
              }),
            ),
        };
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: PI_DRIVER_KIND,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}

export type PiAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | ServerConfig;

export const PiAdapterV2Driver: ProviderAdapterDriver<PiSettings, PiAdapterV2DriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  configSchema: PiSettingsSchema,
  defaultConfig: (): PiSettings => DEFAULT_PI_SETTINGS,
  create: Effect.fn("PiAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PiSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      return makePiAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        idAllocator,
        spawner,
        fileSystem,
        attachmentsDir: serverConfig.attachmentsDir,
        defaultCwd: serverConfig.cwd,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PI_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Pi v2 adapter.",
              cause,
            }),
        ),
      ),
  ),
};
