// Extracted from server/adapter.ts.
// @effect-diagnostics anyUnknownInErrorContext:off

import {
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2ProviderFailure,
  type ProviderUserInputAnswers,
  type OrchestrationV2ProviderTurn,
  type TurnTokenUsage,
  type ChatAttachment,
  type ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type ModelSelection,
  type RuntimeMode,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { type AcpPermissionDisposition } from "./clientPolicy.ts";
import { type AcpSessionModeState, type AcpToolCallState } from "./runtimeModel.ts";
import { type BackgroundWork } from "@t3tools/provider-core/server/notification";
import { type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpProtocol from "effect-acp/protocol";
import * as EffectAcpSchema from "effect-acp/compat";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";

export const ACP_PROTOCOL = "acp.ndjson-jsonrpc" as const;

export const ACP_DEFERRED_FINALIZE_DEBOUNCE: Duration.Input = "3000 millis";

export const ACP_TEXT_FLUSH_INTERVAL: Duration.Input = "50 millis";

export interface AcpAdapterV2RuntimeInput {
  readonly cwd: string;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly mcpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly httpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly resumeSessionId?: string;
  readonly interruptPromptOnCancel?: boolean;
  readonly clientCapabilities: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: AcpSessionRuntime.AcpSessionRuntimeOptions["clientInfo"];
  readonly requestLogger?: NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["requestLogger"]>;
  readonly protocolLogging: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]
  >;
  readonly onTermination: NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]>;
  readonly onOutgoingResponseFailure?: AcpSessionRuntime.AcpSessionRuntimeOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: AcpSessionRuntime.AcpSessionRuntimeOptions["onOutgoingResponse"];
}

export type AcpAdapterV2NativeLogging = Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "requestLogger" | "protocolLogging"
>;

export interface AcpAdapterV2UserInputRequest {
  readonly nativeItemId: string;
  readonly nativeRequestId: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

export interface AcpAdapterV2ExtensionContext {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly reportProviderRetry: (input: {
    readonly sessionId: string;
    readonly failure: OrchestrationV2ProviderFailure;
  }) => Effect.Effect<void>;
  readonly finishSubagent: (notice: {
    readonly sessionId: string;
    readonly childSessionId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly result: string | null;
  }) => Effect.Effect<void>;
  readonly applyBackgroundTaskMutation: (mutation: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly output?: string;
    readonly report?: BackgroundWork;
  }) => Effect.Effect<void>;
  readonly requestUserInput: (
    input: AcpAdapterV2UserInputRequest,
    requestContext: EffectAcpProtocol.AcpRequestContext,
  ) => Effect.Effect<
    {
      readonly acknowledgeNativeResponse: Effect.Effect<void, EffectAcpErrors.AcpError>;
      readonly answers: ProviderUserInputAnswers | null;
    },
    EffectAcpErrors.AcpError
  >;
  readonly captureProposedPlan: (input: { readonly planMarkdown: string }) => Effect.Effect<void>;
  readonly lastProposedPlanMarkdown: Effect.Effect<string | undefined>;
}

