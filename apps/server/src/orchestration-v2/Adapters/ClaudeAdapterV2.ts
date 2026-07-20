import {
  type CanUseTool,
  forkSession as forkClaudeSession,
  type ForkSessionOptions,
  type ForkSessionResult,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type Query as ClaudeQuery,
  type Settings as ClaudeSdkSettings,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { WebSearchOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { applyClaudePromptEffortPrefix } from "@t3tools/shared/model";
import {
  type ChatAttachment,
  ClaudeSettings,
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2WebSearchResult,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { compileClaudeModelSelection } from "../../claudeModelOptions.ts";
import { ServerConfig } from "../../config.ts";
import { makeClaudeEnvironment } from "../../provider/Drivers/ClaudeHome.ts";
import {
  type EventNdjsonLogger,
  makeEventNdjsonLogger,
} from "../../provider/Layers/EventNdjsonLogger.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import {
  ProviderAdapterEnsureThreadError,
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
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2ForkThreadInput,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2RollbackThreadInput,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2SteerInput,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "../ProviderContinuationRequests.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";

export const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");
export const CLAUDE_AGENT_SDK_QUERY_PROTOCOL = "claude-agent-sdk.query" as const;
export const CLAUDE_DRIVER_KIND = CLAUDE_PROVIDER;
export const CLAUDE_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER_KIND);
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

export const ClaudeProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
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
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
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
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
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
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

const CLAUDE_CODE_PRESET_TOOLS = {
  type: "preset",
  preset: "claude_code",
} satisfies NonNullable<ClaudeQueryOptions["tools"]>;

export type ClaudeAgentSdkQueryToolList = ReadonlyArray<string>;
export interface ClaudeAgentSdkQueryPresetTools {
  readonly type: "preset";
  readonly preset: "claude_code";
}
export type ClaudeAgentSdkQueryTools = ClaudeAgentSdkQueryToolList | ClaudeAgentSdkQueryPresetTools;

export const CLAUDE_READ_ONLY_ALLOWED_TOOLS = ["Read", "Glob", "Grep"] as const;

function claudeAgentSdkQueryToolsForSdk(
  tools: ClaudeAgentSdkQueryTools,
): NonNullable<ClaudeQueryOptions["tools"]> {
  if (isClaudeAgentSdkQueryToolList(tools)) {
    return [...tools];
  }
  return { type: tools.type, preset: tools.preset };
}

function isClaudeAgentSdkQueryToolList(
  tools: ClaudeAgentSdkQueryTools,
): tools is ClaudeAgentSdkQueryToolList {
  return Array.isArray(tools);
}

type ClaudeAgentSdkThreadIdentity =
  | {
      readonly sessionId: string;
      readonly resume?: never;
    }
  | {
      readonly sessionId?: never;
      readonly resume: string;
    };

export type ClaudeAgentSdkQueryOptions = Omit<
  ClaudeQueryOptions,
  "maxTurns" | "model" | "permissionMode" | "resume" | "sessionId" | "tools"
> & {
  readonly model: string;
  readonly tools: NonNullable<ClaudeQueryOptions["tools"]>;
  readonly permissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
} & ClaudeAgentSdkThreadIdentity;

export interface ClaudeAgentSdkQueryOpenInput {
  readonly options: ClaudeAgentSdkQueryOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

export interface ClaudeAgentSdkQuerySession {
  readonly messages: Stream.Stream<SDKMessage, ClaudeAgentSdkQueryRunnerError>;
  readonly offer: (message: SDKUserMessage) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly setModel: (model: string) => Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly interrupt: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  readonly close: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

type ClaudeQueryStreamExit = Exit.Exit<void, ClaudeAgentSdkQueryRunnerError>;

export class ClaudeAgentSdkQueryRunnerError extends Schema.TaggedErrorClass<ClaudeAgentSdkQueryRunnerError>()(
  "ClaudeAgentSdkQueryRunnerError",
  {
    method: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Claude Agent SDK query failed.";
  }
}

export interface ClaudeAgentSdkQueryRunnerShape {
  readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
  readonly open: (
    input: ClaudeAgentSdkQueryOpenInput,
  ) => Effect.Effect<ClaudeAgentSdkQuerySession, ClaudeAgentSdkQueryRunnerError>;
  readonly forkSession: (
    input: ClaudeAgentSdkSessionForkInput,
  ) => Effect.Effect<ForkSessionResult, ClaudeAgentSdkQueryRunnerError>;
  readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerShape
>()("t3/orchestration-v2/Adapters/ClaudeAdapterV2/ClaudeAgentSdkQueryRunner") {}

export interface ClaudeAgentSdkSessionForkInput {
  readonly sessionId: string;
  readonly options: ForkSessionOptions;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}

function queryRunnerError(cause: unknown, method: string): ClaudeAgentSdkQueryRunnerError {
  return Schema.is(ClaudeAgentSdkQueryRunnerError)(cause)
    ? cause
    : new ClaudeAgentSdkQueryRunnerError({ cause, method });
}

function closeClaudeQuery(queryRuntime: ClaudeQuery) {
  return Effect.try({
    try: () => queryRuntime.close(),
    catch: (cause) => queryRunnerError(cause, "close"),
  });
}

// Iterate the Query itself, not query[Symbol.asyncIterator]() (the raw
// sdkMessages generator). The raw generator's return() queues behind the
// in-flight read of the next CLI message and never settles while the CLI is
// idle, deadlocking stream interruption (and with it, session scope close).
// Query.return() runs cleanup() first, which closes the transport and
// unblocks that read.
export function claudeQueryMessages(queryRuntime: ClaudeQuery): AsyncIterable<SDKMessage, void> {
  return { [Symbol.asyncIterator]: () => queryRuntime };
}

export interface ClaudeAgentSdkLoggedQueryOptions {
  readonly model: ClaudeAgentSdkQueryOptions["model"];
  readonly tools: ClaudeAgentSdkQueryOptions["tools"];
  readonly permissionMode: ClaudeAgentSdkQueryOptions["permissionMode"];
  readonly sessionId?: string;
  readonly resume?: string;
  readonly resumeSessionAt?: ClaudeAgentSdkQueryOptions["resumeSessionAt"];
  readonly cwd?: ClaudeAgentSdkQueryOptions["cwd"];
  readonly allowedTools?: ClaudeAgentSdkQueryOptions["allowedTools"];
  readonly disallowedTools?: ClaudeAgentSdkQueryOptions["disallowedTools"];
  readonly settings?: ClaudeAgentSdkQueryOptions["settings"];
  readonly effort?: ClaudeAgentSdkQueryOptions["effort"];
  readonly includePartialMessages?: true;
  readonly pathToClaudeCodeExecutable?: ClaudeAgentSdkQueryOptions["pathToClaudeCodeExecutable"];
  readonly hasExtraArgs?: true;
  readonly allowDangerouslySkipPermissions?: true;
  readonly hasCanUseTool?: true;
  readonly hasEnvironment?: true;
  readonly hasMcpServers?: true;
}

export type ClaudeAgentSdkProtocolLogEvent =
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.open";
        readonly options: ClaudeAgentSdkLoggedQueryOptions;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "prompt.offer";
        readonly message: SDKUserMessage;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.set_model";
        readonly model: string;
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.interrupt";
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "query.close";
      };
    }
  | {
      readonly direction: "outgoing";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "session.fork";
        readonly sessionId: string;
        readonly options: ForkSessionOptions;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: {
        readonly type: "session.forked";
        readonly sessionId: string;
      };
    }
  | {
      readonly direction: "incoming";
      readonly stage: "decoded";
      readonly payload: SDKMessage;
    };

export type ClaudeAgentSdkProtocolLogger = (
  event: ClaudeAgentSdkProtocolLogEvent,
) => Effect.Effect<void>;

export function loggedClaudeQueryOptions(
  options: ClaudeAgentSdkQueryOptions,
): ClaudeAgentSdkLoggedQueryOptions {
  return {
    model: options.model,
    tools: options.tools,
    permissionMode: options.permissionMode,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.resumeSessionAt === undefined ? {} : { resumeSessionAt: options.resumeSessionAt }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools }),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.includePartialMessages === true ? { includePartialMessages: true } : {}),
    ...(options.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }),
    ...(options.extraArgs === undefined ? {} : { hasExtraArgs: true }),
    ...(options.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(options.canUseTool === undefined ? {} : { hasCanUseTool: true }),
    ...(options.env === undefined ? {} : { hasEnvironment: true }),
    ...(options.mcpServers === undefined ? {} : { hasMcpServers: true }),
  };
}

export function makeClaudeAgentSdkProtocolLogger(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): ClaudeAgentSdkProtocolLogger | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) =>
    nativeEventLogger
      .write(
        {
          provider: CLAUDE_PROVIDER,
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event,
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
}

export const claudeAgentSdkQueryRunnerLiveLayer: Layer.Layer<
  ClaudeAgentSdkQueryRunner,
  never,
  Crypto.Crypto | ServerConfig
> = Layer.effect(
  ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });

    return ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => queryRunnerError(cause, "allocateSessionId")),
      ),
      open: Effect.fn("ClaudeAgentSdkQueryRunner.open")(function* (
        input: ClaudeAgentSdkQueryOpenInput,
      ) {
        const protocolLogger = makeClaudeAgentSdkProtocolLogger({
          nativeEventLogger,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        });
        const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
          protocolLogger === undefined ? Effect.void : protocolLogger(event);
        const promptQueue = yield* Queue.unbounded<SDKUserMessage>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.toAsyncIterable,
        );
        const queryRuntime = yield* Effect.try({
          try: () =>
            query({
              prompt,
              options: input.options,
            }),
          catch: (cause) => queryRunnerError(cause, "query"),
        });
        yield* logProtocolEvent({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "query.open",
            options: loggedClaudeQueryOptions(input.options),
          },
        });

        return {
          messages: Stream.fromAsyncIterable(claudeQueryMessages(queryRuntime), (cause) =>
            queryRunnerError(cause, "fromAsyncIterable"),
          ).pipe(
            Stream.tap((message) =>
              logProtocolEvent({
                direction: "incoming",
                stage: "decoded",
                payload: message,
              }),
            ),
          ),
          offer: (message) =>
            Queue.offer(promptQueue, message).pipe(
              Effect.asVoid,
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "prompt.offer",
                    message,
                  },
                }),
              ),
            ),
          setModel: (model) =>
            Effect.tryPromise({
              try: () => queryRuntime.setModel(model),
              catch: (cause) => queryRunnerError(cause, "setModel"),
            }).pipe(
              Effect.tap(() =>
                logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.set_model",
                    model,
                  },
                }),
              ),
            ),
          interrupt: Effect.tryPromise({
            try: () => queryRuntime.interrupt(),
            catch: (cause) => queryRunnerError(cause, "interrupt"),
          }).pipe(
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "query.interrupt",
                },
              }),
            ),
          ),
          close: Queue.shutdown(promptQueue).pipe(
            Effect.andThen(closeClaudeQuery(queryRuntime)),
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "query.close",
                },
              }),
            ),
          ),
        } satisfies ClaudeAgentSdkQuerySession;
      }),
      forkSession: Effect.fn("ClaudeAgentSdkQueryRunner.forkSession")(function* (
        input: ClaudeAgentSdkSessionForkInput,
      ) {
        const protocolLogger = makeClaudeAgentSdkProtocolLogger({
          nativeEventLogger,
          threadId: input.threadId,
          providerSessionId: input.providerSessionId,
        });
        const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
          protocolLogger === undefined ? Effect.void : protocolLogger(event);
        yield* logProtocolEvent({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "session.fork",
            sessionId: input.sessionId,
            options: input.options,
          },
        });
        const result = yield* Effect.tryPromise({
          try: () => forkClaudeSession(input.sessionId, input.options),
          catch: (cause) => queryRunnerError(cause, "forkSession"),
        });
        yield* logProtocolEvent({
          direction: "incoming",
          stage: "decoded",
          payload: {
            type: "session.forked",
            sessionId: result.sessionId,
          },
        });
        return result;
      }),
      assertComplete: Effect.void,
    });
  }),
);

export function makeClaudeQueryOptions(input: {
  readonly modelSelection: ModelSelection;
  readonly nativeThreadId: string;
  readonly resume: boolean;
  readonly resumeSessionAt?: string;
  readonly cwd: string | null;
  readonly settings?: ClaudeSettings;
  readonly sdkSettings?: string | ClaudeSdkSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly mcpServers?: ClaudeQueryOptions["mcpServers"];
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly permissionMode?: PermissionMode;
  readonly canUseTool?: CanUseTool;
  readonly allowDangerouslySkipPermissions?: boolean;
}): ClaudeAgentSdkQueryOptions {
  const compiledSelection = compileClaudeModelSelection(input.modelSelection);
  const extraArgs =
    input.settings === undefined ? {} : parseCliArgs(input.settings.launchArgs).flags;
  const threadIdentity: ClaudeAgentSdkThreadIdentity = input.resume
    ? { resume: input.nativeThreadId }
    : { sessionId: input.nativeThreadId };
  const selectedTools = input.tools ?? CLAUDE_CODE_PRESET_TOOLS;
  const selectionSettings =
    Object.keys(compiledSelection.settings).length === 0
      ? undefined
      : (compiledSelection.settings as ClaudeSdkSettings);
  const querySettings =
    selectionSettings === undefined
      ? input.sdkSettings
      : typeof input.sdkSettings === "object" && input.sdkSettings !== null
        ? ({ ...input.sdkSettings, ...selectionSettings } as ClaudeSdkSettings)
        : selectionSettings;
  const options: ClaudeAgentSdkQueryOptions = {
    model: compiledSelection.apiModelId,
    tools: claudeAgentSdkQueryToolsForSdk(selectedTools),
    permissionMode: input.permissionMode ?? "default",
    includePartialMessages: true,
    ...(compiledSelection.effort === undefined
      ? {}
      : {
          effort: compiledSelection.effort as NonNullable<ClaudeQueryOptions["effort"]>,
        }),
    ...threadIdentity,
    ...(input.resumeSessionAt === undefined ? {} : { resumeSessionAt: input.resumeSessionAt }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: [...input.allowedTools] }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: [...input.disallowedTools] }),
    ...(input.canUseTool === undefined ? {} : { canUseTool: input.canUseTool }),
    ...(input.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(querySettings === undefined ? {} : { settings: querySettings }),
    ...(input.settings?.binaryPath
      ? { pathToClaudeCodeExecutable: input.settings.binaryPath }
      : {}),
    ...(input.environment === undefined ? {} : { env: input.environment }),
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
    ...(Object.keys(extraArgs).length === 0 ? {} : { extraArgs }),
  };
  return input.cwd === null ? options : { ...options, cwd: input.cwd };
}

