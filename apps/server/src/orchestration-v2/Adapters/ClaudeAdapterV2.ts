import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKAssistantMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, Queue, Random, Schema, Stream } from "effect";

import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import {
  ProviderAdapterEnsureThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";

export const CLAUDE_PROVIDER = "claudeAgent" as const;

export const ClaudeProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
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
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ClaudeAgentSdkQueryOptions {
  readonly model: string;
  readonly tools: NonNullable<ClaudeQueryOptions["tools"]>;
  readonly maxTurns: number;
  readonly permissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
  readonly sessionId: string;
  readonly cwd?: string;
}

export interface ClaudeAgentSdkQueryInput {
  readonly prompt: string;
  readonly options: ClaudeAgentSdkQueryOptions;
}

export class ClaudeAgentSdkQueryRunnerError extends Schema.TaggedErrorClass<ClaudeAgentSdkQueryRunnerError>()(
  "ClaudeAgentSdkQueryRunnerError",
  {
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return "Claude Agent SDK query failed.";
  }
}

export interface ClaudeAgentSdkQueryRunnerShape {
  readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
  readonly run: (
    input: ClaudeAgentSdkQueryInput,
  ) => Stream.Stream<SDKMessage, ClaudeAgentSdkQueryRunnerError>;
  readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerShape
>()("t3/orchestration-v2/ClaudeAgentSdkQueryRunner") {}

export const claudeAgentSdkQueryRunnerLiveLayer: Layer.Layer<ClaudeAgentSdkQueryRunner> =
  Layer.succeed(
    ClaudeAgentSdkQueryRunner,
    ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: Random.nextUUIDv4,
      run: (input) =>
        Stream.unwrap(
          Effect.try({
            try: () => query(input),
            catch: (cause) => new ClaudeAgentSdkQueryRunnerError({ cause }),
          }).pipe(
            Effect.map((messages) =>
              Stream.fromAsyncIterable(
                messages,
                (cause) => new ClaudeAgentSdkQueryRunnerError({ cause }),
              ),
            ),
          ),
        ),
      assertComplete: Effect.void,
    }),
  );