export function acpPerTurnPromptUsage(
  usage: EffectAcpSchema.Usage | null | undefined,
  hasSubagents: boolean,
  terminalStatus: OrchestrationV2ProviderTurn["status"],
  geminiUsage = false,
): TurnTokenUsage {
  if (usage == null) {
    return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents };
  }
  const inputTokens = geminiUsage
    ? usage.inputTokens + (usage.cachedReadTokens ?? 0)
    : usage.inputTokens;
  const outputTokens = geminiUsage
    ? usage.outputTokens + (usage.thoughtTokens ?? 0)
    : usage.outputTokens;
  // TurnTokenUsage contract: input includes cache read + write and reasoning
  // is a subset of output, so clamp counters that exceed their parent and
  // drop the ones the agent left unset. Cache writes are capped at whatever
  // cache reads leave of input, so the pair cannot exceed it.
  const clampSubset = (value: number | null | undefined, parent: number) =>
    value == null ? undefined : Math.min(value, parent);
  const cachedInputTokens = clampSubset(usage.cachedReadTokens, inputTokens);
  const cacheCreationTokens = clampSubset(
    usage.cachedWriteTokens,
    inputTokens - (cachedInputTokens ?? 0),
  );
  const reasoningTokens = clampSubset(usage.thoughtTokens, outputTokens);
  return {
    usageScope: "main_agent",
    usageStatus: terminalStatus === "completed" ? "complete" : "partial",
    hasSubagents,
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export interface AcpAdapterV2Flavor {
  readonly buildPrompt?: (input: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
    readonly promptCapabilities: EffectAcpSchema.AgentCapabilities["promptCapabilities"];
    readonly agentVersion: string | undefined;
    /** The session's model after selection, with its display name when the agent lists it. */
    readonly currentModel: { readonly id: string; readonly name: string | undefined } | undefined;
  }) => Effect.Effect<ReadonlyArray<EffectAcpSchema.ContentBlock>, EffectAcpErrors.AcpError>;
  readonly promptFailure?: (cause: unknown) => OrchestrationV2ProviderFailure;
  /**
   * Runs before `session/prompt`. The returned check sees a prompt the agent ended
   * without an error or cancel, and reports a failure its stop reason hid. A reported
   * failure restarts the runtime before the next turn.
   */
  readonly watchPromptOutcome?: (
    sessionId: string,
  ) => Effect.Effect<
    (
      result: EffectAcpSchema.PromptResponse,
    ) => Effect.Effect<OrchestrationV2ProviderFailure | undefined>
  >;
  readonly requiresSignIn?: (cause: unknown) => boolean;
  /**
   * Runs before attachment paths, T3 instructions and native slash-command detection,
   * so a rewrite can turn the user's text into a native command.
   */
  readonly rewriteUserText?: (
    text: string,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner>;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly clientCapabilitiesMeta?: NonNullable<
    EffectAcpSchema.InitializeRequest["clientCapabilities"]
  >["_meta"];
  readonly mcpOverHttp?: boolean;
  readonly normalizeSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
  /**
   * Agent updates that belong to no turn (Kiro's own cloud-config fetch). They
   * are dropped before anything reads them, so they neither show in the turn
   * nor count as it starting.
   */
  readonly ignoreSessionUpdate?: (notification: EffectAcpSchema.SessionNotification) => boolean;
  readonly onAvailableCommandsUpdate?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  readonly onSessionConfigurationUpdate?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    modeState: AcpSessionModeState | undefined,
    modelState: EffectAcpSchema.SessionModelState | null | undefined,
  ) => Effect.Effect<void>;
  readonly onUrlElicitation?: (input: {
    readonly elicitationId: string;
    readonly url: string;
    readonly message: string;
  }) => Effect.Effect<boolean>;
  readonly extractElicitationForm?: (request: EffectAcpSchema.CreateElicitationRequest) =>
    | {
        readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
        readonly respond: (
          answers: ProviderUserInputAnswers,
        ) => EffectAcpSchema.CreateElicitationResponse;
      }
    | undefined;
  readonly withRuntimeStartup?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly makeRuntime: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly customModels?: ReadonlyArray<string>;
  readonly resolveModelId?: (selection: ModelSelection) => string | undefined;
  /**
   * The agent advertises its model option only after `session/new` returns
   * (Kiro sends it in a `config_option_update`), so in-session model switching
   * is not inferred from the setup result.
   */
  readonly modelOptionArrivesLate?: boolean;
  readonly getModelContextWindow?: (
    selection: ModelSelection,
    session: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  ) => number | undefined;
  readonly applyModelSelection?: (input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<string | undefined, EffectAcpErrors.AcpError>;
  /**
   * Model-selection option ids `applyModelSelection` sets itself under a
   * native id, which the generic option loop then skips (Kiro's
   * `reasoningEffort` is its `effortLevel`).
   */
  readonly ownedModelOptionIds?: ReadonlyArray<string>;
  readonly sessionModeForPolicy?: (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ) => string | undefined;
  /**
   * Native select-option values to apply for a runtime policy (e.g. Kiro's
   * `autopilot`), set on every session configure. A value the session does
   * not advertise is skipped; an agent rejecting it fails the session.
   */
  readonly sessionConfigForPolicy?: (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ) => ReadonlyArray<{ readonly id: string; readonly value: string }>;
  /**
   * The runtime mode a native session mode grants, for flavors whose modes are permission levels.
   * Under a policy ceiling, a mode the user picks that this does not place under it is not applied.
   */
  readonly runtimeModeForSessionMode?: (modeId: string) => RuntimeMode | undefined;
  readonly clientFileSystem?: {
    readonly readTextFile: (
      request: EffectAcpSchema.ReadTextFileRequest,
      cwd: string | null,
    ) => Effect.Effect<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError>;
    readonly writeTextFile?: (
      request: EffectAcpSchema.WriteTextFileRequest,
      cwd: string | null,
    ) => Effect.Effect<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError>;
  };
  readonly extractPermissionQuestion?: (request: EffectAcpSchema.RequestPermissionRequest) =>
    | {
        readonly question: OrchestrationV2UserInputQuestion;
        readonly respond: (
          answers: ProviderUserInputAnswers,
        ) => EffectAcpSchema.RequestPermissionResponse | undefined;
      }
    | undefined;
  /** Grok Auto asks only about classifier refusals; T3 policy must not auto-approve them. */
  readonly permissionDisposition?: (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => AcpPermissionDisposition;
  readonly approvalOptions?: (
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => ReadonlyArray<ProviderApprovalOption>;
  readonly onSessionEvent?: (
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
  ) => Effect.Effect<void>;
  readonly subagentsIdleOnTurnCompletion?: boolean;
  readonly supportsCompaction?: boolean;
  /**
   * Native steering: `send` queues a message into the running turn and returns the
   * agent's id for it, which `injectedSteerId` reads from the update that delivers it.
   */
  readonly steering?: {
    readonly send: (
      runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
      sessionId: string,
      text: string,
    ) => Effect.Effect<string, EffectAcpErrors.AcpError>;
    readonly injectedSteerId: (
      notification: EffectAcpSchema.SessionNotification,
    ) => string | undefined;
  };
  /**
   * Native fork from an earlier turn. `nativeTurnId` reads the agent's id for a running
   * turn's prompt, which the turn keeps as its native ref; forking from that turn sends
   * `forkMeta(id)` as the `session/fork` `_meta`.
   */
  readonly forkFromTurn?: {
    readonly supported: (
      initializeResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["initializeResult"],
    ) => boolean;
    readonly nativeTurnId: (
      notification: EffectAcpSchema.SessionNotification,
    ) => string | undefined;
    readonly forkMeta: (
      nativeTurnId: string,
    ) => NonNullable<EffectAcpSchema.ForkSessionRequest["_meta"]>;
  };
  /** Compacts with the agent's own request, for agents that answer a `/compact` prompt as chat. */
  readonly compactSession?: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
    sessionId: string,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly runtimeHarness?: string;
  readonly registerExtensions?: (
    context: AcpAdapterV2ExtensionContext,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly extractSubagentSessionEvent?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => AcpSubagentSessionEvent | undefined;
  readonly extractSubagentUpdate?: (
    toolCall: AcpToolCallState,
  ) => AcpAdapterV2SubagentUpdate | undefined;
  readonly isProvisionalSubagentTool?: (toolCall: AcpToolCallState) => boolean;
  readonly normalizeToolCall?: (toolCall: AcpToolCallState) => AcpToolCallState;
  readonly extractProposedPlanMarkdown?: (toolCall: AcpToolCallState) => string | undefined;
  readonly extractBackgroundTaskId?: (toolCall: AcpToolCallState) => string | undefined;
  /** Distinguishes commands from monitors when lifecycle notifications omit their kind. */
  readonly isBackgroundCommandTool?: (toolCall: AcpToolCallState) => boolean;
  readonly extractBackgroundToolMutation?: (text: string) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  readonly extractSubagentEndNotice?: (text: string) =>
    | {
        readonly childSessionId: string;
        readonly status: "completed" | "failed";
      }
    | undefined;
  readonly extractBackgroundTaskCompletion?: (toolCall: AcpToolCallState) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  readonly isPersistentBackgroundTool?: (toolCall: AcpToolCallState) => boolean;
  readonly isProviderWakeNotification?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => boolean;
  readonly deferFinalizeForBackgroundWork?: boolean;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Interrupt the local prompt fiber before `session/cancel` (Grok wedged prompts). */
  readonly interruptPromptOnCancel?: boolean;
  /**
   * Hold `session/cancel` until an update after `session/prompt` matches `isStart`,
   * or `bound` has passed; skip it if the prompt settles first. Kiro 2.27.1 can
   * drop a cancel sent just after the prompt and run the turn to completion.
   */
  readonly cancelAfterPromptStarts?: {
    readonly isStart: (update: EffectAcpSchema.SessionUpdate) => boolean;
    readonly bound: Duration.Input;
  };
  /**
   * The agent's PromptResponse.usage counters read per-turn. The ACP spec
   * leaves usage semantics open, so this stays unset until proven live.
   */
  readonly reportsPerTurnPromptUsage?: boolean;
  /** Gemini-style usage: inputTokens leaves out cachedReadTokens, outputTokens leaves out thoughtTokens. */
  readonly geminiPromptUsage?: boolean;
  /** Grok can retain task_already_running until process exit. */
  readonly restartRuntimeAfterInterrupt?: boolean;
  /** Prompt failures after which the agent process keeps failing until replaced. */
  readonly restartRuntimeAfterPromptError?: (error: unknown) => boolean;
  readonly restartRuntimeOnEveryInterrupt?: boolean;
  readonly terminateRuntimeProcessGroupOnInterrupt?: boolean;
  readonly preserveRuntimeOnSettledInterrupt?: boolean;
  readonly enablePostSettleContinuation?: boolean;
  /** Settle on native idle after the accepted user echo, only on negotiated ACP v2. */
  readonly followAgentWorkState?: boolean;
  /**
   * Grok CLI currently accepts and vision-processes image blocks while still
   * reporting the capability as false; without this override, screenshot turns
   * fail before `session/prompt`.
   */
  readonly supportsImagePrompts?: boolean;
  /**
   * True when this session's native system prompt carries T3's PR-linking instructions, so
   * turns omit them. Must use the same negotiated check that sent them on session setup.
   */
  readonly sessionCarriesPullRequestLinking?: (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ) => boolean;
}

export type AcpSubagentSessionEvent =
  | {
      readonly type: "state";
      readonly childSessionId: string;
      readonly parentSessionId: string;
      readonly status: "running" | "completed" | "failed" | "cancelled";
      readonly result: string | null;
    }
  | {
      readonly type: "delegation";
      readonly childSessionId: string;
      readonly parentSessionId: string | null;
      readonly delegationId: string;
      readonly prompt: string;
    };

export interface AcpAdapterV2SubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly status:
    | "pending"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  readonly childSessionId: string | null;
  readonly result: string | null;
  readonly suppressNormalTool?: boolean;
}

export interface AcpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly flavor: AcpAdapterV2Flavor;
  readonly selfInvocation: SelfInvocation;
  readonly clientTerminals?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly shellCommands?: boolean;
  };
  readonly nativeLogging?: (threadId: ThreadId) => AcpAdapterV2NativeLogging;
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
  readonly testHooks?: {
    readonly onDeferredFinalizeScheduled?: (debounce: Duration.Input) => Effect.Effect<void>;
    /** `cancelAfterPromptStarts`: Stop is holding `session/cancel` until the prompt starts. */
    readonly onCancelHeld?: () => Effect.Effect<void>;
    readonly afterPromptWireSettled?: () => Effect.Effect<void>;
    readonly afterPromptSettledWithBackgroundWork?: () => Effect.Effect<void>;
    readonly onNativeResponseLifecycle?: (event: {
      readonly generation?: number;
      readonly requestId?: string;
      readonly type:
        | "admission_rejected"
        | "failed"
        | "late_noop"
        | "registered"
        | "removed"
        | "timer_exited"
        | "timer_started"
        | "watcher_exited"
        | "watcher_started";
    }) => Effect.Effect<void>;
  };
}

export const AcpProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
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
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
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
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
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
    // ACP lacks truncation; rollback restores T3 checkpoints and starts a fresh agent session.
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
  runtimePolicy: {
    enforcement: "client-boundary",
  },
} satisfies OrchestrationV2ProviderCapabilities;