export const CLAUDE_T3_MCP_TOOL_WILDCARD = "mcp__t3-code__*";

// Must stay in sync with the Tool.Readonly annotations on OrchestratorToolkit;
// ClaudeAdapterV2.test.ts cross-checks this list against the toolkit.
export const CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS: ReadonlyArray<string> = [
  "mcp__t3-code__orchestrator_capabilities",
  "mcp__t3-code__task_status",
  "mcp__t3-code__list_scheduled_tasks",
  "mcp__t3-code__t3_thread_list",
  "mcp__t3-code__t3_thread_read",
  "mcp__t3-code__t3_thread_wait",
];

// The SDK's `allowedTools` only pre-approves tool calls; availability is the
// separate `tools` option. Attaching the t3-code MCP server therefore always
// pre-approves its tools (headless modes like `dontAsk` deny anything that is
// not pre-approved), but read-only sandboxes pre-approve only the annotated
// read-only orchestrator tools so a read-only session cannot silently spawn
// threads or scheduled tasks.
export function claudeMcpQueryOverrides(input: {
  readonly threadId: ThreadId;
  readonly readOnlySandbox: boolean;
  readonly allowedTools?: ReadonlyArray<string>;
}): {
  readonly allowedTools?: ReadonlyArray<string>;
  readonly mcpServers?: ClaudeQueryOptions["mcpServers"];
} {
  const session = McpProviderSession.readMcpProviderSession(input.threadId);
  if (session === undefined) {
    return input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools };
  }
  const mcpAllowedTools = input.readOnlySandbox
    ? CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS
    : [CLAUDE_T3_MCP_TOOL_WILDCARD];
  return {
    allowedTools: Array.from(new Set([...(input.allowedTools ?? []), ...mcpAllowedTools])),
    mcpServers: {
      "t3-code": {
        type: "http",
        url: session.endpoint,
        headers: {
          Authorization: session.authorizationHeader,
        },
      },
    },
  };
}

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CLAUDE_PROVIDER,
    providerInstanceId: input.providerInstanceId,
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
  readonly providerInstanceId: ProviderInstanceId;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly forkedFrom?: NonNullable<OrchestrationV2ProviderThread["forkedFrom"]>;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CLAUDE_PROVIDER,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: CLAUDE_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: CLAUDE_PROVIDER,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

const getNativeThreadId = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
) {
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  if (nativeThreadId === undefined || nativeThreadId === null) {
    return yield* new ProviderAdapterProtocolError({
      driver: CLAUDE_PROVIDER,
      detail: `Provider thread ${providerThread.id} is missing a native Claude session id.`,
    });
  }
  return nativeThreadId;
});

const isSyntheticClaudeTurnId = (nativeTurnId: string): boolean => nativeTurnId.startsWith("turn:");

const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.status === "completed" ||
  turn.status === "interrupted" ||
  turn.status === "failed" ||
  turn.status === "cancelled";

const getNativeConversationHeadId = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
) {
  const nativeHeadRef = providerThread.nativeConversationHeadRef;
  if (nativeHeadRef === null) {
    return undefined;
  }
  if (nativeHeadRef.driver !== CLAUDE_PROVIDER) {
    return yield* new ProviderAdapterProtocolError({
      driver: CLAUDE_PROVIDER,
      detail: `Provider thread ${providerThread.id} has a non-Claude native conversation head reference.`,
    });
  }
  if (nativeHeadRef.nativeId === null) {
    return yield* new ProviderAdapterProtocolError({
      driver: CLAUDE_PROVIDER,
      detail: `Provider thread ${providerThread.id} has a Claude native conversation head reference without a native id.`,
    });
  }
  return nativeHeadRef.nativeId;
});