export function makeClaudeQueryOptions(input: {
  readonly modelSelection: ModelSelection;
  readonly sessionId: string;
  readonly cwd: string | null;
}): ClaudeAgentSdkQueryOptions {
  const options: ClaudeAgentSdkQueryOptions = {
    model: input.modelSelection.model,
    tools: [],
    maxTurns: 1,
    permissionMode: "default",
    sessionId: input.sessionId,
  };
  return input.cwd === null ? options : { ...options, cwd: input.cwd };
}

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    provider: CLAUDE_PROVIDER,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: ClaudeProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function textFromClaudeContent(content: SDKAssistantMessage["message"]["content"]): string {
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function assistantTextFromSdkMessage(
  message: SDKMessage,
): { readonly nativeItemId: string; readonly text: string } | null {
  if (message.type !== "assistant") {
    return null;
  }
  return {
    nativeItemId: message.uuid,
    text: textFromClaudeContent(message.message.content),
  };
}

function resultTextFromSdkMessage(
  message: SDKMessage,
): { readonly nativeItemId: string; readonly text: string } | null {
  if (message.type !== "result" || message.subtype !== "success") {
    return null;
  }
  return {
    nativeItemId: message.uuid,
    text: message.result,
  };
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      provider: CLAUDE_PROVIDER,
      nativeThreadId: input.nativeThreadId,
    }),
    provider: CLAUDE_PROVIDER,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: null,
    nativeThreadRef: {
      provider: CLAUDE_PROVIDER,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function buildAssistantArtifacts(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly turnInput: ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeItemId: string;
  readonly text: string;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
}): {
  readonly node: OrchestrationV2ExecutionNode;
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const nodeId = input.idAllocator.derive.nodeFromProviderItem({
    provider: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const messageId = input.idAllocator.derive.messageFromProviderItem({
    provider: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const turnItemId = input.idAllocator.derive.turnItemFromProviderItem({
    provider: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const nativeItemRef = {
    provider: CLAUDE_PROVIDER,
    nativeId: input.nativeItemId,
    strength: "strong" as const,
  };

  return {
    node: {
      id: nodeId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      parentNodeId: input.turnInput.rootNodeId,
      rootNodeId: input.turnInput.rootNodeId,
      kind: "assistant_message",
      status: "completed",
      countsForRun: false,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    },
    message: {
      id: messageId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      role: "assistant",
      text: input.text,
      attachments: [],
      streaming: false,
      createdAt: input.completedAt,
      updatedAt: input.completedAt,
    },
    turnItem: {
      id: turnItemId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal: input.turnInput.runOrdinal * 100 + 1,
      status: "completed",
      title: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
      type: "assistant_message",
      messageId,
      text: input.text,
      streaming: false,
    },
  };
}

function collectAssistantOutput(
  collected: { readonly text: string; readonly nativeItemId: string },
  message: SDKMessage,
): { readonly text: string; readonly nativeItemId: string } {
  const assistantText = assistantTextFromSdkMessage(message);
  if (assistantText !== null && assistantText.text.length > 0) {
    return {
      text: collected.text + assistantText.text,
      nativeItemId: assistantText.nativeItemId,
    };
  }

  const resultText = resultTextFromSdkMessage(message);
  if (collected.text.length === 0 && resultText !== null && resultText.text.length > 0) {
    return {
      text: resultText.text,
      nativeItemId: resultText.nativeItemId,
    };
  }

  return collected;
}

export const layer: Layer.Layer<
  ProviderAdapterV2,
  never,
  ClaudeAgentSdkQueryRunner | IdAllocatorV2
> = Layer.effect(
  ProviderAdapterV2,
  Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const queryRunner = yield* ClaudeAgentSdkQueryRunner;

    return ProviderAdapterV2.of({
      provider: CLAUDE_PROVIDER,
      getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const session = providerSession({
            providerSessionId: input.providerSessionId,
            cwd: input.runtimePolicy.cwd,
            model: input.modelSelection.model,
            now,
          });
          const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
          const nativeThreadId = yield* queryRunner.allocateSessionId;

          const emitProviderEvent = (event: ProviderAdapterV2Event) =>
            Queue.offer(events, event).pipe(Effect.asVoid);

          const startTurn = (turnInput: ProviderAdapterV2TurnInput) =>
            Effect.gen(function* () {
              const startedAt = yield* DateTime.now;
              const nativeTurnId = `turn:${turnInput.runId}`;
              const providerTurnId = idAllocator.derive.providerTurn({
                provider: CLAUDE_PROVIDER,
                nativeTurnId,
              });
              yield* emitProviderEvent({
                type: "provider_turn.updated",
                provider: CLAUDE_PROVIDER,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turnInput.providerThread.id,
                  nodeId: turnInput.rootNodeId,
                  runAttemptId: turnInput.attemptId,
                  nativeTurnRef: {
                    provider: CLAUDE_PROVIDER,
                    nativeId: nativeTurnId,
                    strength: "weak",
                  },
                  ordinal: turnInput.runOrdinal,
                  status: "running",
                  startedAt,
                  completedAt: null,
                },
              });

              const assistant = yield* queryRunner
                .run({
                  prompt: turnInput.message.text,
                  options: makeClaudeQueryOptions({
                    modelSelection: turnInput.modelSelection,
                    sessionId: nativeThreadId,
                    cwd: turnInput.runtimePolicy.cwd,
                  }),
                })
                .pipe(
                  Stream.runFold(
                    () => ({
                      text: "",
                      nativeItemId: `assistant:${turnInput.runId}`,
                    }),
                    collectAssistantOutput,
                  ),
                );
              yield* queryRunner.assertComplete;

              const completedAt = yield* DateTime.now;
              if (assistant.text.length > 0) {
                const artifacts = buildAssistantArtifacts({
                  idAllocator,
                  turnInput,
                  providerTurnId,
                  nativeItemId: assistant.nativeItemId,
                  text: assistant.text,
                  startedAt,
                  completedAt,
                });
                yield* Effect.all(
                  [
                    emitProviderEvent({
                      type: "node.updated",
                      provider: CLAUDE_PROVIDER,
                      node: artifacts.node,
                    }),
                    emitProviderEvent({
                      type: "message.updated",
                      provider: CLAUDE_PROVIDER,
                      message: artifacts.message,
                    }),
                    emitProviderEvent({
                      type: "turn_item.updated",
                      provider: CLAUDE_PROVIDER,
                      turnItem: artifacts.turnItem,
                    }),
                  ],
                  { concurrency: 1 },
                );
              }

              yield* Effect.all(
                [
                  emitProviderEvent({
                    type: "provider_turn.updated",
                    provider: CLAUDE_PROVIDER,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: turnInput.providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        provider: CLAUDE_PROVIDER,
                        nativeId: nativeTurnId,
                        strength: "weak",
                      },
                      ordinal: turnInput.runOrdinal,
                      status: "completed",
                      startedAt,
                      completedAt,
                    },
                  }),
                  emitProviderEvent({
                    type: "turn.terminal",
                    provider: CLAUDE_PROVIDER,
                    providerTurnId,
                    status: "completed",
                  }),
                ],
                { concurrency: 1 },
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    provider: CLAUDE_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            );

          const runtime: ProviderAdapterV2SessionRuntime = {
            provider: CLAUDE_PROVIDER,
            providerSessionId: input.providerSessionId,
            providerSession: session,
            rawEvents: Stream.empty,
            events: Stream.fromQueue(events),
            ensureThread: (threadInput) =>
              Effect.gen(function* () {
                const createdAt = yield* DateTime.now;
                return makeProviderThread({
                  idAllocator,
                  appThreadId: threadInput.threadId,
                  providerSessionId: input.providerSessionId,
                  nativeThreadId,
                  now: createdAt,
                });
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterEnsureThreadError({
                      provider: CLAUDE_PROVIDER,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
            resumeThread: (threadInput) =>
              Effect.gen(function* () {
                const updatedAt = yield* DateTime.now;
                return {
                  ...threadInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  status: "idle" as const,
                  updatedAt,
                };
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterResumeThreadError({
                      provider: CLAUDE_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
            startTurn,
            steerTurn: (turnInput) =>
              Effect.fail(
                new ProviderAdapterSteerRunUnsupportedError({
                  provider: CLAUDE_PROVIDER,
                  providerThreadId: turnInput.providerThread.id,
                }),
              ),
            interruptTurn: (turnInput) =>
              Effect.fail(
                new ProviderAdapterInterruptError({
                  provider: CLAUDE_PROVIDER,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId: turnInput.providerTurnId,
                  cause: "Claude V2 adapter does not implement interrupts.",
                }),
              ),
            respondToRuntimeRequest: (requestInput) =>
              Effect.fail(
                new ProviderAdapterRuntimeRequestResponseError({
                  provider: CLAUDE_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: "Claude V2 adapter does not implement runtime requests.",
                }),
              ),
            readThreadSnapshot: (snapshotInput) =>
              Effect.fail(
                new ProviderAdapterReadThreadSnapshotError({
                  provider: CLAUDE_PROVIDER,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause: "Claude V2 adapter does not implement snapshots.",
                }),
              ),
            rollbackThread: (rollbackInput) =>
              Effect.fail(
                new ProviderAdapterRollbackThreadError({
                  provider: CLAUDE_PROVIDER,
                  providerThreadId: rollbackInput.providerThread.id,
                  cause: "Claude V2 adapter does not implement rollback.",
                }),
              ),
            forkThread: (forkInput) =>
              Effect.fail(
                new ProviderAdapterForkThreadError({
                  provider: CLAUDE_PROVIDER,
                  providerThreadId: forkInput.sourceProviderThread.id,
                  cause: "Claude V2 adapter does not implement forks.",
                }),
              ),
          };

          return runtime;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                provider: CLAUDE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    });
  }),
);
