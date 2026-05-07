import {
  type CanUseTool,
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
import {
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2WebSearchResult,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
} from "@t3tools/contracts";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { IdAllocatorV2, type IdAllocatorV2Shape } from "../IdAllocator.ts";
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
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2EnsureThreadInput,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2InterruptInput,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";

export const CLAUDE_PROVIDER = "claudeAgent" as const;

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
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
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
    supportsMcpTools: false,
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
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
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
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
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
    cause: Schema.Defect,
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
  readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
}

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerShape
>()("t3/orchestration-v2/ClaudeAgentSdkQueryRunner") {}

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

export const claudeAgentSdkQueryRunnerLiveLayer: Layer.Layer<ClaudeAgentSdkQueryRunner> =
  Layer.succeed(
    ClaudeAgentSdkQueryRunner,
    ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: Random.nextUUIDv4,
      open: Effect.fn("ClaudeAgentSdkQueryRunner.open")(function* (
        input: ClaudeAgentSdkQueryOpenInput,
      ) {
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

        return {
          messages: Stream.fromAsyncIterable(queryRuntime, (cause) =>
            queryRunnerError(cause, "fromAsyncIterable"),
          ),
          offer: (message) => Queue.offer(promptQueue, message).pipe(Effect.asVoid),
          setModel: (model) =>
            Effect.tryPromise({
              try: () => queryRuntime.setModel(model),
              catch: (cause) => queryRunnerError(cause, "setModel"),
            }),
          interrupt: Effect.tryPromise({
            try: () => queryRuntime.interrupt(),
            catch: (cause) => queryRunnerError(cause, "interupt"),
          }),
          close: Queue.shutdown(promptQueue).pipe(Effect.andThen(closeClaudeQuery(queryRuntime))),
        } satisfies ClaudeAgentSdkQuerySession;
      }),
      assertComplete: Effect.void,
    }),
  );