const resolveClaudeForkUpToMessageId = Effect.fn("ClaudeAdapterV2.resolveForkUpToMessageId")(
  function* (input: ProviderAdapterV2ForkThreadInput) {
    if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
      return undefined;
    }

    const sourceTurns = input.sourceProviderTurns
      .filter((turn) => turn.providerThreadId === input.sourceProviderThread.id)
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const boundaryIndex = sourceTurns.findIndex((turn) => turn.id === input.providerTurnId);
    if (boundaryIndex < 0) {
      return yield* new ProviderAdapterForkThreadError({
        driver: CLAUDE_PROVIDER,
        providerThreadId: input.sourceProviderThread.id,
        cause: `Cannot fork Claude thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
      });
    }

    const boundaryNativeId = sourceTurns[boundaryIndex]?.nativeTurnRef?.nativeId;
    if (
      boundaryNativeId !== undefined &&
      boundaryNativeId !== null &&
      !isSyntheticClaudeTurnId(boundaryNativeId)
    ) {
      return boundaryNativeId;
    }

    const terminalTurnsAfterBoundary = sourceTurns
      .slice(boundaryIndex + 1)
      .filter(isTerminalProviderTurn);
    if (terminalTurnsAfterBoundary.length === 0) {
      return undefined;
    }

    return yield* new ProviderAdapterForkThreadError({
      driver: CLAUDE_PROVIDER,
      providerThreadId: input.sourceProviderThread.id,
      cause: `Cannot fork Claude thread from prior provider turn ${input.providerTurnId}: no SDK assistant message cursor was recorded for that turn.`,
    });
  },
);

const resolveClaudeRollbackResumeSessionAt = Effect.fn(
  "ClaudeAdapterV2.resolveRollbackResumeSessionAt",
)(function* (input: ProviderAdapterV2RollbackThreadInput) {
  switch (input.target.type) {
    case "thread_start":
      return null;
    case "provider_turn": {
      const target = input.target;
      if (target.providerTurn.providerThreadId !== input.providerThread.id) {
        return yield* new ProviderAdapterRollbackThreadError({
          driver: CLAUDE_PROVIDER,
          providerThreadId: input.providerThread.id,
          cause: `Cannot roll back Claude thread ${input.providerThread.id} to provider turn ${target.providerTurn.id}: target turn belongs to provider thread ${target.providerTurn.providerThreadId}.`,
        });
      }

      const nativeTurnRef = target.providerTurn.nativeTurnRef;
      if (
        nativeTurnRef !== null &&
        nativeTurnRef.driver === CLAUDE_PROVIDER &&
        nativeTurnRef.nativeId !== null &&
        !isSyntheticClaudeTurnId(nativeTurnRef.nativeId)
      ) {
        return nativeTurnRef.nativeId;
      }

      const providerTurnsAfterTarget = input.providerThreadTurns.filter(
        (turn) => turn.ordinal > target.providerTurn.ordinal && isTerminalProviderTurn(turn),
      );
      if (providerTurnsAfterTarget.length === 0) {
        return null;
      }

      return yield* new ProviderAdapterRollbackThreadError({
        driver: CLAUDE_PROVIDER,
        providerThreadId: input.providerThread.id,
        cause: `Cannot roll back Claude thread ${input.providerThread.id} to provider turn ${target.providerTurn.id}: no SDK assistant message cursor was recorded for that turn.`,
      });
    }
  }
});

type ClaudeUserContent = SDKUserMessage["message"]["content"];
type ClaudeUserContentBlock = Exclude<ClaudeUserContent, string>[number];

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
type SupportedClaudeImageMimeType = (typeof SUPPORTED_CLAUDE_IMAGE_MIME_TYPES)[number];
const supportedClaudeImageMimeTypes = new Set<string>(SUPPORTED_CLAUDE_IMAGE_MIME_TYPES);

function isSupportedClaudeImageMimeType(
  mimeType: string,
): mimeType is SupportedClaudeImageMimeType {
  return supportedClaudeImageMimeTypes.has(mimeType);
}

export function makeClaudeUserMessage(input: {
  readonly text: string;
  readonly priority?: SDKUserMessage["priority"];
}): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: input.text,
    },
    parent_tool_use_id: null,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  };
}

const makeClaudeUserMessageWithAttachments = Effect.fnUntraced(function* (input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly priority?: SDKUserMessage["priority"];
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  if (input.attachments.length === 0) {
    return makeClaudeUserMessage({
      text: input.text,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
    });
  }

  const content: Array<ClaudeUserContentBlock> = [];
  if (input.text.length > 0) {
    content.push({ type: "text", text: input.text });
  }

  for (const attachment of input.attachments) {
    if (!isSupportedClaudeImageMimeType(attachment.mimeType)) {
      return yield* new ProviderAdapterProtocolError({
        driver: CLAUDE_PROVIDER,
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (attachmentPath === null) {
      return yield* new ProviderAdapterProtocolError({
        driver: CLAUDE_PROVIDER,
        detail: `Invalid attachment id '${attachment.id}'`,
      });
    }

    const bytes = yield* input.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProtocolError({
            driver: CLAUDE_PROVIDER,
            detail: `Failed to read attachment '${attachment.id}'`,
            payload: cause,
          }),
      ),
    );
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      },
    });
  }

  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  } satisfies SDKUserMessage;
});

type ClaudeAssistantContentBlock = SDKAssistantMessage["message"]["content"][number];
type ClaudeToolUseContentBlock = Extract<
  ClaudeAssistantContentBlock,
  {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }
>;
type ClaudeAssistantToolResultContentBlock = Extract<
  ClaudeAssistantContentBlock,
  {
    readonly tool_use_id: string;
  }
>;
type ClaudeUserToolResultContentBlock = Extract<
  ClaudeUserContentBlock,
  {
    readonly tool_use_id: string;
  }
>;
type ClaudeToolResultContentBlock =
  | ClaudeAssistantToolResultContentBlock
  | ClaudeUserToolResultContentBlock;
type ClaudeTypedToolResultContentBlock = Exclude<
  ClaudeToolResultContentBlock,
  { readonly type: "mcp_tool_result" | "tool_result" }
>;
type ClaudeTypedToolResultContent = ClaudeTypedToolResultContentBlock["content"];
type ClaudeToolResultOutput =
  | Extract<ClaudeToolResultContentBlock, { readonly type: "tool_result" }>["content"]
  | Extract<ClaudeToolResultContentBlock, { readonly type: "mcp_tool_result" }>["content"]
  | ClaudeTypedToolResultContent;

function assertNever(value: never): never {
  throw new Error(`Unhandled Claude SDK variant: ${jsonStringifyForTool(value)}`);
}

const ClaudeRuntimeSandboxPolicyKind = Schema.Struct({
  type: Schema.Literals(["dangerFullAccess", "externalSandbox", "readOnly", "workspaceWrite"]),
});
type ClaudeRuntimeSandboxPolicy = typeof ClaudeRuntimeSandboxPolicyKind.Type;
type ClaudeRuntimeSandboxPolicyKindName = ClaudeRuntimeSandboxPolicy["type"];

const ClaudeRuntimeReadOnlyFullAccessSandboxPolicy = Schema.Struct({
  type: Schema.Literal("readOnly"),
  access: Schema.Struct({
    type: Schema.Literal("fullAccess"),
  }),
});

function sandboxPolicyKindForClaudeRuntimePolicy(
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
): ClaudeRuntimeSandboxPolicyKindName | undefined {
  return runtimePolicy.sandboxPolicy !== undefined &&
    Schema.is(ClaudeRuntimeSandboxPolicyKind)(runtimePolicy.sandboxPolicy)
    ? runtimePolicy.sandboxPolicy.type
    : undefined;
}

function readOnlyPolicyAllowsGlobalReads(runtimePolicy: ProviderAdapterV2RuntimePolicy): boolean {
  return (
    runtimePolicy.sandboxPolicy !== undefined &&
    Schema.is(ClaudeRuntimeReadOnlyFullAccessSandboxPolicy)(runtimePolicy.sandboxPolicy)
  );
}

function permissionModeForClaudeRuntimePolicy(
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
): PermissionMode {
  if (runtimePolicy.interactionMode === "plan") {
    return "plan";
  }
  if (runtimePolicy.approvalPolicy !== undefined && runtimePolicy.approvalPolicy !== "never") {
    return "default";
  }

  switch (sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy)) {
    case "readOnly":
      return "dontAsk";
    case "dangerFullAccess":
      return "bypassPermissions";
    case "externalSandbox":
    case "workspaceWrite":
    case undefined:
      break;
  }

  switch (runtimePolicy.runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
  }
}

export interface ClaudeRuntimeQueryPolicy {
  readonly permissionMode: PermissionMode;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly allowDangerouslySkipPermissions?: true;
  readonly installPermissionCallback: boolean;
}

export function claudeRuntimeQueryPolicyForRuntimePolicy(
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
): ClaudeRuntimeQueryPolicy {
  const permissionMode = permissionModeForClaudeRuntimePolicy(runtimePolicy);
  const readOnlyTools =
    permissionMode === "dontAsk" &&
    sandboxPolicyKindForClaudeRuntimePolicy(runtimePolicy) === "readOnly"
      ? CLAUDE_READ_ONLY_ALLOWED_TOOLS
      : undefined;
  const allowedTools =
    readOnlyTools !== undefined && readOnlyPolicyAllowsGlobalReads(runtimePolicy)
      ? readOnlyTools
      : undefined;

  if (permissionMode === "plan") {
    return {
      permissionMode,
      ...(readOnlyTools === undefined ? {} : { tools: readOnlyTools }),
      ...(allowedTools === undefined ? {} : { allowedTools }),
      installPermissionCallback: false,
    };
  }

  const installPermissionCallback =
    runtimePolicy.approvalPolicy === undefined
      ? runtimePolicy.runtimeMode === "approval-required"
      : runtimePolicy.approvalPolicy !== "never";

  return {
    permissionMode,
    ...(readOnlyTools === undefined ? {} : { tools: readOnlyTools }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    installPermissionCallback,
  };
}

function shouldInstallClaudePermissionCallback(policy: ClaudeRuntimeQueryPolicy): boolean {
  if (policy.permissionMode === "plan") {
    return false;
  }
  return policy.installPermissionCallback;
}

function claudeRuntimeQueryPolicyKey(policy: ClaudeRuntimeQueryPolicy): string {
  return JSON.stringify({
    permissionMode: policy.permissionMode,
    tools: policy.tools,
    allowedTools: policy.allowedTools,
    allowDangerouslySkipPermissions: policy.allowDangerouslySkipPermissions,
    installPermissionCallback: policy.installPermissionCallback,
  });
}

// Live-query reuse must key on the effective allowlist (including the
// MCP-derived pre-approvals), not just the runtime policy: policies that
// share a policy key can still differ in MCP pre-approvals.
export function claudeEffectiveQueryPolicyKey(
  queryPolicy: ClaudeRuntimeQueryPolicy,
  mcpOverrides: { readonly allowedTools?: ReadonlyArray<string> },
): string {
  return claudeRuntimeQueryPolicyKey({
    ...queryPolicy,
    ...(mcpOverrides.allowedTools === undefined ? {} : { allowedTools: mcpOverrides.allowedTools }),
  });
}

type ClaudeToolItemType = Extract<
  OrchestrationV2TurnItem["type"],
  "command_execution" | "file_change" | "dynamic_tool" | "web_search"
>;

interface ClaudeToolClassification {
  readonly known: boolean;
  readonly normalizedName: string;
  readonly itemType: ClaudeToolItemType;
  readonly requestKind: ProviderRequestKind;
}

function normalizedClaudeToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[\s_-]/g, "");
}

const CLAUDE_KNOWN_TOOL_CLASSIFICATIONS: Record<
  string,
  {
    readonly itemType: ClaudeToolItemType;
    readonly requestKind: ProviderRequestKind;
  }
> = {
  agent: { itemType: "dynamic_tool", requestKind: "command" },
  bash: { itemType: "command_execution", requestKind: "command" },
  edit: { itemType: "file_change", requestKind: "file-change" },
  glob: { itemType: "dynamic_tool", requestKind: "file-read" },
  grep: { itemType: "dynamic_tool", requestKind: "file-read" },
  ls: { itemType: "dynamic_tool", requestKind: "file-read" },
  multiedit: { itemType: "file_change", requestKind: "file-change" },
  notebookedit: { itemType: "file_change", requestKind: "file-change" },
  read: { itemType: "dynamic_tool", requestKind: "file-read" },
  task: { itemType: "dynamic_tool", requestKind: "command" },
  todowrite: { itemType: "dynamic_tool", requestKind: "command" },
  toolsearch: { itemType: "dynamic_tool", requestKind: "command" },
  webfetch: { itemType: "web_search", requestKind: "command" },
  websearch: { itemType: "web_search", requestKind: "command" },
  write: { itemType: "file_change", requestKind: "file-change" },
};

export function classifyClaudeNativeTool(toolName: string): ClaudeToolClassification {
  const normalizedName = normalizedClaudeToolName(toolName);
  const known = CLAUDE_KNOWN_TOOL_CLASSIFICATIONS[normalizedName];
  return known === undefined
    ? {
        known: false,
        normalizedName,
        itemType: "dynamic_tool",
        requestKind: "command",
      }
    : {
        known: true,
        normalizedName,
        ...known,
      };
}

function providerRequestKindFromClaudeTool(toolName: string): ProviderRequestKind {
  return classifyClaudeNativeTool(toolName).requestKind;
}

function isClaudeWebSearchOutput(output: unknown): output is WebSearchOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    typeof Reflect.get(output, "query") === "string" &&
    Array.isArray(Reflect.get(output, "results")) &&
    typeof Reflect.get(output, "durationSeconds") === "number"
  );
}

const ClaudeNativeToolInputRecord = Schema.Record(Schema.String, Schema.Unknown);
type ClaudeNativeToolInputRecord = typeof ClaudeNativeToolInputRecord.Type;

type ClaudeNativeToolInput =
  | {
      readonly type: "record";
      readonly value: ClaudeNativeToolInputRecord;
    }
  | {
      readonly type: "non_record";
      readonly value: unknown;
    };

const EMPTY_CLAUDE_NATIVE_TOOL_INPUT = {
  type: "record",
  value: {},
} satisfies ClaudeNativeToolInput;

function claudeNativeToolInputFromUnknown(input: unknown): ClaudeNativeToolInput {
  return Schema.is(ClaudeNativeToolInputRecord)(input)
    ? { type: "record", value: input }
    : { type: "non_record", value: input };
}

function claudeNativeToolInputFromRecord(input: Record<string, unknown>): ClaudeNativeToolInput {
  return { type: "record", value: input };
}

function claudeNativeToolInputValue(input: ClaudeNativeToolInput): unknown {
  return input.value;
}

function inputRecordValue(input: ClaudeNativeToolInput, key: string): unknown {
  return input.type === "record" ? input.value[key] : undefined;
}

function firstStringInputField(
  input: ClaudeNativeToolInput,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = inputRecordValue(input, key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function jsonStringifyForTool(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function commandInputFromClaudeTool(toolName: string, input: ClaudeNativeToolInput): string {
  return (
    firstStringInputField(input, ["command", "cmd", "script"]) ??
    `${toolName}: ${jsonStringifyForTool(claudeNativeToolInputValue(input))}`
  );
}

function claudeTaskTypeFromSdkMessage(message: SDKMessage): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const taskType = Reflect.get(message, "task_type");
  return typeof taskType === "string" ? taskType : null;
}

function isClaudeNonSubagentTask(message: SDKMessage): boolean {
  return claudeTaskTypeFromSdkMessage(message) === "local_bash";
}

function fileNameFromClaudeTool(toolName: string, input: ClaudeNativeToolInput): string {
  return (
    firstStringInputField(input, ["file_path", "path", "filename", "fileName"]) ??
    `${toolName} result`
  );
}

type ClaudeNativeToolOutput =
  | {
      readonly type: "none";
    }
  | {
      readonly type: "content_block";
      readonly value: ClaudeToolResultOutput;
    }
  | {
      readonly type: "structured_tool_use_result";
      readonly value: unknown;
      readonly fallbackValue?: ClaudeToolResultOutput;
    };

const NO_CLAUDE_NATIVE_TOOL_OUTPUT = { type: "none" } satisfies ClaudeNativeToolOutput;

function claudeNativeToolOutputFromToolResult(
  toolResult: ClaudeToolResultContentBlock,
): ClaudeNativeToolOutput {
  const value = outputFromClaudeToolResult(toolResult);
  return value === undefined ? NO_CLAUDE_NATIVE_TOOL_OUTPUT : { type: "content_block", value };
}

function claudeNativeToolOutputFromStructuredResult(input: {
  readonly structuredOutput: unknown;
  readonly fallbackValue?: ClaudeToolResultOutput;
}): ClaudeNativeToolOutput {
  return {
    type: "structured_tool_use_result",
    value: input.structuredOutput,
    ...(input.fallbackValue === undefined ? {} : { fallbackValue: input.fallbackValue }),
  };
}

function claudeNativeToolOutputValue(output: ClaudeNativeToolOutput): unknown | undefined {
  switch (output.type) {
    case "none":
      return undefined;
    case "content_block":
    case "structured_tool_use_result":
      return output.value;
    default:
      return assertNever(output);
  }
}

function claudeNativeToolOutputText(output: ClaudeNativeToolOutput): string {
  const value = claudeNativeToolOutputValue(output);
  return typeof value === "string" ? value : value === undefined ? "" : jsonStringifyForTool(value);
}

function claudeSubagentResultText(output: ClaudeNativeToolOutput): string {
  const value = claudeNativeToolOutputValue(output);
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = value.content;
    if (Array.isArray(content)) {
      const text = content
        .flatMap((part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
            ? [part.text]
            : [],
        )
        .join("\n");
      if (text.length > 0) {
        return text;
      }
    }
  }
  return claudeNativeToolOutputText(output);
}

function isClaudeSubagentAsyncLaunchAck(output: ClaudeNativeToolOutput): boolean {
  const value = claudeNativeToolOutputValue(output);
  if (typeof value === "object" && value !== null) {
    if ("isAsync" in value && value.isAsync === true) {
      return true;
    }
    if ("status" in value && value.status === "async_launched") {
      return true;
    }
  }
  return claudeSubagentResultText(output).startsWith("Async agent launched successfully.");
}

function webSearchPatternsFromClaudeTool(input: {
  readonly toolInput: ClaudeNativeToolInput;
  readonly output: ClaudeNativeToolOutput;
}): ReadonlyArray<string> {
  const output = claudeNativeToolOutputValue(input.output);
  const pattern =
    firstStringInputField(input.toolInput, ["query", "url", "pattern"]) ??
    (isClaudeWebSearchOutput(output) ? output.query : undefined);
  return pattern === undefined || pattern.trim().length === 0 ? [] : [pattern];
}

function webSearchResultsFromClaudeOutput(
  output: ClaudeNativeToolOutput,
): ReadonlyArray<OrchestrationV2WebSearchResult> {
  const value = claudeNativeToolOutputValue(output);
  if (!isClaudeWebSearchOutput(value)) {
    return [];
  }

  return value.results.flatMap((result) => {
    if (typeof result === "string") {
      return [];
    }
    return result.content.map((content) => ({
      title: content.title,
      url: content.url,
    }));
  });
}

function summarizeClaudeToolRequest(toolName: string, input: ClaudeNativeToolInput): string {
  const command = firstStringInputField(input, ["command", "cmd", "script"]);
  if (command !== undefined) {
    return `${toolName}: ${command.slice(0, 400)}`;
  }
  const path = firstStringInputField(input, ["file_path", "path", "filename", "fileName"]);
  if (path !== undefined) {
    return `${toolName}: ${path.slice(0, 400)}`;
  }
  const serialized = jsonStringifyForTool(claudeNativeToolInputValue(input));
  return serialized.length <= 400
    ? `${toolName}: ${serialized}`
    : `${toolName}: ${serialized.slice(0, 397)}...`;
}

function outputFromClaudeToolResult(
  toolResult: ClaudeToolResultContentBlock,
): ClaudeToolResultOutput | undefined {
  switch (toolResult.type) {
    case "tool_result":
      return toolResult.content;
    case "mcp_tool_result":
      return toolResult.content;
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result":
    case "advisor_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "web_fetch_tool_result":
    case "web_search_tool_result":
      return toolResult.content;
    default:
      return assertNever(toolResult);
  }
}

function isClaudeTypedToolResultErrorContent(content: ClaudeTypedToolResultContent): boolean {
  if (Array.isArray(content)) {
    return false;
  }

  switch (content.type) {
    case "bash_code_execution_tool_result_error":
    case "code_execution_tool_result_error":
    case "text_editor_code_execution_tool_result_error":
    case "tool_search_tool_result_error":
    case "web_fetch_tool_result_error":
    case "web_search_tool_result_error":
      return true;
    default:
      return false;
  }
}

function isClaudeToolResultError(toolResult: ClaudeToolResultContentBlock): boolean {
  switch (toolResult.type) {
    case "tool_result":
      return toolResult.is_error === true;
    case "mcp_tool_result":
      return toolResult.is_error;
    case "bash_code_execution_tool_result":
    case "code_execution_tool_result":
    case "advisor_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "web_fetch_tool_result":
    case "web_search_tool_result":
      return isClaudeTypedToolResultErrorContent(toolResult.content);
    default:
      return assertNever(toolResult);
  }
}

function toolNameFromClaudeToolResult(toolResult: ClaudeToolResultContentBlock): string {
  switch (toolResult.type) {
    case "bash_code_execution_tool_result":
      return "bash_code_execution";
    case "code_execution_tool_result":
      return "code_execution";
    case "advisor_tool_result":
      return "advisor";
    case "mcp_tool_result":
      return "mcp_tool";
    case "text_editor_code_execution_tool_result":
      return "text_editor_code_execution";
    case "tool_result":
      return "tool";
    case "tool_search_tool_result":
      return "tool_search";
    case "web_fetch_tool_result":
      return "web_fetch";
    case "web_search_tool_result":
      return "web_search";
    default:
      return assertNever(toolResult);
  }
}

function isClaudeAssistantToolResultContentBlock(
  part: ClaudeAssistantContentBlock,
): part is ClaudeAssistantToolResultContentBlock {
  return "tool_use_id" in part && typeof part.tool_use_id === "string";
}

function isClaudeUserToolResultContentBlock(
  part: ClaudeUserContentBlock,
): part is ClaudeUserToolResultContentBlock {
  return "tool_use_id" in part && typeof part.tool_use_id === "string";
}

function isClaudeToolUseContentBlock(
  part: ClaudeAssistantContentBlock,
): part is ClaudeToolUseContentBlock {
  return (
    "id" in part &&
    typeof part.id === "string" &&
    "name" in part &&
    typeof part.name === "string" &&
    "input" in part
  );
}

function claudeToolUseBlocksFromAssistantMessage(
  message: SDKMessage,
): ReadonlyArray<ClaudeToolUseContentBlock> {
  if (message.type !== "assistant") {
    return [];
  }
  return message.message.content.filter(isClaudeToolUseContentBlock);
}

function claudeToolResultBlocksFromAssistantMessage(
  message: SDKMessage,
): ReadonlyArray<ClaudeToolResultContentBlock> {
  if (message.type !== "assistant") {
    return [];
  }
  return message.message.content.filter(isClaudeAssistantToolResultContentBlock);
}

function claudeToolResultBlocksFromUserMessage(
  message: SDKMessage,
): ReadonlyArray<ClaudeToolResultContentBlock> {
  if (message.type !== "user" || typeof message.message.content === "string") {
    return [];
  }
  return message.message.content.filter(isClaudeUserToolResultContentBlock);
}

function claudeToolResultEntriesFromMessage(message: SDKMessage): ReadonlyArray<{
  readonly toolResult: ClaudeToolResultContentBlock;
  readonly output: ClaudeNativeToolOutput;
}> {
  const assistantResults = claudeToolResultBlocksFromAssistantMessage(message).map(
    (toolResult) => ({ toolResult, output: claudeNativeToolOutputFromToolResult(toolResult) }),
  );
  const userResults = claudeToolResultBlocksFromUserMessage(message);
  const structuredOutput =
    message.type === "user" && userResults.length === 1 ? message.tool_use_result : undefined;
  return [
    ...assistantResults,
    ...userResults.map((toolResult) => ({
      toolResult,
      output:
        structuredOutput === undefined
          ? claudeNativeToolOutputFromToolResult(toolResult)
          : claudeNativeToolOutputFromStructuredResult({
              structuredOutput,
              fallbackValue: outputFromClaudeToolResult(toolResult),
            }),
    })),
  ];
}

function parentToolUseIdFromSdkMessage(message: SDKMessage): string | null {
  return message.type === "assistant" || message.type === "user"
    ? message.parent_tool_use_id
    : null;
}

function permissionResultFromDecision(input: {
  readonly decision: ProviderApprovalDecision;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseID: string;
  readonly suggestions?: Parameters<CanUseTool>[2]["suggestions"];
}): PermissionResult {
  if (input.decision === "accept" || input.decision === "acceptForSession") {
    return {
      behavior: "allow",
      updatedInput: input.toolInput,
      toolUseID: input.toolUseID,
      decisionClassification:
        input.decision === "acceptForSession" ? "user_permanent" : "user_temporary",
      ...(input.decision === "acceptForSession" && input.suggestions !== undefined
        ? { updatedPermissions: input.suggestions }
        : {}),
    };
  }

  return {
    behavior: "deny",
    message:
      input.decision === "cancel"
        ? "User cancelled tool execution."
        : "User declined tool execution.",
    toolUseID: input.toolUseID,
    decisionClassification: "user_reject",
    ...(input.decision === "cancel" ? { interrupt: true } : {}),
  };
}

function terminalStatusFromResult(
  message: SDKResultMessage,
): Extract<
  OrchestrationV2ProviderTurn["status"],
  "completed" | "interrupted" | "failed" | "cancelled"
> {
  if (message.subtype === "success") {
    // The SDK reports API-level failures (401 auth, 529 overloaded, …) as
    // subtype "success" with is_error set; the turn produced no real work.
    return message.is_error ? "failed" : "completed";
  }
  const errorText = message.errors.join("\n").toLowerCase();
  if (errorText.includes("interrupt")) {
    return "interrupted";
  }
  if (errorText.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function isClaudeActiveSteeringAbortResult(message: SDKResultMessage): boolean {
  return message.terminal_reason === "aborted_streaming";
}

function providerFailureFromResult(
  message: SDKResultMessage,
): OrchestrationV2ProviderFailure | null {
  if (message.subtype !== "success") {
    return makeProviderFailure({
      message: message.errors.join("\n"),
      code: message.subtype,
      class: "provider_error",
    });
  }
  if (!message.is_error) {
    return null;
  }
  const apiErrorStatus = message.api_error_status ?? null;
  return makeProviderFailure({
    message: message.result,
    code: apiErrorStatus === null ? "sdk_result_error" : `api_error_${apiErrorStatus}`,
    class: "provider_error",
    retryable: apiErrorStatus === 429 || apiErrorStatus === 529 ? true : null,
  });
}

function buildAssistantArtifacts(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly turnInput: ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeItemId: string;
  readonly text: string;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
}): {
  readonly node: OrchestrationV2ExecutionNode;
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const nodeId = input.idAllocator.derive.nodeFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const messageId = input.idAllocator.derive.messageFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const turnItemId = input.idAllocator.derive.turnItemFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const nativeItemRef = {
    driver: CLAUDE_PROVIDER,
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
      createdBy: "agent",
      creationSource: "provider",
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
      ordinal: input.ordinal,
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

interface ActiveClaudeTurnContext {
  readonly input: ProviderAdapterV2TurnInput;
  readonly nativeTurnId: string;
  nativeMessageCursor: string | null;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly providerTurnOrdinal: number;
  readonly startedAt: DateTime.Utc;
  readonly assistant: {
    fallbackText: string;
    fallbackNativeItemId: string;
    emittedNativeItemIds: Set<string>;
  };
  readonly toolCalls: Map<string, ActiveClaudeToolCall>;
  readonly ignoredTaskIds: Set<string>;
  readonly subagentsByTaskId: Map<string, ActiveClaudeSubagent>;
  readonly subagentsByToolUseId: Map<string, ActiveClaudeSubagent>;
  readonly subagentNodesByTaskId: Map<string, OrchestrationV2ExecutionNode["id"]>;
}

interface ActiveClaudeSubagent {
  task: OrchestrationV2Subagent;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  nextChildItemOrdinal: number;
  progressItemOrdinal: number | null;
  progressStartedAt: DateTime.Utc | null;
  resultItemOrdinal: number | null;
}

interface ClaudeLiveQueryContext {
  readonly nativeThreadId: string;
  readonly query: ClaudeAgentSdkQuerySession;
  readonly queryPolicyKey: string;
  readonly selectionKey: string;
  readonly closed: Deferred.Deferred<void, never>;
}

interface ActiveClaudeToolCall {
  readonly nativeItemId: string;
  readonly toolName: string;
  readonly classification: ClaudeToolClassification;
  readonly input: ClaudeNativeToolInput;
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
}

interface PendingClaudeRuntimeRequest {
  readonly requestId: OrchestrationV2RuntimeRequest["id"];
  readonly requestKind: ProviderRequestKind;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
}

export interface ClaudeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly queryRunner: ClaudeAgentSdkQueryRunnerShape;
  /** Sink for wake-turn continuation requests; defaults to dropping them. */
  readonly continuationRequests?: {
    readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  };
}

export function makeClaudeAdapterV2(
  adapterOptions: ClaudeAdapterV2Options,
): ProviderAdapterV2Shape {
  const { attachmentsDir, fileSystem, idAllocator, queryRunner } = adapterOptions;
  const continuationRequests = adapterOptions.continuationRequests ?? {
    offer: () => Effect.void,
  };

  return ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CLAUDE_PROVIDER,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("ClaudeAdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const now = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          providerInstanceId: adapterOptions.instanceId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const activeTurn = yield* Ref.make<ActiveClaudeTurnContext | null>(null);
        const interruptedTurns = yield* Ref.make(new Set<OrchestrationV2ProviderTurn["id"]>());
        const steeredTurns = yield* Ref.make(new Set<OrchestrationV2ProviderTurn["id"]>());
        const queryContext = yield* Ref.make<ClaudeLiveQueryContext | null>(null);
        const openedNativeThreads = yield* Ref.make(new Set<string>());
        const itemOrdinals = yield* Ref.make(new Map<string, number>());
        const nextItemOrdinalsByTurn = yield* Ref.make(new Map<string, number>());
        const pendingRuntimeRequests = yield* Ref.make(
          new Map<string, PendingClaudeRuntimeRequest>(),
        );
        // Background-task wake support. Claude can settle a turn while a
        // local_bash background task keeps running; the CLI later re-invokes
        // the model (a "wake turn") on the same query stream with no active
        // provider turn. These refs track pending background tasks, buffer
        // wake messages until a continuation run attaches, and remember where
        // to dispatch that run.
        const lastTurnRouteByNativeThread = yield* Ref.make(
          new Map<
            string,
            { readonly threadId: ThreadId; readonly providerThreadId: ProviderThreadId }
          >(),
        );
        const pendingBackgroundTaskIds = yield* Ref.make(new Set<string>());
        // Subagent registry that survives turn settle: a background subagent
        // (Agent with run_in_background) can complete after the root turn
        // ended, and its task_notification must both count as wake evidence
        // and hydrate the original subagent node instead of being dropped.
        const sessionSubagentsByTaskId = yield* Ref.make(new Map<string, ActiveClaudeSubagent>());
        const wakeBuffers = yield* Ref.make(
          new Map<
            string,
            { readonly messages: ReadonlyArray<SDKMessage>; readonly detail: string | null }
          >(),
        );
        const requestedContinuations = yield* Ref.make(new Set<string>());
        const runtimeContext = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(runtimeContext);
        const runPromise = Effect.runPromiseWith(runtimeContext);

        const emitProviderEvent = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const resolveItemOrdinal = Effect.fnUntraced(function* (
          context: ActiveClaudeTurnContext,
          nativeItemId: string,
        ) {
          const existing = (yield* Ref.get(itemOrdinals)).get(nativeItemId);
          if (existing !== undefined) {
            return existing;
          }

          const nextWithinTurn = yield* Ref.modify(nextItemOrdinalsByTurn, (current) => {
            const next = (current.get(context.nativeTurnId) ?? 0) + 1;
            const updated = new Map(current);
            updated.set(context.nativeTurnId, next);
            return [next, updated];
          });
          const nextOrdinal = context.input.providerTurnOrdinal * 100 + nextWithinTurn;
          yield* Ref.update(itemOrdinals, (current) => {
            const updated = new Map(current);
            updated.set(nativeItemId, nextOrdinal);
            return updated;
          });
          return nextOrdinal;
        });

        const providerTurnPayload = (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly status: OrchestrationV2ProviderTurn["status"];
          readonly completedAt: DateTime.Utc | null;
        }): OrchestrationV2ProviderTurn => ({
          id: input.context.providerTurnId,
          providerThreadId: input.context.input.providerThread.id,
          nodeId: input.context.input.rootNodeId,
          runAttemptId: input.context.input.attemptId,
          nativeTurnRef: {
            driver: CLAUDE_PROVIDER,
            nativeId: input.context.nativeMessageCursor ?? input.context.nativeTurnId,
            strength: "weak",
          },
          ordinal: input.context.providerTurnOrdinal,
          status: input.status,
          startedAt: input.context.startedAt,
          completedAt: input.completedAt,
        });

        const buildToolCallArtifacts = (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly nativeItemId: string;
          readonly toolName: string;
          readonly classification: ClaudeToolClassification;
          readonly toolInput: ClaudeNativeToolInput;
          readonly threadId: ThreadId;
          readonly runId: ProviderAdapterV2TurnInput["runId"] | null;
          readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
          readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
          readonly ordinal: number;
          readonly output: ClaudeNativeToolOutput;
          readonly status: Extract<
            OrchestrationV2TurnItem["status"],
            "running" | "completed" | "failed"
          >;
          readonly startedAt: DateTime.Utc;
          readonly updatedAt: DateTime.Utc;
        }) => {
          const completedAt = input.status === "running" ? null : input.updatedAt;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CLAUDE_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            driver: CLAUDE_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
          const nativeItemRef = {
            driver: CLAUDE_PROVIDER,
            nativeId: input.nativeItemId,
            strength: "strong" as const,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.parentNodeId,
            rootNodeId: input.rootNodeId,
            kind: "tool_call",
            status: input.status,
            countsForRun: false,
            providerThreadId: input.runId === null ? null : input.context.input.providerThread.id,
            providerTurnId: input.runId === null ? null : input.context.providerTurnId,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: input.startedAt,
            completedAt,
          };
          const itemBase = {
            id: turnItemId,
            threadId: input.threadId,
            runId: input.runId,
            nodeId,
            providerThreadId: input.runId === null ? null : input.context.input.providerThread.id,
            providerTurnId: input.runId === null ? null : input.context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal: input.ordinal,
            status: input.status,
            title: null,
            startedAt: input.startedAt,
            completedAt,
            updatedAt: input.updatedAt,
          } satisfies Pick<
            OrchestrationV2TurnItem,
            | "id"
            | "threadId"
            | "runId"
            | "nodeId"
            | "providerThreadId"
            | "providerTurnId"
            | "nativeItemRef"
            | "parentItemId"
            | "ordinal"
            | "status"
            | "title"
            | "startedAt"
            | "completedAt"
            | "updatedAt"
          >;
          const itemType = input.classification.itemType;
          const webSearchPatterns = webSearchPatternsFromClaudeTool({
            toolInput: input.toolInput,
            output: input.output,
          });
          const webSearchResults = webSearchResultsFromClaudeOutput(input.output);
          const outputValue = claudeNativeToolOutputValue(input.output);
          const outputText = claudeNativeToolOutputText(input.output);
          const turnItem: OrchestrationV2TurnItem =
            itemType === "command_execution"
              ? {
                  ...itemBase,
                  type: "command_execution",
                  input: commandInputFromClaudeTool(input.toolName, input.toolInput),
                  ...(outputText.length === 0 ? {} : { output: outputText }),
                }
              : itemType === "file_change"
                ? {
                    ...itemBase,
                    type: "file_change",
                    fileName: fileNameFromClaudeTool(input.toolName, input.toolInput),
                    ...(outputText.length === 0 ? {} : { diffStr: outputText }),
                  }
                : itemType === "web_search"
                  ? {
                      ...itemBase,
                      type: "web_search",
                      ...(webSearchPatterns.length === 0
                        ? {}
                        : { patterns: [...webSearchPatterns] }),
                      ...(webSearchResults.length === 0 ? {} : { results: [...webSearchResults] }),
                    }
                  : {
                      ...itemBase,
                      type: "dynamic_tool",
                      toolName: input.toolName,
                      input: claudeNativeToolInputValue(input.toolInput),
                      ...(outputValue === undefined ? {} : { output: outputValue }),
                    };
          return { node, turnItem };
        };

        const emitToolCallArtifacts = Effect.fnUntraced(function* (artifacts: {
          readonly node: OrchestrationV2ExecutionNode;
          readonly turnItem: OrchestrationV2TurnItem;
        }) {
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CLAUDE_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CLAUDE_PROVIDER,
            turnItem: artifacts.turnItem,
          });
        });

        const updateClaudeSubagentNode = Effect.fnUntraced(function* (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly taskId: string;
          readonly toolUseId?: string;
          readonly prompt?: string;
          readonly title?: string;
          readonly progress?: string;
          readonly result?: string;
          readonly status: Extract<
            OrchestrationV2ExecutionNode["status"],
            "running" | "completed" | "failed" | "cancelled"
          >;
          readonly reopen?: boolean;
        }) {
          // The session registry lets a wake-replay turn (fresh context maps)
          // hydrate a subagent that was created by an earlier, settled turn.
          const existingSubagent =
            input.context.subagentsByTaskId.get(input.taskId) ??
            (input.toolUseId === undefined
              ? undefined
              : input.context.subagentsByToolUseId.get(input.toolUseId)) ??
            (yield* Ref.get(sessionSubagentsByTaskId)).get(input.taskId);
          if (existingSubagent === undefined && input.status !== "running") {
            return;
          }
          // Status is monotone with one exception: task_started for a known
          // task id is an authoritative CLI lifecycle event (SendMessage to a
          // completed subagent resumes it and re-emits task_started with the
          // same id), so it may re-open a terminal entry. A late or
          // out-of-order task_progress must not.
          const isReopen =
            input.reopen === true &&
            existingSubagent !== undefined &&
            existingSubagent.task.status !== "running" &&
            input.status === "running";
          if (
            existingSubagent !== undefined &&
            existingSubagent.task.status !== "running" &&
            input.status === "running" &&
            !isReopen
          ) {
            return;
          }
          const lifecycleChanged =
            existingSubagent === undefined ||
            existingSubagent.task.status !== input.status ||
            // A drain-replayed resume task_started finds the registry entry
            // already pre-opened to running by bufferWakeMessage while the
            // projection node still holds the old terminal status; re-emit
            // the node lifecycle for authoritative task_started updates.
            (input.reopen === true && input.status === "running");

          const now = yield* DateTime.now;
          const nativeItemId = `task:${input.taskId}`;
          const nodeId =
            existingSubagent?.task.id ??
            idAllocator.derive.nodeFromProviderItem({
              driver: CLAUDE_PROVIDER,
              nativeItemId,
            });
          const childRootNodeId =
            existingSubagent?.childRootNodeId ??
            idAllocator.derive.nodeFromProviderItem({
              driver: CLAUDE_PROVIDER,
              nativeItemId: `${nativeItemId}:thread-root`,
            });
          const childThreadId =
            existingSubagent?.childThreadId ??
            idAllocator.derive.threadFromProviderThread({
              driver: CLAUDE_PROVIDER,
              nativeThreadId: `${input.context.input.providerThread.id}:${input.taskId}`,
            });
          if (existingSubagent === undefined) {
            input.context.subagentNodesByTaskId.set(input.taskId, nodeId);
          }
          const turnItemOrdinal =
            existingSubagent?.turnItemOrdinal ??
            (yield* resolveItemOrdinal(input.context, `${nativeItemId}:subagent`));
          // A resumed subagent's previous final answer and progress no longer
          // represent its outcome; the next task_progress/task_notification
          // carry the new ones.
          const priorTask =
            existingSubagent === undefined
              ? undefined
              : isReopen
                ? (({ progress: _staleProgress, ...rest }) => ({ ...rest, result: null }))(
                    existingSubagent.task,
                  )
                : existingSubagent.task;
          const task = {
            ...(priorTask ?? {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              origin: "provider_native" as const,
              createdBy: "agent" as const,
              driver: CLAUDE_PROVIDER,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId,
              nativeTaskRef: {
                driver: CLAUDE_PROVIDER,
                nativeId: input.taskId,
                strength: "strong" as const,
              },
              prompt: input.prompt ?? "",
              title: input.title ?? null,
              model: input.context.input.modelSelection.model,
              result: null,
              startedAt: now,
            }),
            status: input.status,
            // A reopen replayed under a continuation run re-attributes the
            // subagent to that run. RunExecutionService routes parent-thread
            // events by runId, and only the resuming run's ingestion fiber is
            // guaranteed alive (the launch run's fiber stops once its child
            // subagents terminalize); attribution also enrolls the subagent
            // in the resuming run's active-child tracking so its fiber
            // outlives settle until the resumed task completes.
            ...(input.reopen === true &&
            input.status === "running" &&
            existingSubagent !== undefined
              ? { runId: input.context.input.runId }
              : {}),
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.progress === undefined ? {} : { progress: input.progress }),
            ...(input.result === undefined ? {} : { result: input.result }),
            completedAt: input.status === "running" ? null : now,
            updatedAt: now,
          } satisfies OrchestrationV2Subagent;
          const subagent = {
            task,
            childThreadId,
            childRootNodeId,
            turnItemId:
              existingSubagent?.turnItemId ??
              idAllocator.derive.turnItemFromProviderItem({
                driver: CLAUDE_PROVIDER,
                nativeItemId: `${nativeItemId}:subagent`,
              }),
            turnItemOrdinal,
            nextChildItemOrdinal: existingSubagent?.nextChildItemOrdinal ?? 100,
            progressItemOrdinal: existingSubagent?.progressItemOrdinal ?? null,
            progressStartedAt: existingSubagent?.progressStartedAt ?? null,
            resultItemOrdinal: existingSubagent?.resultItemOrdinal ?? null,
          } satisfies ActiveClaudeSubagent;
          input.context.subagentsByTaskId.set(input.taskId, subagent);
          if (input.toolUseId !== undefined) {
            input.context.subagentsByToolUseId.set(input.toolUseId, subagent);
          }
          // The same terminal protection, applied atomically: a concurrent
          // fiber (live stream vs continuation drain) may have terminalized
          // the registry entry after this update's lookup read it. A resume
          // re-open (task_started) bypasses it only when the registered entry
          // is still the terminal generation the lookup resolved; if a
          // concurrent fiber installed a newer terminal entry meanwhile, the
          // re-open must not clobber its result.
          yield* Ref.update(sessionSubagentsByTaskId, (current) => {
            const registered = current.get(input.taskId);
            if (
              registered !== undefined &&
              registered.task.status !== "running" &&
              input.status === "running" &&
              !(isReopen && registered === existingSubagent)
            ) {
              return current;
            }
            return new Map(current).set(input.taskId, subagent);
          });

          if (existingSubagent === undefined) {
            const childThread = makeSubagentChildThread({
              parentThread: input.context.input.appThread,
              childThreadId,
              parentNodeId: nodeId,
              activeProviderThreadId: null,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              modelSelection: input.context.input.modelSelection,
              title: subagentThreadTitle({
                parentTitle: input.context.input.appThread.title,
                prompt: task.prompt,
                title: task.title,
                ordinal: input.context.subagentsByTaskId.size,
              }),
              now,
              createdBy: "agent",
              creationSource: "provider",
            });
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver: CLAUDE_PROVIDER,
              appThread: childThread,
            });
          }

          if (lifecycleChanged) {
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CLAUDE_PROVIDER,
              node: {
                id: nodeId,
                // Parenting stays with the launch run's root node even on
                // wake-replay; runId follows task.runId, which a reopen
                // re-attributes to the resuming run (see task construction).
                threadId: task.threadId,
                runId: task.runId,
                parentNodeId: task.parentNodeId,
                rootNodeId: task.parentNodeId,
                kind: "subagent",
                status: input.status,
                countsForRun: false,
                providerThreadId: input.context.input.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: {
                  driver: CLAUDE_PROVIDER,
                  nativeId: input.taskId,
                  strength: "strong",
                },
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: task.startedAt,
                completedAt: input.status === "running" ? null : now,
              },
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CLAUDE_PROVIDER,
              node: {
                id: childRootNodeId,
                threadId: childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: childRootNodeId,
                kind: "root_turn",
                status: input.status,
                countsForRun: false,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: task.nativeTaskRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: task.startedAt,
                completedAt: input.status === "running" ? null : now,
              },
            });
          }
          if (existingSubagent === undefined) {
            const promptNativeItemId = `${nativeItemId}:prompt`;
            const promptArtifacts = makeSubagentConversationArtifacts({
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: CLAUDE_PROVIDER,
                nativeItemId: promptNativeItemId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CLAUDE_PROVIDER,
                nativeItemId: promptNativeItemId,
              }),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: {
                driver: CLAUDE_PROVIDER,
                nativeId: promptNativeItemId,
                strength: "strong",
              },
              role: "user",
              text: task.prompt,
              ordinal: 100,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver: CLAUDE_PROVIDER,
              message: promptArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CLAUDE_PROVIDER,
              turnItem: promptArtifacts.turnItem,
            });
          }
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: CLAUDE_PROVIDER,
            subagent: task,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CLAUDE_PROVIDER,
            turnItem: {
              id: subagent.turnItemId,
              threadId: task.threadId,
              runId: task.runId,
              nodeId: task.id,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              parentItemId: null,
              ordinal: subagent.turnItemOrdinal,
              status: task.status,
              title: task.title,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
              updatedAt: task.updatedAt,
              type: "subagent",
              subagentId: task.id,
              origin: task.origin,
              driver: task.driver,
              providerInstanceId: task.providerInstanceId,
              childThreadId: task.childThreadId,
              prompt: task.prompt,
              ...(task.progress === undefined ? {} : { progress: task.progress }),
              result: task.result,
            },
          });

          const progress = task.progress?.trim();
          if (
            progress !== undefined &&
            progress.length > 0 &&
            (input.progress !== undefined || (lifecycleChanged && input.status !== "running"))
          ) {
            const progressNativeItemId = `${nativeItemId}:progress`;
            const progressItemOrdinal =
              subagent.progressItemOrdinal ?? ++subagent.nextChildItemOrdinal;
            const progressStartedAt = subagent.progressStartedAt ?? now;
            subagent.progressItemOrdinal = progressItemOrdinal;
            subagent.progressStartedAt = progressStartedAt;
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CLAUDE_PROVIDER,
              turnItem: {
                id: idAllocator.derive.turnItemFromProviderItem({
                  driver: CLAUDE_PROVIDER,
                  nativeItemId: progressNativeItemId,
                }),
                threadId: childThreadId,
                runId: null,
                nodeId: childRootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: {
                  driver: CLAUDE_PROVIDER,
                  nativeId: progressNativeItemId,
                  strength: "strong",
                },
                parentItemId: null,
                ordinal: progressItemOrdinal,
                status: input.status,
                title: "Subagent progress",
                startedAt: progressStartedAt,
                completedAt: input.status === "running" ? null : now,
                updatedAt: now,
                type: "reasoning",
                text: progress,
                streaming: input.status === "running",
              },
            });
          }

          if (
            input.result !== undefined &&
            input.result.trim().length > 0 &&
            input.status !== "running"
          ) {
            const resultNativeItemId = `${nativeItemId}:result`;
            const resultItemOrdinal = subagent.resultItemOrdinal ?? ++subagent.nextChildItemOrdinal;
            subagent.resultItemOrdinal = resultItemOrdinal;
            const resultArtifacts = makeSubagentConversationArtifacts({
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: CLAUDE_PROVIDER,
                nativeItemId: resultNativeItemId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CLAUDE_PROVIDER,
                nativeItemId: resultNativeItemId,
              }),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: {
                driver: CLAUDE_PROVIDER,
                nativeId: resultNativeItemId,
                strength: "strong",
              },
              role: "assistant",
              text: input.result,
              ordinal: resultItemOrdinal,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver: CLAUDE_PROVIDER,
              message: resultArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CLAUDE_PROVIDER,
              turnItem: resultArtifacts.turnItem,
            });
          }
        });

        const ensureToolCallStarted = Effect.fnUntraced(function* (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly nativeItemId: string;
          readonly toolName: string;
          readonly toolInput: ClaudeNativeToolInput;
          readonly parentToolUseId: string | null;
        }) {
          const existing = input.context.toolCalls.get(input.nativeItemId);
          if (existing !== undefined) {
            return existing;
          }
          const startedAt = yield* DateTime.now;
          const classification = classifyClaudeNativeTool(input.toolName);
          const subagent =
            input.parentToolUseId === null
              ? undefined
              : input.context.subagentsByToolUseId.get(input.parentToolUseId);
          const threadId = subagent?.childThreadId ?? input.context.input.threadId;
          const runId = subagent === undefined ? input.context.input.runId : null;
          const rootNodeId = subagent?.childRootNodeId ?? input.context.input.rootNodeId;
          const parentNodeId = rootNodeId;
          const ordinal =
            subagent === undefined
              ? yield* resolveItemOrdinal(input.context, input.nativeItemId)
              : ++subagent.nextChildItemOrdinal;
          const toolCall: ActiveClaudeToolCall = {
            nativeItemId: input.nativeItemId,
            toolName: input.toolName,
            classification,
            input: input.toolInput,
            threadId,
            runId,
            rootNodeId,
            parentNodeId,
            ordinal,
            startedAt,
          };
          input.context.toolCalls.set(input.nativeItemId, toolCall);
          yield* emitToolCallArtifacts(
            buildToolCallArtifacts({
              context: input.context,
              nativeItemId: input.nativeItemId,
              toolName: input.toolName,
              classification,
              toolInput: input.toolInput,
              threadId,
              runId,
              rootNodeId,
              parentNodeId,
              ordinal,
              output: NO_CLAUDE_NATIVE_TOOL_OUTPUT,
              status: "running",
              startedAt,
              updatedAt: startedAt,
            }),
          );
          return toolCall;
        });

        const buildApprovalRequestArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly nativeItemId: string;
          readonly nativeRequestId: string;
          readonly requestKind: ProviderRequestKind;
          readonly prompt?: string;
        }) {
          const createdAt = yield* DateTime.now;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver: CLAUDE_PROVIDER,
            providerTurnId: input.context.providerTurnId,
            nativeRequestId: input.nativeRequestId,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const providerSessionId = input.context.input.providerThread.providerSessionId;
          if (providerSessionId === null) {
            return yield* new ProviderAdapterProtocolError({
              driver: CLAUDE_PROVIDER,
              detail: `Provider thread ${input.context.input.providerThread.id} is missing a provider session id.`,
            });
          }
          const ordinal = yield* resolveItemOrdinal(
            input.context,
            `${input.nativeItemId}:approval:${input.nativeRequestId}`,
          );
          const nativeItemRef = {
            driver: CLAUDE_PROVIDER,
            nativeId: input.nativeRequestId,
            strength: "strong" as const,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            parentNodeId: idAllocator.derive.nodeFromProviderItem({
              driver: CLAUDE_PROVIDER,
              nativeItemId: input.nativeItemId,
            }),
            rootNodeId: input.context.input.rootNodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            nativeItemRef,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: createdAt,
            completedAt: null,
          };
          const request: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: input.context.providerTurnId,
            nativeRequestRef: {
              driver: CLAUDE_PROVIDER,
              nativeId: input.nativeRequestId,
              strength: "strong",
            },
            kind: input.requestKind,
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId,
            },
            createdAt,
            resolvedAt: null,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: idAllocator.derive.approvalTurnItem({ requestId }),
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            nodeId,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: "waiting",
            title: null,
            startedAt: createdAt,
            completedAt: null,
            updatedAt: createdAt,
            type: "approval_request",
            requestId,
            requestKind: input.requestKind,
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          };
          return { node, request, turnItem };
        });

        const finalizeActiveTurn = Effect.fnUntraced(function* (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly status: Extract<
            OrchestrationV2ProviderTurn["status"],
            "completed" | "interrupted" | "failed" | "cancelled"
          >;
          readonly completedAt: DateTime.Utc;
          readonly failure?: OrchestrationV2ProviderFailure;
          readonly threadDisposition?: "reusable" | "broken";
        }) {
          for (const toolCall of input.context.toolCalls.values()) {
            const artifacts = buildToolCallArtifacts({
              context: input.context,
              nativeItemId: toolCall.nativeItemId,
              toolName: toolCall.toolName,
              classification: toolCall.classification,
              toolInput: toolCall.input,
              threadId: toolCall.threadId,
              runId: toolCall.runId,
              rootNodeId: toolCall.rootNodeId,
              parentNodeId: toolCall.parentNodeId,
              ordinal: toolCall.ordinal,
              output: NO_CLAUDE_NATIVE_TOOL_OUTPUT,
              status: "failed",
              startedAt: toolCall.startedAt,
              updatedAt: input.completedAt,
            });
            yield* emitToolCallArtifacts(artifacts);
          }
          input.context.toolCalls.clear();

          if (
            input.context.assistant.emittedNativeItemIds.size === 0 &&
            input.context.assistant.fallbackText.length > 0
          ) {
            const ordinal = yield* resolveItemOrdinal(
              input.context,
              input.context.assistant.fallbackNativeItemId,
            );
            const artifacts = buildAssistantArtifacts({
              idAllocator,
              turnInput: input.context.input,
              providerTurnId: input.context.providerTurnId,
              nativeItemId: input.context.assistant.fallbackNativeItemId,
              text: input.context.assistant.fallbackText,
              ordinal,
              startedAt: input.context.startedAt,
              completedAt: input.completedAt,
            });
            yield* Effect.all(
              [
                emitProviderEvent({
                  type: "node.updated",
                  driver: CLAUDE_PROVIDER,
                  node: artifacts.node,
                }),
                emitProviderEvent({
                  type: "message.updated",
                  driver: CLAUDE_PROVIDER,
                  message: artifacts.message,
                }),
                emitProviderEvent({
                  type: "turn_item.updated",
                  driver: CLAUDE_PROVIDER,
                  turnItem: artifacts.turnItem,
                }),
              ],
              { concurrency: 1 },
            );
          }

          const threadDisposition = input.threadDisposition ?? "reusable";
          const terminalEvent: ProviderAdapterV2Event =
            input.status === "failed"
              ? {
                  type: "turn.terminal",
                  driver: CLAUDE_PROVIDER,
                  providerThreadId: input.context.input.providerThread.id,
                  providerTurnId: input.context.providerTurnId,
                  runOrdinal: input.context.input.runOrdinal,
                  failureItemOrdinal: yield* resolveItemOrdinal(
                    input.context,
                    `terminal-failure:${input.context.providerTurnId}`,
                  ),
                  status: input.status,
                  failure: input.failure ?? makeProviderFailure({ class: "provider_error" }),
                  threadDisposition,
                }
              : {
                  type: "turn.terminal",
                  driver: CLAUDE_PROVIDER,
                  providerThreadId: input.context.input.providerThread.id,
                  providerTurnId: input.context.providerTurnId,
                  runOrdinal: input.context.input.runOrdinal,
                  status: input.status,
                  failure: null,
                  threadDisposition,
                };
          yield* Effect.all(
            [
              emitProviderEvent({
                type: "provider_turn.updated",
                driver: CLAUDE_PROVIDER,
                providerTurn: providerTurnPayload({
                  context: input.context,
                  status: input.status,
                  completedAt: input.completedAt,
                }),
              }),
              ...(input.status === "completed" &&
              input.context.input.providerThread.nativeConversationHeadRef !== null
                ? [
                    emitProviderEvent({
                      type: "provider_thread.updated" as const,
                      driver: CLAUDE_PROVIDER,
                      providerThread: {
                        ...input.context.input.providerThread,
                        providerSessionId: session.id,
                        nativeConversationHeadRef: null,
                        status: "active" as const,
                        firstRunOrdinal:
                          input.context.input.providerThread.firstRunOrdinal ??
                          input.context.input.runOrdinal,
                        lastRunOrdinal: input.context.input.runOrdinal,
                        updatedAt: input.completedAt,
                      },
                    }),
                  ]
                : []),
              emitProviderEvent(terminalEvent),
            ],
            { concurrency: 1 },
          );
          yield* Ref.update(activeTurn, (current) =>
            current?.providerTurnId === input.context.providerTurnId ? null : current,
          );
          yield* Ref.update(interruptedTurns, (current) => {
            const next = new Set(current);
            next.delete(input.context.providerTurnId);
            return next;
          });
        });

        const emitAssistantTextArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly nativeItemId: string;
          readonly text: string;
        }) {
          if (input.context.assistant.emittedNativeItemIds.has(input.nativeItemId)) {
            return;
          }
          input.context.assistant.emittedNativeItemIds.add(input.nativeItemId);
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
          const artifacts = buildAssistantArtifacts({
            idAllocator,
            turnInput: input.context.input,
            providerTurnId: input.context.providerTurnId,
            nativeItemId: input.nativeItemId,
            text: input.text,
            ordinal,
            startedAt: now,
            completedAt: now,
          });
          yield* Effect.all(
            [
              emitProviderEvent({
                type: "node.updated",
                driver: CLAUDE_PROVIDER,
                node: artifacts.node,
              }),
              emitProviderEvent({
                type: "message.updated",
                driver: CLAUDE_PROVIDER,
                message: artifacts.message,
              }),
              emitProviderEvent({
                type: "turn_item.updated",
                driver: CLAUDE_PROVIDER,
                turnItem: artifacts.turnItem,
              }),
            ],
            { concurrency: 1 },
          );
        });

        const finalizeActiveTurnAfterQueryExit = Effect.fnUntraced(function* (
          cause?: Cause.Cause<ClaudeAgentSdkQueryRunnerError>,
        ) {
          const context = yield* Ref.get(activeTurn);
          if (context === null) {
            return;
          }
          const completedAt = yield* DateTime.now;
          const interrupted = (yield* Ref.get(interruptedTurns)).has(context.providerTurnId);
          yield* finalizeActiveTurn({
            context,
            status: interrupted ? "interrupted" : "failed",
            completedAt,
            ...(interrupted
              ? {}
              : {
                  failure: makeProviderFailure({
                    cause: cause === undefined ? undefined : Cause.squash(cause),
                    class: "transport_error",
                  }),
                }),
          });
          yield* Ref.update(interruptedTurns, (current) => {
            const next = new Set(current);
            next.delete(context.providerTurnId);
            return next;
          });
          if (cause !== undefined) {
            yield* Effect.logWarning("orchestration-v2.claude-query-stream-failed", {
              providerSessionId: input.providerSessionId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              cause,
            });
          }
        });

        const clearPendingBackgroundTask = (taskId: string) =>
          Ref.modify(pendingBackgroundTaskIds, (current) => {
            if (!current.has(taskId)) {
              return [false, current] as const;
            }
            const updated = new Set(current);
            updated.delete(taskId);
            return [true, updated] as const;
          });

        const bufferWakeMessage = Effect.fnUntraced(function* (wakeInput: {
          readonly nativeThreadId: string;
          readonly message: SDKMessage;
        }) {
          const message = wakeInput.message;
          const isNotification =
            message.type === "system" && message.subtype === "task_notification";
          // Only notifications for tracked tasks count as wake evidence: a
          // pending local_bash background task, or a session-registered
          // subagent that is still running (Agent with run_in_background
          // settling after the root turn). A stray notification for an
          // unknown task is dropped as before instead of triggering a
          // spurious continuation.
          const isPendingTaskNotification =
            isNotification && (yield* Ref.get(pendingBackgroundTaskIds)).has(message.task_id);
          const isPendingSubagentNotification =
            isNotification &&
            !isPendingTaskNotification &&
            (yield* Ref.get(sessionSubagentsByTaskId)).get(message.task_id)?.task.status ===
              "running";
          // A task_started for a session-registered subagent that races past
          // settle is a resume (SendMessage to a completed subagent re-emits
          // task_started with the same task id). Re-open the registry entry
          // so the resumed run pins idle and its eventual notification counts
          // as wake evidence again, and buffer the frame so the continuation
          // drain re-opens the projection row; it does not itself offer a
          // continuation.
          const isKnownSubagentTaskStarted =
            message.type === "system" &&
            message.subtype === "task_started" &&
            (yield* Ref.get(sessionSubagentsByTaskId)).has(message.task_id);
          if (
            isKnownSubagentTaskStarted &&
            message.type === "system" &&
            message.subtype === "task_started"
          ) {
            const now = yield* DateTime.now;
            yield* Ref.update(sessionSubagentsByTaskId, (current) => {
              const registered = current.get(message.task_id);
              if (registered === undefined || registered.task.status === "running") {
                return current;
              }
              const { progress: _staleProgress, ...priorTask } = registered.task;
              return new Map(current).set(message.task_id, {
                ...registered,
                task: {
                  ...priorTask,
                  status: "running",
                  result: null,
                  completedAt: null,
                  updatedAt: now,
                },
              });
            });
          }
          const isWakeEvidence =
            isPendingTaskNotification ||
            isPendingSubagentNotification ||
            isKnownSubagentTaskStarted ||
            message.type === "assistant" ||
            message.type === "user" ||
            message.type === "result";
          if (!isWakeEvidence) {
            return;
          }
          const notificationSummary =
            isNotification && typeof message.summary === "string" && message.summary.length > 0
              ? message.summary
              : null;
          yield* Ref.update(wakeBuffers, (current) => {
            const existing = current.get(wakeInput.nativeThreadId);
            const updated = new Map(current);
            updated.set(wakeInput.nativeThreadId, {
              messages: [...(existing?.messages ?? []), message],
              detail: notificationSummary ?? existing?.detail ?? null,
            });
            return updated;
          });
          // Request a continuation run once per wake, when the wake turn has
          // either announced the finished task or fully settled. Earlier
          // messages only buffer; the continuation turn drains them.
          if (
            !isPendingTaskNotification &&
            !isPendingSubagentNotification &&
            message.type !== "result"
          ) {
            return;
          }
          const route = (yield* Ref.get(lastTurnRouteByNativeThread)).get(wakeInput.nativeThreadId);
          if (route === undefined) {
            yield* Effect.logWarning("orchestration-v2.claude-wake-turn-unroutable", {
              providerSessionId: input.providerSessionId,
              nativeThreadId: wakeInput.nativeThreadId,
            });
            return;
          }
          const shouldOffer = yield* Ref.modify(requestedContinuations, (current) => {
            if (current.has(wakeInput.nativeThreadId)) {
              return [false, current] as const;
            }
            const updated = new Set(current);
            updated.add(wakeInput.nativeThreadId);
            return [true, updated] as const;
          });
          if (!shouldOffer) {
            return;
          }
          const detail =
            (yield* Ref.get(wakeBuffers)).get(wakeInput.nativeThreadId)?.detail ?? null;
          yield* Effect.logInfo("orchestration-v2.claude-wake-turn-detected", {
            providerSessionId: input.providerSessionId,
            threadId: route.threadId,
            providerThreadId: route.providerThreadId,
          });
          yield* continuationRequests.offer({
            threadId: route.threadId,
            providerThreadId: route.providerThreadId,
            driver: CLAUDE_PROVIDER,
            detail,
          });
        });

        const handleSdkMessage = Effect.fnUntraced(function* (input: {
          readonly query: ClaudeAgentSdkQuerySession;
          readonly message: SDKMessage;
        }) {
          const liveQuery = yield* Ref.get(queryContext);
          if (liveQuery?.query !== input.query) {
            return;
          }

          const message = input.message;
          const context = yield* Ref.get(activeTurn);
          if (context === null) {
            yield* bufferWakeMessage({ nativeThreadId: liveQuery.nativeThreadId, message });
            return;
          }

          if (message.type === "assistant") {
            context.nativeMessageCursor = message.uuid;
          }

          if (message.type === "system" && message.subtype === "task_started") {
            if (isClaudeNonSubagentTask(message)) {
              context.ignoredTaskIds.add(message.task_id);
              yield* Ref.update(pendingBackgroundTaskIds, (current) =>
                new Set(current).add(message.task_id),
              );
            } else {
              yield* updateClaudeSubagentNode({
                context,
                taskId: message.task_id,
                ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
                ...(message.prompt === undefined ? {} : { prompt: message.prompt }),
                title: message.description,
                status: "running",
                reopen: true,
              });
            }
          }

          if (message.type === "system" && message.subtype === "task_progress") {
            const progress = message.description.trim();
            const isBackgroundTask = (yield* Ref.get(pendingBackgroundTaskIds)).has(
              message.task_id,
            );
            if (
              progress.length > 0 &&
              !context.ignoredTaskIds.has(message.task_id) &&
              !isBackgroundTask
            ) {
              yield* updateClaudeSubagentNode({
                context,
                taskId: message.task_id,
                ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
                progress,
                status: "running",
              });
            }
          }

          if (message.type === "system" && message.subtype === "task_notification") {
            // A wake-replay turn has empty ignoredTaskIds, so the session-level
            // background registry is the durable ignore signal across turns.
            const wasBackgroundTask = yield* clearPendingBackgroundTask(message.task_id);
            if (!wasBackgroundTask && !context.ignoredTaskIds.has(message.task_id)) {
              yield* updateClaudeSubagentNode({
                context,
                taskId: message.task_id,
                ...(message.tool_use_id === undefined ? {} : { toolUseId: message.tool_use_id }),
                result: message.summary,
                status:
                  message.status === "completed"
                    ? "completed"
                    : message.status === "stopped"
                      ? "cancelled"
                      : "failed",
              });
            }
          }

          for (const toolUse of claudeToolUseBlocksFromAssistantMessage(message)) {
            if (toolUse.name === "Agent") {
              continue;
            }
            yield* ensureToolCallStarted({
              context,
              nativeItemId: toolUse.id,
              toolName: toolUse.name,
              toolInput: claudeNativeToolInputFromUnknown(toolUse.input),
              parentToolUseId: parentToolUseIdFromSdkMessage(message),
            });
          }

          for (const { toolResult, output } of claudeToolResultEntriesFromMessage(message)) {
            const subagent = context.subagentsByToolUseId.get(toolResult.tool_use_id);
            // A resume task_started reuses the resuming tool call's
            // tool_use_id (e.g. SendMessage), whose tool_result only
            // acknowledges delivery. Only the Agent launch's tool_result may
            // terminalize the subagent, and Agent tool_uses never enter
            // toolCalls (they project as subagent rows instead).
            if (subagent !== undefined && !context.toolCalls.has(toolResult.tool_use_id)) {
              // A background Agent launch resolves its tool_use immediately
              // with an async-launch ACK while the task keeps running; only
              // the eventual task_notification terminalizes the subagent.
              if (isClaudeSubagentAsyncLaunchAck(output)) {
                continue;
              }
              const result = claudeSubagentResultText(output);
              yield* updateClaudeSubagentNode({
                context,
                taskId: subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id),
                toolUseId: toolResult.tool_use_id,
                ...(result.length === 0 ? {} : { result }),
                status: isClaudeToolResultError(toolResult) ? "failed" : "completed",
              });
              continue;
            }
            const parentToolUseId = parentToolUseIdFromSdkMessage(message);
            const toolCall =
              context.toolCalls.get(toolResult.tool_use_id) ??
              (yield* ensureToolCallStarted({
                context,
                nativeItemId: toolResult.tool_use_id,
                toolName: toolNameFromClaudeToolResult(toolResult),
                toolInput: EMPTY_CLAUDE_NATIVE_TOOL_INPUT,
                parentToolUseId,
              }));
            const completedAt = yield* DateTime.now;
            const artifacts = buildToolCallArtifacts({
              context,
              nativeItemId: toolCall.nativeItemId,
              toolName: toolCall.toolName,
              classification: toolCall.classification,
              toolInput: toolCall.input,
              threadId: toolCall.threadId,
              runId: toolCall.runId,
              rootNodeId: toolCall.rootNodeId,
              parentNodeId: toolCall.parentNodeId,
              ordinal: toolCall.ordinal,
              output,
              status: isClaudeToolResultError(toolResult) ? "failed" : "completed",
              startedAt: toolCall.startedAt,
              updatedAt: completedAt,
            });
            yield* emitToolCallArtifacts(artifacts);
            context.toolCalls.delete(toolCall.nativeItemId);
          }

          const assistantText = assistantTextFromSdkMessage(message);
          if (assistantText !== null && assistantText.text.length > 0) {
            yield* emitAssistantTextArtifacts({
              context,
              nativeItemId: assistantText.nativeItemId,
              text: assistantText.text,
            });
            return;
          }

          // An is_error result's text is the error message; it belongs on the
          // terminal-failure item, not on a synthetic assistant message.
          const resultText =
            message.type === "result" && message.subtype === "success" && message.is_error
              ? null
              : resultTextFromSdkMessage(message);
          if (
            context.assistant.emittedNativeItemIds.size === 0 &&
            context.assistant.fallbackText.length === 0 &&
            resultText !== null &&
            resultText.text.length > 0
          ) {
            context.assistant.fallbackText = resultText.text;
            context.assistant.fallbackNativeItemId = resultText.nativeItemId;
          }

          if (message.type === "result") {
            const completedAt = yield* DateTime.now;
            const interrupted = (yield* Ref.get(interruptedTurns)).has(context.providerTurnId);
            const wasSteered = (yield* Ref.get(steeredTurns)).has(context.providerTurnId);
            if (!interrupted && wasSteered && isClaudeActiveSteeringAbortResult(message)) {
              return;
            }
            yield* Ref.update(steeredTurns, (current) => {
              const next = new Set(current);
              next.delete(context.providerTurnId);
              return next;
            });
            const resultFailure = interrupted ? null : providerFailureFromResult(message);
            yield* finalizeActiveTurn({
              context,
              status: interrupted ? "interrupted" : terminalStatusFromResult(message),
              completedAt,
              ...(resultFailure === null ? {} : { failure: resultFailure }),
            });
          }
        });

        const canUseToolEffect = Effect.fn("ClaudeAdapterV2.canUseTool")(function* (
          toolName: Parameters<CanUseTool>[0],
          toolInput: Parameters<CanUseTool>[1],
          callbackOptions: Parameters<CanUseTool>[2],
        ) {
          const context = yield* Ref.get(activeTurn);
          if (context === null) {
            return {
              behavior: "deny",
              message: "Claude V2 adapter has no active turn for this tool request.",
              toolUseID: callbackOptions.toolUseID,
            } satisfies PermissionResult;
          }

          const nativeRequestId = callbackOptions.toolUseID;
          const nativeToolInput = claudeNativeToolInputFromRecord(toolInput);
          if (toolName !== "Agent") {
            yield* ensureToolCallStarted({
              context,
              nativeItemId: nativeRequestId,
              toolName,
              toolInput: nativeToolInput,
              parentToolUseId: null,
            });
          }

          const requestKind = providerRequestKindFromClaudeTool(toolName);
          const prompt =
            callbackOptions.title ??
            callbackOptions.description ??
            callbackOptions.decisionReason ??
            summarizeClaudeToolRequest(toolName, nativeToolInput);
          const artifacts = yield* buildApprovalRequestArtifacts({
            context,
            nativeItemId: nativeRequestId,
            nativeRequestId,
            requestKind,
            prompt,
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(artifacts.request.id), {
              requestId: artifacts.request.id,
              requestKind,
              decision,
            });
            return updated;
          });
          yield* Effect.all(
            [
              emitProviderEvent({
                type: "node.updated",
                driver: CLAUDE_PROVIDER,
                node: artifacts.node,
              }),
              emitProviderEvent({
                type: "runtime_request.updated",
                driver: CLAUDE_PROVIDER,
                runtimeRequest: artifacts.request,
              }),
              emitProviderEvent({
                type: "turn_item.updated",
                driver: CLAUDE_PROVIDER,
                turnItem: artifacts.turnItem,
              }),
            ],
            { concurrency: 1 },
          );

          const abort = () => {
            runFork(Deferred.succeed(decision, "cancel"));
          };
          callbackOptions.signal.addEventListener("abort", abort, { once: true });
          const resolvedDecision = yield* Deferred.await(decision).pipe(
            Effect.ensuring(
              Ref.update(pendingRuntimeRequests, (current) => {
                const updated = new Map(current);
                updated.delete(String(artifacts.request.id));
                return updated;
              }),
            ),
          );
          callbackOptions.signal.removeEventListener("abort", abort);

          return permissionResultFromDecision({
            decision: resolvedDecision,
            toolInput,
            toolUseID: callbackOptions.toolUseID,
            ...(callbackOptions.suggestions === undefined
              ? {}
              : { suggestions: callbackOptions.suggestions }),
          });
        });

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

        const openQuery = Effect.fnUntraced(function* (
          turnInput: ProviderAdapterV2TurnInput,
          nativeThreadId: string,
        ) {
          const queryPolicy = claudeRuntimeQueryPolicyForRuntimePolicy(turnInput.runtimePolicy);
          const mcpOverrides = claudeMcpQueryOverrides({
            threadId: turnInput.threadId,
            readOnlySandbox:
              sandboxPolicyKindForClaudeRuntimePolicy(turnInput.runtimePolicy) === "readOnly",
            ...(queryPolicy.allowedTools === undefined
              ? {}
              : { allowedTools: queryPolicy.allowedTools }),
          });
          const queryPolicyKey = claudeEffectiveQueryPolicyKey(queryPolicy, mcpOverrides);
          const compiledSelection = compileClaudeModelSelection(turnInput.modelSelection);
          const resumeSessionAt = yield* getNativeConversationHeadId(turnInput.providerThread);
          const existing = yield* Ref.get(queryContext);
          if (
            existing !== null &&
            existing.nativeThreadId === nativeThreadId &&
            existing.queryPolicyKey === queryPolicyKey &&
            existing.selectionKey === compiledSelection.queryIdentity
          ) {
            return existing;
          }

          if (existing !== null) {
            yield* existing.query.close.pipe(Effect.ignore);
          }

          const openedWithResume = (yield* Ref.get(openedNativeThreads)).has(nativeThreadId);
          // openedNativeThreads is per session instance and is lost when the
          // provider session is idle-released. A prior persisted provider turn
          // proves the native session already exists, so the query must resume
          // it; reopening with a fixed session id makes the CLI fail fast with
          // "Session ID ... is already in use".
          const hasPersistedProviderTurn = turnInput.providerTurnOrdinal > 1;
          const shouldResume =
            resumeSessionAt !== undefined || openedWithResume || hasPersistedProviderTurn;
          const querySession = yield* queryRunner.open({
            threadId: turnInput.threadId,
            providerSessionId: input.providerSessionId,
            options: makeClaudeQueryOptions({
              modelSelection: turnInput.modelSelection,
              nativeThreadId,
              resume: shouldResume,
              ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
              cwd: turnInput.runtimePolicy.cwd,
              settings: adapterOptions.settings,
              environment: adapterOptions.environment,
              tools: queryPolicy.tools ?? CLAUDE_CODE_PRESET_TOOLS,
              ...mcpOverrides,
              permissionMode: queryPolicy.permissionMode,
              ...(queryPolicy.allowDangerouslySkipPermissions === undefined
                ? {}
                : { allowDangerouslySkipPermissions: queryPolicy.allowDangerouslySkipPermissions }),
              ...(shouldInstallClaudePermissionCallback(queryPolicy) ? { canUseTool } : {}),
            }),
          });
          // Marked only after a successful open: a failed create must not
          // leave the runtime believing the native session exists, or the
          // retry would resume a session that was never created.
          yield* Ref.update(openedNativeThreads, (current) => {
            if (current.has(nativeThreadId)) {
              return current;
            }
            const updated = new Set(current);
            updated.add(nativeThreadId);
            return updated;
          });
          const closed = yield* Deferred.make<void, never>();
          const context: ClaudeLiveQueryContext = {
            nativeThreadId,
            query: querySession,
            queryPolicyKey,
            selectionKey: compiledSelection.queryIdentity,
            closed,
          };
          yield* Ref.set(queryContext, context);
          yield* querySession.messages.pipe(
            Stream.runForEach((message) => handleSdkMessage({ query: querySession, message })),
            Effect.exit,
            Effect.flatMap(
              Effect.fnUntraced(function* (exit: ClaudeQueryStreamExit) {
                const ownsLiveQuery = yield* Ref.modify(queryContext, (current) =>
                  current?.query === querySession ? [true, null] : [false, current],
                );
                if (ownsLiveQuery) {
                  yield* finalizeActiveTurnAfterQueryExit(
                    exit._tag === "Failure" ? exit.cause : undefined,
                  );
                }
              }),
            ),
            Effect.ensuring(Deferred.succeed(closed, undefined)),
            Effect.forkIn(sessionScope),
          );
          return context;
        });

        const startTurn = Effect.fn("ClaudeAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapterV2TurnInput) {
            const startedAt = yield* DateTime.now;
            const nativeThreadId = yield* getNativeThreadId(turnInput.providerThread);
            const nativeTurnId = `turn:${turnInput.attemptId}`;
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CLAUDE_PROVIDER,
              nativeTurnId,
            });
            const providerTurnOrdinal = turnInput.providerTurnOrdinal;
            const currentTurn = yield* Ref.get(activeTurn);
            if (currentTurn !== null) {
              return yield* new ProviderAdapterProtocolError({
                driver: CLAUDE_PROVIDER,
                detail: `Claude provider turn ${currentTurn.providerTurnId} is still active.`,
              });
            }
            yield* Ref.update(lastTurnRouteByNativeThread, (current) => {
              const updated = new Map(current);
              updated.set(nativeThreadId, {
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
              });
              return updated;
            });
            const context: ActiveClaudeTurnContext = {
              input: turnInput,
              nativeTurnId,
              nativeMessageCursor: null,
              providerTurnId,
              providerTurnOrdinal,
              startedAt,
              assistant: {
                fallbackText: "",
                fallbackNativeItemId: `assistant:${turnInput.runId}`,
                emittedNativeItemIds: new Set(),
              },
              toolCalls: new Map(),
              ignoredTaskIds: new Set(),
              subagentsByTaskId: new Map(),
              subagentsByToolUseId: new Map(),
              subagentNodesByTaskId: new Map(),
            };
            // Continuation turns attach to the wake output the CLI already
            // produced instead of prompting it again: drain the buffered wake
            // messages into this turn and let any still-streaming messages
            // follow live. The continuation prompt text never reaches the CLI.
            const isContinuationTurn =
              turnInput.message.createdBy === "agent" &&
              turnInput.message.creationSource === "provider";
            const userMessage = isContinuationTurn
              ? null
              : yield* makeClaudeUserMessageWithAttachments({
                  text: applyClaudePromptEffortPrefix(
                    turnInput.message.text,
                    compileClaudeModelSelection(turnInput.modelSelection).promptEffort,
                  ),
                  attachments: turnInput.message.attachments,
                  attachmentsDir,
                  fileSystem,
                });
            const querySession = yield* openQuery(turnInput, nativeThreadId);
            yield* Ref.set(activeTurn, context);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CLAUDE_PROVIDER,
              providerTurn: providerTurnPayload({
                context,
                status: "running",
                completedAt: null,
              }),
            });
            if (userMessage !== null) {
              // A user turn that races a wake leaves the buffer alone: the
              // continuation run the worker queued behind this run drains it
              // afterwards with correct attribution.
              yield* querySession.query.offer(userMessage);
              return;
            }
            const drained = yield* Ref.modify(wakeBuffers, (current) => {
              const entry = current.get(nativeThreadId);
              if (entry === undefined) {
                return [[] as ReadonlyArray<SDKMessage>, current] as const;
              }
              const updated = new Map(current);
              updated.delete(nativeThreadId);
              return [entry.messages, updated] as const;
            });
            yield* Ref.update(requestedContinuations, (current) => {
              const updated = new Set(current);
              updated.delete(nativeThreadId);
              return updated;
            });
            if (drained.length === 0) {
              // Spurious continuation (buffer already lost with a recycled
              // session, or a duplicate request): settle immediately instead
              // of leaving a run waiting on a prompt that was never sent.
              const completedAt = yield* DateTime.now;
              yield* finalizeActiveTurn({ context, status: "completed", completedAt });
              return;
            }
            // Replay any result message last: a result finalizes the turn, and
            // replaying it before the rest would drop them back into the wake
            // buffer and request another continuation.
            const resultMessages = drained.filter((entry) => entry.type === "result");
            for (const entry of drained) {
              if (entry.type !== "result") {
                yield* handleSdkMessage({ query: querySession.query, message: entry });
              }
            }
            const lastResult = resultMessages.at(-1);
            if (lastResult !== undefined) {
              yield* handleSdkMessage({ query: querySession.query, message: lastResult });
            }
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    driver: CLAUDE_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        );

        const interruptTurn = Effect.fn("ClaudeAdapterV2.interruptTurn")(
          function* (turnInput: ProviderAdapterV2InterruptInput) {
            const existing = yield* Ref.get(queryContext);
            if (existing === null) {
              return yield* new ProviderAdapterProtocolError({
                driver: CLAUDE_PROVIDER,
                detail: `Claude provider thread ${turnInput.providerThread.id} has no live query.`,
              });
            }
            const currentTurn = yield* Ref.get(activeTurn);
            if (currentTurn?.providerTurnId !== turnInput.providerTurnId) {
              return yield* new ProviderAdapterProtocolError({
                driver: CLAUDE_PROVIDER,
                detail: `Claude provider turn ${turnInput.providerTurnId} is not the active turn.`,
              });
            }
            yield* Ref.update(interruptedTurns, (current) => {
              const next = new Set(current);
              next.add(turnInput.providerTurnId);
              return next;
            });
            yield* existing.query.interrupt;
            yield* existing.query.close.pipe(Effect.ignore);
            const closed = yield* Deferred.await(existing.closed).pipe(
              Effect.timeoutOption("10 seconds"),
            );
            if (Option.isSome(closed)) {
              return;
            }

            const completedAt = yield* DateTime.now;
            yield* Effect.logWarning("orchestration-v2.claude-query-interrupt-timeout", {
              providerSessionId: input.providerSessionId,
              providerThreadId: turnInput.providerThread.id,
              providerTurnId: turnInput.providerTurnId,
            });
            yield* Ref.update(queryContext, (current) =>
              current?.query === existing.query ? null : current,
            );
            yield* finalizeActiveTurn({
              context: currentTurn,
              status: "interrupted",
              completedAt,
            });
            yield* Deferred.succeed(existing.closed, undefined);
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    driver: CLAUDE_PROVIDER,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId: turnInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        );

        const steerTurn = Effect.fn("ClaudeAdapterV2.steerTurn")(
          function* (turnInput: ProviderAdapterV2SteerInput) {
            const existing = yield* Ref.get(queryContext);
            if (existing === null) {
              return yield* new ProviderAdapterProtocolError({
                driver: CLAUDE_PROVIDER,
                detail: `Claude provider thread ${turnInput.providerThread.id} has no live query.`,
              });
            }
            const currentTurn = yield* Ref.get(activeTurn);
            if (currentTurn?.providerTurnId !== turnInput.providerTurnId) {
              return yield* new ProviderAdapterProtocolError({
                driver: CLAUDE_PROVIDER,
                detail: `Claude provider turn ${turnInput.providerTurnId} is not the active turn.`,
              });
            }
            const userMessage = yield* makeClaudeUserMessageWithAttachments({
              text: applyClaudePromptEffortPrefix(
                turnInput.message.text,
                compileClaudeModelSelection(currentTurn.input.modelSelection).promptEffort,
              ),
              attachments: turnInput.message.attachments,
              priority: "now",
              attachmentsDir,
              fileSystem,
            });
            yield* Ref.update(steeredTurns, (current) => {
              const next = new Set(current);
              next.add(turnInput.providerTurnId);
              return next;
            });
            yield* existing.query.offer(userMessage);
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterSteerRunError({
                    driver: CLAUDE_PROVIDER,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId: turnInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        );

        const closeSession = Effect.fnUntraced(function* () {
          const existing = yield* Ref.get(queryContext);
          if (existing !== null) {
            yield* existing.query.close.pipe(Effect.ignore);
          }
          yield* Effect.yieldNow;
          yield* queryRunner.assertComplete.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.claude-query-runner-incomplete", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        });

        const closeLiveQueryForNativeThread = Effect.fnUntraced(function* (nativeThreadId: string) {
          const existing = yield* Ref.get(queryContext);
          if (existing === null || existing.nativeThreadId !== nativeThreadId) {
            return;
          }

          yield* existing.query.close.pipe(Effect.ignore);
          const closed = yield* Deferred.await(existing.closed).pipe(
            Effect.timeoutOption("10 seconds"),
          );
          if (Option.isSome(closed)) {
            return;
          }

          yield* Effect.logWarning("orchestration-v2.claude-query-close-timeout-before-fork", {
            providerSessionId: input.providerSessionId,
            nativeThreadId,
          });
          yield* Ref.update(queryContext, (current) =>
            current?.query === existing.query ? null : current,
          );
          yield* Deferred.succeed(existing.closed, undefined);
        });
        yield* Effect.addFinalizer(() => closeSession());

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          driver: CLAUDE_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          hasPendingBackgroundWork: Effect.gen(function* () {
            if ((yield* Ref.get(pendingBackgroundTaskIds)).size > 0) {
              return true;
            }
            for (const subagent of (yield* Ref.get(sessionSubagentsByTaskId)).values()) {
              if (subagent.task.status === "running") {
                return true;
              }
            }
            const buffers = yield* Ref.get(wakeBuffers);
            for (const entry of buffers.values()) {
              if (entry.messages.length > 0) {
                return true;
              }
            }
            return false;
          }),
          ensureThread: Effect.fn("ClaudeAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapterV2EnsureThreadInput) {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = yield* queryRunner.allocateSessionId;
              return makeProviderThread({
                idAllocator,
                providerInstanceId: adapterOptions.instanceId,
                appThreadId: threadInput.threadId,
                providerSessionId: input.providerSessionId,
                nativeThreadId,
                now: createdAt,
              });
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterEnsureThreadError({
                      driver: CLAUDE_PROVIDER,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("ClaudeAdapterV2.resumeThread")(
            function* (threadInput: { readonly providerThread: OrchestrationV2ProviderThread }) {
              const updatedAt = yield* DateTime.now;
              return {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt,
              };
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterResumeThreadError({
                      driver: CLAUDE_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn,
          steerTurn,
          interruptTurn,
          respondToRuntimeRequest: Effect.fn("ClaudeAdapterV2.respondToRuntimeRequest")(
            function* (requestInput) {
              const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
                String(requestInput.requestId),
              );
              if (pending === undefined) {
                return yield* new ProviderAdapterRuntimeRequestResponseError({
                  driver: CLAUDE_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: new ProviderAdapterProtocolError({
                    driver: CLAUDE_PROVIDER,
                    detail: `No pending Claude runtime request ${requestInput.requestId}.`,
                  }),
                });
              }
              if (requestInput.decision === undefined) {
                return yield* new ProviderAdapterRuntimeRequestResponseError({
                  driver: CLAUDE_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: new ProviderAdapterProtocolError({
                    driver: CLAUDE_PROVIDER,
                    detail: `Claude ${pending.requestKind} request ${requestInput.requestId} requires an approval decision.`,
                  }),
                });
              }
              yield* Deferred.succeed(pending.decision, requestInput.decision);
            },
            (effect, requestInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  Schema.is(ProviderAdapterRuntimeRequestResponseError)(cause)
                    ? cause
                    : new ProviderAdapterRuntimeRequestResponseError({
                        driver: CLAUDE_PROVIDER,
                        requestId: requestInput.requestId,
                        cause,
                      }),
                ),
              ),
          ),
          readThreadSnapshot: (snapshotInput) =>
            Effect.fail(
              new ProviderAdapterReadThreadSnapshotError({
                driver: CLAUDE_PROVIDER,
                providerThreadId: snapshotInput.providerThread.id,
                cause: "Claude V2 adapter does not implement snapshots.",
              }),
            ),
          rollbackThread: Effect.fn("ClaudeAdapterV2.rollbackThread")(
            function* (rollbackInput) {
              const currentTurn = yield* Ref.get(activeTurn);
              if (currentTurn !== null) {
                return yield* new ProviderAdapterProtocolError({
                  driver: CLAUDE_PROVIDER,
                  detail: `Cannot roll back Claude provider thread ${rollbackInput.providerThread.id} while provider turn ${currentTurn.providerTurnId} is active.`,
                });
              }

              const nativeThreadId = yield* getNativeThreadId(rollbackInput.providerThread);
              yield* closeLiveQueryForNativeThread(nativeThreadId);
              const now = yield* DateTime.now;

              if (rollbackInput.target.type === "thread_start") {
                const resetNativeThreadId = yield* queryRunner.allocateSessionId;
                return {
                  providerThread: {
                    ...makeProviderThread({
                      idAllocator,
                      providerInstanceId: adapterOptions.instanceId,
                      appThreadId: rollbackInput.providerThread.appThreadId,
                      ...(rollbackInput.providerThread.ownerNodeId === null
                        ? {}
                        : { ownerNodeId: rollbackInput.providerThread.ownerNodeId }),
                      providerSessionId: input.providerSessionId,
                      nativeThreadId: resetNativeThreadId,
                      ...(rollbackInput.providerThread.forkedFrom === null
                        ? {}
                        : { forkedFrom: rollbackInput.providerThread.forkedFrom }),
                      now,
                    }),
                    handoffIds: rollbackInput.providerThread.handoffIds,
                  },
                  providerTurns: [],
                  messages: [],
                  runtimeRequests: [],
                };
              }

              const resumeSessionAt = yield* resolveClaudeRollbackResumeSessionAt(rollbackInput);
              return {
                providerThread: {
                  ...rollbackInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  nativeConversationHeadRef:
                    resumeSessionAt === null
                      ? null
                      : {
                          driver: CLAUDE_PROVIDER,
                          nativeId: resumeSessionAt,
                          strength: "weak" as const,
                        },
                  status: "idle" as const,
                  lastRunOrdinal: rollbackInput.target.appRunOrdinal,
                  updatedAt: now,
                },
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
              };
            },
            (effect, rollbackInput) =>
              effect.pipe(
                Effect.mapError((cause) =>
                  Schema.is(ProviderAdapterRollbackThreadError)(cause)
                    ? cause
                    : new ProviderAdapterRollbackThreadError({
                        driver: CLAUDE_PROVIDER,
                        providerThreadId: rollbackInput.providerThread.id,
                        cause,
                      }),
                ),
              ),
          ),
          forkThread: Effect.fn("ClaudeAdapterV2.forkThread")(
            function* (forkInput) {
              const currentTurn = yield* Ref.get(activeTurn);
              if (currentTurn !== null) {
                return yield* new ProviderAdapterProtocolError({
                  driver: CLAUDE_PROVIDER,
                  detail: `Cannot fork Claude provider thread ${forkInput.sourceProviderThread.id} while provider turn ${currentTurn.providerTurnId} is active.`,
                });
              }

              const sourceNativeThreadId = yield* getNativeThreadId(forkInput.sourceProviderThread);
              yield* closeLiveQueryForNativeThread(sourceNativeThreadId);
              const upToMessageId = yield* resolveClaudeForkUpToMessageId(forkInput);
              const forkOptions: ForkSessionOptions = {
                ...(input.runtimePolicy.cwd === null ? {} : { dir: input.runtimePolicy.cwd }),
                ...(upToMessageId === undefined ? {} : { upToMessageId }),
              };
              const forked = yield* queryRunner.forkSession({
                sessionId: sourceNativeThreadId,
                options: forkOptions,
                threadId: forkInput.targetThreadId,
                providerSessionId: input.providerSessionId,
              });
              yield* Ref.update(openedNativeThreads, (current) => {
                const updated = new Set(current);
                updated.add(forked.sessionId);
                return updated;
              });
              const now = yield* DateTime.now;
              return makeProviderThread({
                idAllocator,
                providerInstanceId: adapterOptions.instanceId,
                appThreadId: forkInput.targetThreadId,
                ownerNodeId: forkInput.ownerNodeId ?? null,
                providerSessionId: input.providerSessionId,
                nativeThreadId: forked.sessionId,
                forkedFrom: {
                  providerThreadId: forkInput.sourceProviderThread.id,
                  ...(forkInput.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: forkInput.providerTurnId }),
                },
                now,
              });
            },
            (effect, forkInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterForkThreadError({
                      driver: CLAUDE_PROVIDER,
                      providerThreadId: forkInput.sourceProviderThread.id,
                      cause,
                    }),
                ),
              ),
          ),
        };

        return runtime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: CLAUDE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}

export type ClaudeAdapterV2DriverEnv =
  | ClaudeAgentSdkQueryRunner
  | FileSystem.FileSystem
  | IdAllocatorV2
  | Path.Path
  | ServerConfig;

export const ClaudeAdapterV2Driver: ProviderAdapterDriver<
  ClaudeSettings,
  ClaudeAdapterV2DriverEnv
> = {
  driverKind: CLAUDE_DRIVER_KIND,
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => DEFAULT_CLAUDE_SETTINGS,
  create: Effect.fn("ClaudeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ClaudeSettings>) {
      const { instanceId, environment, enabled, config } = input;
      const fileSystem = yield* FileSystem.FileSystem;
      const hostEnvironment = yield* HostProcessEnvironment;
      const idAllocator = yield* IdAllocatorV2;
      const queryRunner = yield* ClaudeAgentSdkQueryRunner;
      const serverConfig = yield* ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests;
      const baseEnvironment = mergeProviderInstanceEnvironment(environment, hostEnvironment);
      const claudeEnvironment = yield* makeClaudeEnvironment(config, baseEnvironment);
      return makeClaudeAdapterV2({
        instanceId,
        settings: { ...config, enabled },
        environment: claudeEnvironment,
        attachmentsDir: serverConfig.attachmentsDir,
        fileSystem,
        idAllocator,
        queryRunner,
        continuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: CLAUDE_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Claude Agent SDK adapter.",
              cause,
            }),
        ),
      ),
  ),
};

const makeDefaultClaudeAdapterV2 = Effect.fn("ClaudeAdapterV2.layer")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostEnvironment = yield* HostProcessEnvironment;
  const idAllocator = yield* IdAllocatorV2;
  const queryRunner = yield* ClaudeAgentSdkQueryRunner;
  const serverConfig = yield* ServerConfig;
  const continuationRequests = yield* ProviderContinuationRequests;

  return makeClaudeAdapterV2({
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    settings: DEFAULT_CLAUDE_SETTINGS,
    environment: hostEnvironment,
    attachmentsDir: serverConfig.attachmentsDir,
    fileSystem,
    idAllocator,
    queryRunner,
    continuationRequests,
  });
});

export const layer: Layer.Layer<
  ProviderAdapterV2,
  never,
  ClaudeAgentSdkQueryRunner | FileSystem.FileSystem | IdAllocatorV2 | ServerConfig
> = Layer.effect(ProviderAdapterV2, makeDefaultClaudeAdapterV2());
