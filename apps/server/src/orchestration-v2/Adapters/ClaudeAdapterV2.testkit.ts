import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKAssistantMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderReplayEntry,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import { DateTime, Effect, Layer, Queue, Random, Schema, Stream } from "effect";

import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
  type IdAllocatorV2Shape,
} from "../IdAllocator.ts";
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
import { layerFromProviderAdapter } from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";

const CLAUDE_PROVIDER = "claudeAgent" as const;
export const CLAUDE_AGENT_SDK_REPLAY_PROTOCOL = "claude-agent-sdk.query" as const;

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

const ClaudeAgentSdkReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CLAUDE_PROVIDER),
  protocol: Schema.Literal(CLAUDE_AGENT_SDK_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  entries: Schema.Array(ProviderReplayEntry),
});
type ClaudeAgentSdkReplayTranscript = typeof ClaudeAgentSdkReplayTranscript.Type;

export class ClaudeReplayTranscriptDecodeError extends Schema.TaggedErrorClass<ClaudeReplayTranscriptDecodeError>()(
  "ClaudeReplayTranscriptDecodeError",
  {
    provider: Schema.optional(Schema.String),
    protocol: Schema.optional(Schema.String),
    scenario: Schema.optional(Schema.String),
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Failed to decode Claude Agent SDK replay transcript for scenario ${this.scenario ?? "<unknown>"}.`;
  }
}

export class ClaudeReplayExhaustedError extends Schema.TaggedErrorClass<ClaudeReplayExhaustedError>()(
  "ClaudeReplayExhaustedError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay transcript exhausted before outbound frame ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayUnexpectedOutboundError extends Schema.TaggedErrorClass<ClaudeReplayUnexpectedOutboundError>()(
  "ClaudeReplayUnexpectedOutboundError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expectedType: Schema.String,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Unexpected outbound Claude Agent SDK frame at replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayFrameMismatchError extends Schema.TaggedErrorClass<ClaudeReplayFrameMismatchError>()(
  "ClaudeReplayFrameMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Outbound Claude Agent SDK frame did not match replay cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayRuntimeExitError extends Schema.TaggedErrorClass<ClaudeReplayRuntimeExitError>()(
  "ClaudeReplayRuntimeExitError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    status: Schema.Literals(["error", "cancelled"]),
    error: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay exited with status ${this.status} at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

export class ClaudeReplayIncompleteError extends Schema.TaggedErrorClass<ClaudeReplayIncompleteError>()(
  "ClaudeReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
  },
) {
  override get message(): string {
    return `Claude Agent SDK replay ended with ${this.remaining} unconsumed entries in scenario ${this.scenario}.`;
  }
}

export const ClaudeAgentSdkReplayError = Schema.Union([
  ClaudeReplayTranscriptDecodeError,
  ClaudeReplayExhaustedError,
  ClaudeReplayUnexpectedOutboundError,
  ClaudeReplayFrameMismatchError,
  ClaudeReplayRuntimeExitError,
  ClaudeReplayIncompleteError,
]);
export type ClaudeAgentSdkReplayError = typeof ClaudeAgentSdkReplayError.Type;

interface ClaudeReplayQueryOptions {
  readonly model: string;
  readonly tools: NonNullable<ClaudeQueryOptions["tools"]>;
  readonly maxTurns: number;
  readonly permissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
  readonly sessionId: string;
  readonly cwd?: string;
}

interface ClaudeQueryFrame {
  readonly type: "query";
  readonly prompt: string;
  readonly options: ClaudeReplayQueryOptions;
}

interface ClaudeQueryInput {
  readonly prompt: string;
  readonly options: ClaudeReplayQueryOptions;
}

interface ClaudeQueryRunner {
  readonly run: (input: ClaudeQueryInput) => AsyncIterable<SDKMessage>;
  readonly assertComplete: () => void;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameFrame(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sdkMessageFromReplayFrame(frame: unknown): SDKMessage {
  return frame as SDKMessage;
}

function stableClaudeQueryOptions(options: ClaudeReplayQueryOptions): ClaudeReplayQueryOptions {
  return {
    model: options.model,
    tools: options.tools,
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    sessionId: options.sessionId,
  };
}

function makeClaudeQueryFrame(input: ClaudeQueryInput): ClaudeQueryFrame {
  return {
    type: "query",
    prompt: input.prompt,
    options: stableClaudeQueryOptions(input.options),
  };
}

function makeReplayQueryRunner(transcript: ClaudeAgentSdkReplayTranscript): ClaudeQueryRunner {
  let cursor = 0;
  let failure: ClaudeAgentSdkReplayError | null = null;

  const fail = (error: ClaudeAgentSdkReplayError): never => {
    failure = error;
    throw error;
  };

  async function* replayMessages(): AsyncGenerator<SDKMessage, void> {
    while (true) {
      if (failure !== null) {
        throw failure;
      }

      const entry = transcript.entries[cursor];
      if (entry === undefined) {
        return;
      }

      if (entry.type === "emit_inbound") {
        cursor += 1;
        yield sdkMessageFromReplayFrame(entry.frame);
        continue;
      }

      if (entry.type === "runtime_exit") {
        cursor += 1;
        if (entry.status === "success") {
          return;
        }
        fail(
          new ClaudeReplayRuntimeExitError({
            scenario: transcript.scenario,
            cursor: cursor - 1,
            status: entry.status,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          }),
        );
      }

      fail(
        new ClaudeReplayUnexpectedOutboundError({
          scenario: transcript.scenario,
          cursor,
          expectedType: entry.type,
          actual: { type: "query_stream" },
        }),
      );
    }
  }

  const assertNextQueryFrame = (input: ClaudeQueryInput) => {
    if (failure !== null) {
      throw failure;
    }
    const actual = makeClaudeQueryFrame(input);
    const entry = transcript.entries[cursor];
    if (entry === undefined) {
      return fail(
        new ClaudeReplayExhaustedError({
          scenario: transcript.scenario,
          cursor,
          actual,
        }),
      );
    }
    if (entry.type !== "expect_outbound") {
      return fail(
        new ClaudeReplayUnexpectedOutboundError({
          scenario: transcript.scenario,
          cursor,
          expectedType: entry.type,
          actual,
        }),
      );
    }

    const expected = entry.frame;
    if (!sameFrame(expected, actual)) {
      fail(
        new ClaudeReplayFrameMismatchError({
          scenario: transcript.scenario,
          cursor,
          ...(entry.label === undefined ? {} : { label: entry.label }),
          expected,
          actual,
        }),
      );
    }

    cursor += 1;
  };

  return {
    run: (input) => {
      assertNextQueryFrame(input);
      return replayMessages();
    },
    assertComplete: () => {
      if (failure !== null) {
        throw failure;
      }
      if (cursor !== transcript.entries.length) {
        throw new ClaudeReplayIncompleteError({
          scenario: transcript.scenario,
          cursor,
          remaining: transcript.entries.length - cursor,
        });
      }
    },
  };
}

function metadataFromTranscript(transcript: ProviderReplayTranscript): {
  readonly provider?: string;
  readonly protocol?: string;
  readonly scenario?: string;
} {
  return {
    provider: transcript.provider,
    protocol: transcript.protocol,
    scenario: transcript.scenario,
  };
}

function nativeSessionIdFor(transcript: ClaudeAgentSdkReplayTranscript): string {
  const metadataSessionId = transcript.metadata?.nativeSessionId;
  return typeof metadataSessionId === "string"
    ? metadataSessionId
    : "00000000-0000-4000-8000-000000000000";
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

function makeClaudeQueryOptions(input: {
  readonly modelSelection: ModelSelection;
  readonly sessionId: string;
  readonly cwd: string | null;
}): ClaudeReplayQueryOptions {
  const options: ClaudeReplayQueryOptions = {
    model: input.modelSelection.model,
    tools: [],
    maxTurns: 1,
    permissionMode: "default",
    sessionId: input.sessionId,
  };
  return input.cwd === null ? options : { ...options, cwd: input.cwd };
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

function makeClaudeProviderAdapterReplayLayer(
  transcript: ClaudeAgentSdkReplayTranscript,
): Layer.Layer<ProviderAdapterV2, never, IdAllocatorV2> {
  return Layer.effect(
    ProviderAdapterV2,
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocatorV2;
      const queryRunner = makeReplayQueryRunner(transcript);

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
            const nativeThreadId = nativeSessionIdFor(transcript);

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

                const assistant = yield* Effect.promise(async () => {
                  const collected = {
                    text: "",
                    nativeItemId: `assistant:${turnInput.runId}`,
                  };
                  const messages = queryRunner.run({
                    prompt: turnInput.message.text,
                    options: makeClaudeQueryOptions({
                      modelSelection: turnInput.modelSelection,
                      sessionId: nativeThreadId,
                      cwd: turnInput.runtimePolicy.cwd,
                    }),
                  });

                  for await (const message of messages) {
                    const assistantText = assistantTextFromSdkMessage(message);
                    if (assistantText !== null && assistantText.text.length > 0) {
                      collected.text += assistantText.text;
                      collected.nativeItemId = assistantText.nativeItemId;
                    }
                    const resultText = resultTextFromSdkMessage(message);
                    if (
                      collected.text.length === 0 &&
                      resultText !== null &&
                      resultText.text.length > 0
                    ) {
                      collected.text = resultText.text;
                      collected.nativeItemId = resultText.nativeItemId;
                    }
                  }

                  return collected;
                });

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
                queryRunner.assertComplete();
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
                    cause: "Claude replay adapter does not implement interrupts.",
                  }),
                ),
              respondToRuntimeRequest: (requestInput) =>
                Effect.fail(
                  new ProviderAdapterRuntimeRequestResponseError({
                    provider: CLAUDE_PROVIDER,
                    requestId: requestInput.requestId,
                    cause: "Claude replay adapter does not implement runtime requests.",
                  }),
                ),
              readThreadSnapshot: (snapshotInput) =>
                Effect.fail(
                  new ProviderAdapterReadThreadSnapshotError({
                    provider: CLAUDE_PROVIDER,
                    providerThreadId: snapshotInput.providerThread.id,
                    cause: "Claude replay adapter does not implement snapshots.",
                  }),
                ),
              rollbackThread: (rollbackInput) =>
                Effect.fail(
                  new ProviderAdapterRollbackThreadError({
                    provider: CLAUDE_PROVIDER,
                    providerThreadId: rollbackInput.providerThread.id,
                    cause: "Claude replay adapter does not implement rollback.",
                  }),
                ),
              forkThread: (forkInput) =>
                Effect.fail(
                  new ProviderAdapterForkThreadError({
                    provider: CLAUDE_PROVIDER,
                    providerThreadId: forkInput.sourceProviderThread.id,
                    cause: "Claude replay adapter does not implement forks.",
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
}

export function makeClaudeProviderAdapterRegistryReplayLayer(
  transcript: ClaudeAgentSdkReplayTranscript,
) {
  const adapterLayer = makeClaudeProviderAdapterReplayLayer(transcript);
  return layerFromProviderAdapter.pipe(
    Layer.provide(adapterLayer),
    Layer.provide(idAllocatorLayer),
  );
}

export async function replayClaudeAgentSdkTranscript(input: {
  readonly transcript: ClaudeAgentSdkReplayTranscript;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly cwd?: string;
}): Promise<ReadonlyArray<SDKMessage>> {
  const queryRunner = makeReplayQueryRunner(input.transcript);
  const messages: Array<SDKMessage> = [];
  const stream = queryRunner.run({
    prompt: input.prompt,
    options: makeClaudeQueryOptions({
      modelSelection: input.modelSelection,
      sessionId: nativeSessionIdFor(input.transcript),
      cwd: input.cwd ?? null,
    }),
  });
  for await (const message of stream) {
    messages.push(message);
  }
  queryRunner.assertComplete();
  return messages;
}

function serializeReplayError(error: unknown): unknown {
  return error instanceof Error
    ? {
        name: error.name,
        message: error.message,
      }
    : error;
}

export async function recordClaudeAgentSdkReplayTranscript(input: {
  readonly scenario: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly cwd: string;
  readonly sessionId?: string;
}): Promise<ClaudeAgentSdkReplayTranscript> {
  const entries: Array<ProviderReplayEntry> = [];
  const sessionId = input.sessionId ?? (await Effect.runPromise(Random.nextUUIDv4));
  const queryInput = {
    prompt: input.prompt,
    options: makeClaudeQueryOptions({
      modelSelection: input.modelSelection,
      sessionId,
      cwd: input.cwd,
    }),
  };

  entries.push({
    type: "expect_outbound",
    label: "query",
    frame: makeClaudeQueryFrame(queryInput),
  });

  try {
    const stream = query(queryInput);
    for await (const message of stream) {
      entries.push({
        type: "emit_inbound",
        label: message.type,
        frame: message,
      });
    }
    entries.push({
      type: "runtime_exit",
      status: "success",
    });
  } catch (error) {
    entries.push({
      type: "runtime_exit",
      status: "error",
      error: serializeReplayError(error),
    });
    throw error;
  }

  return {
    provider: CLAUDE_PROVIDER,
    protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
    version: "0.2.111",
    scenario: input.scenario,
    metadata: {
      prompt: input.prompt,
      model: input.modelSelection.model,
      nativeSessionId: sessionId,
      generatedBy: "recordClaudeAgentSdkReplayTranscript",
    },
    entries,
  };
}

export const ClaudeOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  ClaudeAgentSdkReplayTranscript,
  ClaudeAgentSdkReplayError
> = {
  provider: CLAUDE_PROVIDER,
  decodeTranscript: (transcript) =>
    Schema.decodeUnknownEffect(ClaudeAgentSdkReplayTranscript)(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeReplayTranscriptDecodeError({
            ...metadataFromTranscript(transcript),
            cause,
          }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    makeClaudeProviderAdapterRegistryReplayLayer(transcript),
};