export function makeClaudeQueryOptions(input: {
  readonly modelSelection: ModelSelection;
  readonly nativeThreadId: string;
  readonly resume: boolean;
  readonly cwd: string | null;
  readonly settings?: ClaudeSettings;
  readonly sdkSettings?: string | ClaudeSdkSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly tools?: ClaudeAgentSdkQueryTools;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly disallowedTools?: ReadonlyArray<string>;
  readonly permissionMode?: PermissionMode;
  readonly canUseTool?: CanUseTool;
  readonly allowDangerouslySkipPermissions?: boolean;
}): ClaudeAgentSdkQueryOptions {
  const extraArgs =
    input.settings === undefined ? {} : parseCliArgs(input.settings.launchArgs).flags;
  const threadIdentity: ClaudeAgentSdkThreadIdentity = input.resume
    ? { resume: input.nativeThreadId }
    : { sessionId: input.nativeThreadId };
  const selectedTools = input.tools ?? CLAUDE_CODE_PRESET_TOOLS;
  const options: ClaudeAgentSdkQueryOptions = {
    model: input.modelSelection.model,
    tools: claudeAgentSdkQueryToolsForSdk(selectedTools),
    permissionMode: input.permissionMode ?? "default",
    ...threadIdentity,
    ...(input.allowedTools === undefined ? {} : { allowedTools: [...input.allowedTools] }),
    ...(input.disallowedTools === undefined ? {} : { disallowedTools: [...input.disallowedTools] }),
    ...(input.canUseTool === undefined ? {} : { canUseTool: input.canUseTool }),
    ...(input.allowDangerouslySkipPermissions === true
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(input.sdkSettings === undefined ? {} : { settings: input.sdkSettings }),
    ...(input.settings?.binaryPath
      ? { pathToClaudeCodeExecutable: input.settings.binaryPath }
      : {}),
    ...(input.environment === undefined ? {} : { env: input.environment }),
    ...(Object.keys(extraArgs).length === 0 ? {} : { extraArgs }),
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

const getNativeThreadId = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
) {
  const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
  if (nativeThreadId === undefined || nativeThreadId === null) {
    return yield* new ProviderAdapterProtocolError({
      provider: CLAUDE_PROVIDER,
      detail: `Provider thread ${providerThread.id} is missing a native Claude session id.`,
    });
  }
  return nativeThreadId;
});

function shouldResumeClaudeThread(turnInput: ProviderAdapterV2TurnInput): boolean {
  const firstRunOrdinal = turnInput.providerThread.firstRunOrdinal;
  return firstRunOrdinal !== null && firstRunOrdinal < turnInput.runOrdinal;
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

type ClaudeAssistantContentBlock = SDKAssistantMessage["message"]["content"][number];
type ClaudeToolUseContentBlock = Extract<
  ClaudeAssistantContentBlock,
  {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }
>;
type ClaudeUserContent = SDKUserMessage["message"]["content"];
type ClaudeUserContentBlock = Exclude<ClaudeUserContent, string>[number];
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
    return "completed";
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
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly startedAt: DateTime.Utc;
  readonly assistant: {
    text: string;
    nativeItemId: string;
  };
  readonly toolCalls: Map<string, ActiveClaudeToolCall>;
}

interface ClaudeLiveQueryContext {
  readonly nativeThreadId: string;
  readonly query: ClaudeAgentSdkQuerySession;
  readonly queryPolicyKey: string;
  currentModel: string;
}

interface ActiveClaudeToolCall {
  readonly nativeItemId: string;
  readonly toolName: string;
  readonly classification: ClaudeToolClassification;
  readonly input: ClaudeNativeToolInput;
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
  readonly idAllocator: IdAllocatorV2Shape;
  readonly queryRunner: ClaudeAgentSdkQueryRunnerShape;
}

export function makeClaudeAdapterV2(
  adapterOptions: ClaudeAdapterV2Options,
): ProviderAdapterV2Shape {
  const { idAllocator, queryRunner } = adapterOptions;

  return ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    provider: CLAUDE_PROVIDER,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    openSession: Effect.fn("ClaudeAdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const now = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const activeTurn = yield* Ref.make<ActiveClaudeTurnContext | null>(null);
        const interruptedTurns = yield* Ref.make(new Set<OrchestrationV2ProviderTurn["id"]>());
        const queryContext = yield* Ref.make<ClaudeLiveQueryContext | null>(null);
        const itemOrdinals = yield* Ref.make(new Map<string, number>());
        const nextItemOrdinalsByTurn = yield* Ref.make(new Map<string, number>());
        const pendingRuntimeRequests = yield* Ref.make(
          new Map<string, PendingClaudeRuntimeRequest>(),
        );
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
          const nextOrdinal = context.input.runOrdinal * 100 + nextWithinTurn;
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
            provider: CLAUDE_PROVIDER,
            nativeId: input.context.nativeTurnId,
            strength: "weak",
          },
          ordinal: input.context.input.runOrdinal,
          status: input.status,
          startedAt: input.context.startedAt,
          completedAt: input.completedAt,
        });

        const buildToolCallArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly nativeItemId: string;
          readonly toolName: string;
          readonly classification: ClaudeToolClassification;
          readonly toolInput: ClaudeNativeToolInput;
          readonly output: ClaudeNativeToolOutput;
          readonly status: Extract<
            OrchestrationV2TurnItem["status"],
            "running" | "completed" | "failed"
          >;
          readonly startedAt: DateTime.Utc;
          readonly updatedAt: DateTime.Utc;
        }) {
          const completedAt = input.status === "running" ? null : input.updatedAt;
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            provider: CLAUDE_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            provider: CLAUDE_PROVIDER,
            nativeItemId: input.nativeItemId,
          });
          const nativeItemRef = {
            provider: CLAUDE_PROVIDER,
            nativeId: input.nativeItemId,
            strength: "strong" as const,
          };
          const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            parentNodeId: input.context.input.rootNodeId,
            rootNodeId: input.context.input.rootNodeId,
            kind: "tool_call",
            status: input.status,
            countsForRun: false,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: input.startedAt,
            completedAt,
          };
          const itemBase = {
            id: turnItemId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            nodeId,
            providerThreadId: input.context.input.providerThread.id,
            providerTurnId: input.context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
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
        });

        const emitToolCallArtifacts = Effect.fnUntraced(function* (artifacts: {
          readonly node: OrchestrationV2ExecutionNode;
          readonly turnItem: OrchestrationV2TurnItem;
        }) {
          yield* emitProviderEvent({
            type: "node.updated",
            provider: CLAUDE_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            provider: CLAUDE_PROVIDER,
            turnItem: artifacts.turnItem,
          });
        });

        const ensureToolCallStarted = Effect.fnUntraced(function* (input: {
          readonly context: ActiveClaudeTurnContext;
          readonly nativeItemId: string;
          readonly toolName: string;
          readonly toolInput: ClaudeNativeToolInput;
        }) {
          const existing = input.context.toolCalls.get(input.nativeItemId);
          if (existing !== undefined) {
            return existing;
          }
          const startedAt = yield* DateTime.now;
          const classification = classifyClaudeNativeTool(input.toolName);
          const toolCall: ActiveClaudeToolCall = {
            nativeItemId: input.nativeItemId,
            toolName: input.toolName,
            classification,
            input: input.toolInput,
            startedAt,
          };
          input.context.toolCalls.set(input.nativeItemId, toolCall);
          yield* buildToolCallArtifacts({
            context: input.context,
            nativeItemId: input.nativeItemId,
            toolName: input.toolName,
            classification,
            toolInput: input.toolInput,
            output: NO_CLAUDE_NATIVE_TOOL_OUTPUT,
            status: "running",
            startedAt,
            updatedAt: startedAt,
          }).pipe(Effect.flatMap(emitToolCallArtifacts));
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
            provider: CLAUDE_PROVIDER,
            providerTurnId: input.context.providerTurnId,
            nativeRequestId: input.nativeRequestId,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const providerSessionId = input.context.input.providerThread.providerSessionId;
          if (providerSessionId === null) {
            return yield* new ProviderAdapterProtocolError({
              provider: CLAUDE_PROVIDER,
              detail: `Provider thread ${input.context.input.providerThread.id} is missing a provider session id.`,
            });
          }
          const ordinal = yield* resolveItemOrdinal(
            input.context,
            `${input.nativeItemId}:approval:${input.nativeRequestId}`,
          );
          const nativeItemRef = {
            provider: CLAUDE_PROVIDER,
            nativeId: input.nativeRequestId,
            strength: "strong" as const,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            parentNodeId: idAllocator.derive.nodeFromProviderItem({
              provider: CLAUDE_PROVIDER,
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
              provider: CLAUDE_PROVIDER,
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
        }) {
          for (const toolCall of input.context.toolCalls.values()) {
            const artifacts = yield* buildToolCallArtifacts({
              context: input.context,
              nativeItemId: toolCall.nativeItemId,
              toolName: toolCall.toolName,
              classification: toolCall.classification,
              toolInput: toolCall.input,
              output: NO_CLAUDE_NATIVE_TOOL_OUTPUT,
              status: "failed",
              startedAt: toolCall.startedAt,
              updatedAt: input.completedAt,
            });
            yield* emitToolCallArtifacts(artifacts);
          }
          input.context.toolCalls.clear();

          if (input.context.assistant.text.length > 0) {
            const ordinal = yield* resolveItemOrdinal(
              input.context,
              input.context.assistant.nativeItemId,
            );
            const artifacts = buildAssistantArtifacts({
              idAllocator,
              turnInput: input.context.input,
              providerTurnId: input.context.providerTurnId,
              nativeItemId: input.context.assistant.nativeItemId,
              text: input.context.assistant.text,
              ordinal,
              startedAt: input.context.startedAt,
              completedAt: input.completedAt,
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
                providerTurn: providerTurnPayload({
                  context: input.context,
                  status: input.status,
                  completedAt: input.completedAt,
                }),
              }),
              emitProviderEvent({
                type: "turn.terminal",
                provider: CLAUDE_PROVIDER,
                providerTurnId: input.context.providerTurnId,
                status: input.status,
              }),
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

        const finalizeActiveTurnAfterQueryExit = Effect.fnUntraced(function* (cause?: unknown) {
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

        const handleSdkMessage = Effect.fnUntraced(function* (message: SDKMessage) {
          const context = yield* Ref.get(activeTurn);
          if (context === null) {
            return;
          }

          for (const toolUse of claudeToolUseBlocksFromAssistantMessage(message)) {
            yield* ensureToolCallStarted({
              context,
              nativeItemId: toolUse.id,
              toolName: toolUse.name,
              toolInput: claudeNativeToolInputFromUnknown(toolUse.input),
            });
          }

          for (const { toolResult, output } of claudeToolResultEntriesFromMessage(message)) {
            const toolCall =
              context.toolCalls.get(toolResult.tool_use_id) ??
              (yield* ensureToolCallStarted({
                context,
                nativeItemId: toolResult.tool_use_id,
                toolName: toolNameFromClaudeToolResult(toolResult),
                toolInput: EMPTY_CLAUDE_NATIVE_TOOL_INPUT,
              }));
            const completedAt = yield* DateTime.now;
            const artifacts = yield* buildToolCallArtifacts({
              context,
              nativeItemId: toolCall.nativeItemId,
              toolName: toolCall.toolName,
              classification: toolCall.classification,
              toolInput: toolCall.input,
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
            context.assistant.text += assistantText.text;
            context.assistant.nativeItemId = assistantText.nativeItemId;
            return;
          }

          const resultText = resultTextFromSdkMessage(message);
          if (
            context.assistant.text.length === 0 &&
            resultText !== null &&
            resultText.text.length > 0
          ) {
            context.assistant.text = resultText.text;
            context.assistant.nativeItemId = resultText.nativeItemId;
          }

          if (message.type === "result") {
            const completedAt = yield* DateTime.now;
            yield* finalizeActiveTurn({
              context,
              status: terminalStatusFromResult(message),
              completedAt,
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
          yield* ensureToolCallStarted({
            context,
            nativeItemId: nativeRequestId,
            toolName,
            toolInput: nativeToolInput,
          });

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
                provider: CLAUDE_PROVIDER,
                node: artifacts.node,
              }),
              emitProviderEvent({
                type: "runtime_request.updated",
                provider: CLAUDE_PROVIDER,
                runtimeRequest: artifacts.request,
              }),
              emitProviderEvent({
                type: "turn_item.updated",
                provider: CLAUDE_PROVIDER,
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
          const queryPolicyKey = claudeRuntimeQueryPolicyKey(queryPolicy);
          const existing = yield* Ref.get(queryContext);
          if (
            existing !== null &&
            existing.nativeThreadId === nativeThreadId &&
            existing.queryPolicyKey === queryPolicyKey
          ) {
            if (existing.currentModel !== turnInput.modelSelection.model) {
              yield* existing.query.setModel(turnInput.modelSelection.model);
              existing.currentModel = turnInput.modelSelection.model;
            }
            return existing;
          }

          if (existing !== null) {
            yield* existing.query.close.pipe(Effect.ignore);
          }

          const openedWithResume = shouldResumeClaudeThread(turnInput);
          const querySession = yield* queryRunner.open({
            options: makeClaudeQueryOptions({
              modelSelection: turnInput.modelSelection,
              nativeThreadId,
              resume: openedWithResume,
              cwd: turnInput.runtimePolicy.cwd,
              settings: adapterOptions.settings,
              environment: adapterOptions.environment,
              tools: queryPolicy.tools ?? CLAUDE_CODE_PRESET_TOOLS,
              ...(queryPolicy.allowedTools === undefined
                ? {}
                : { allowedTools: queryPolicy.allowedTools }),
              permissionMode: queryPolicy.permissionMode,
              ...(queryPolicy.allowDangerouslySkipPermissions === undefined
                ? {}
                : { allowDangerouslySkipPermissions: queryPolicy.allowDangerouslySkipPermissions }),
              ...(shouldInstallClaudePermissionCallback(queryPolicy) ? { canUseTool } : {}),
            }),
          });
          const context: ClaudeLiveQueryContext = {
            nativeThreadId,
            query: querySession,
            queryPolicyKey,
            currentModel: turnInput.modelSelection.model,
          };
          yield* Ref.set(queryContext, context);
          yield* querySession.messages.pipe(
            Stream.runForEach(handleSdkMessage),
            Effect.exit,
            Effect.flatMap(
              Effect.fnUntraced(function* (exit: ClaudeQueryStreamExit) {
                yield* Ref.update(queryContext, (current) =>
                  current?.query === querySession ? null : current,
                );
                yield* finalizeActiveTurnAfterQueryExit(
                  exit._tag === "Failure" ? exit.cause : undefined,
                );
              }),
            ),
            Effect.forkIn(sessionScope),
          );
          return context;
        });

        const startTurn = Effect.fn("ClaudeAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapterV2TurnInput) {
            const startedAt = yield* DateTime.now;
            const nativeThreadId = yield* getNativeThreadId(turnInput.providerThread);
            const nativeTurnId = `turn:${turnInput.runId}`;
            const providerTurnId = idAllocator.derive.providerTurn({
              provider: CLAUDE_PROVIDER,
              nativeTurnId,
            });
            const currentTurn = yield* Ref.get(activeTurn);
            if (currentTurn !== null) {
              return yield* new ProviderAdapterProtocolError({
                provider: CLAUDE_PROVIDER,
                detail: `Claude provider turn ${currentTurn.providerTurnId} is still active.`,
              });
            }
            const context: ActiveClaudeTurnContext = {
              input: turnInput,
              nativeTurnId,
              providerTurnId,
              startedAt,
              assistant: {
                text: "",
                nativeItemId: `assistant:${turnInput.runId}`,
              },
              toolCalls: new Map(),
            };
            const querySession = yield* openQuery(turnInput, nativeThreadId);
            yield* Ref.set(activeTurn, context);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              provider: CLAUDE_PROVIDER,
              providerTurn: providerTurnPayload({
                context,
                status: "running",
                completedAt: null,
              }),
            });
            yield* querySession.query.offer(
              makeClaudeUserMessage({ text: turnInput.message.text }),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
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
            ),
        );

        const interruptTurn = Effect.fn("ClaudeAdapterV2.interruptTurn")(
          function* (turnInput: ProviderAdapterV2InterruptInput) {
            const existing = yield* Ref.get(queryContext);
            if (existing === null) {
              return yield* new ProviderAdapterProtocolError({
                provider: CLAUDE_PROVIDER,
                detail: `Claude provider thread ${turnInput.providerThread.id} has no live query.`,
              });
            }
            yield* Ref.update(interruptedTurns, (current) => {
              const next = new Set(current);
              next.add(turnInput.providerTurnId);
              return next;
            });
            yield* existing.query.interrupt;
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterInterruptError({
                    provider: CLAUDE_PROVIDER,
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
        yield* Effect.addFinalizer(() => closeSession());

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          provider: CLAUDE_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          rawEvents: Stream.empty,
          events: Stream.fromQueue(events),
          ensureThread: Effect.fn("ClaudeAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapterV2EnsureThreadInput) {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = yield* queryRunner.allocateSessionId;
              return makeProviderThread({
                idAllocator,
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
                      provider: CLAUDE_PROVIDER,
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
                      provider: CLAUDE_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
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
          interruptTurn,
          respondToRuntimeRequest: Effect.fn("ClaudeAdapterV2.respondToRuntimeRequest")(
            function* (requestInput) {
              const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
                String(requestInput.requestId),
              );
              if (pending === undefined) {
                return yield* new ProviderAdapterRuntimeRequestResponseError({
                  provider: CLAUDE_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: new ProviderAdapterProtocolError({
                    provider: CLAUDE_PROVIDER,
                    detail: `No pending Claude runtime request ${requestInput.requestId}.`,
                  }),
                });
              }
              if (requestInput.decision === undefined) {
                return yield* new ProviderAdapterRuntimeRequestResponseError({
                  provider: CLAUDE_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: new ProviderAdapterProtocolError({
                    provider: CLAUDE_PROVIDER,
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
                        provider: CLAUDE_PROVIDER,
                        requestId: requestInput.requestId,
                        cause,
                      }),
                ),
              ),
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
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                provider: CLAUDE_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}

export type ClaudeAdapterV2DriverEnv = ClaudeAgentSdkQueryRunner | IdAllocatorV2 | Path.Path;

export const ClaudeAdapterV2Driver: ProviderAdapterDriver<
  ClaudeSettings,
  ClaudeAdapterV2DriverEnv
> = {
  driverKind: CLAUDE_DRIVER_KIND,
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => Schema.decodeSync(ClaudeSettings)({}),
  create: Effect.fn("ClaudeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ClaudeSettings>) {
      const { instanceId, environment, enabled, config } = input;
      const idAllocator = yield* IdAllocatorV2;
      const queryRunner = yield* ClaudeAgentSdkQueryRunner;
      const baseEnvironment = mergeProviderInstanceEnvironment(environment);
      const claudeEnvironment = yield* makeClaudeEnvironment(config, baseEnvironment);
      return makeClaudeAdapterV2({
        instanceId,
        settings: { ...config, enabled },
        environment: claudeEnvironment,
        idAllocator,
        queryRunner,
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
  const idAllocator = yield* IdAllocatorV2;
  const queryRunner = yield* ClaudeAgentSdkQueryRunner;

  return makeClaudeAdapterV2({
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    settings: Schema.decodeSync(ClaudeSettings)({}),
    environment: process.env,
    idAllocator,
    queryRunner,
  });
});

export const layer: Layer.Layer<
  ProviderAdapterV2,
  never,
  ClaudeAgentSdkQueryRunner | IdAllocatorV2
> = Layer.effect(ProviderAdapterV2, makeDefaultClaudeAdapterV2());
