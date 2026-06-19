import type {
  AgentMessage,
  AgentOptions,
  InteractionUpdate,
  McpServerConfig,
  ModelSelection as CursorSdkModelSelection,
  RunResult,
  SDKUserMessage,
  ToolCall,
} from "@cursor/sdk";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import {
  CursorSettings,
  defaultInstanceIdForDriver,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { cursorSdkParameterId } from "../../provider/cursorSdkModel.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
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
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "../SubagentProjection.ts";
import {
  CURSOR_PROVIDER,
  CursorAgentSdkRunner,
  type CursorAgentSdkRun,
  type CursorAgentSdkRunnerShape,
  type CursorAgentSdkSession,
} from "./CursorAgentSdk.ts";

export { CURSOR_PROVIDER } from "./CursorAgentSdk.ts";

export const CURSOR_DRIVER_KIND = ProviderDriverKind.make(CURSOR_PROVIDER);
export const CURSOR_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CURSOR_DRIVER_KIND);
const DEFAULT_CURSOR_SETTINGS = Schema.decodeSync(CursorSettings)({});

export const CursorProviderCapabilitiesV2 = {
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
    exposesNativeTurnId: true,
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
    streamsPlanText: true,
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
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
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
    nativeTurnIds: "strong",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CursorRuntimeAgentPolicy {
  readonly autoReview: boolean;
  readonly sandboxEnabled: boolean;
}

export function cursorRuntimeAgentPolicy(
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
): CursorRuntimeAgentPolicy {
  const sandboxPolicyType =
    typeof runtimePolicy.sandboxPolicy === "object" &&
    runtimePolicy.sandboxPolicy !== null &&
    "type" in runtimePolicy.sandboxPolicy &&
    typeof runtimePolicy.sandboxPolicy.type === "string"
      ? runtimePolicy.sandboxPolicy.type
      : undefined;
  return {
    autoReview:
      runtimePolicy.approvalPolicy === undefined
        ? runtimePolicy.runtimeMode === "approval-required"
        : runtimePolicy.approvalPolicy !== "never",
    sandboxEnabled:
      runtimePolicy.sandboxPolicy === undefined
        ? runtimePolicy.runtimeMode !== "full-access"
        : sandboxPolicyType !== "dangerFullAccess",
  };
}

export function cursorSdkModelSelection(modelSelection: ModelSelection): CursorSdkModelSelection {
  return {
    id: modelSelection.model === "auto" ? "default" : modelSelection.model,
    ...(modelSelection.options === undefined || modelSelection.options.length === 0
      ? {}
      : {
          params: modelSelection.options.map((option) => ({
            id: cursorSdkParameterId(option.id),
            value: String(option.value),
          })),
        }),
  };
}

export function cursorMcpServers(threadId: ThreadId): Record<string, McpServerConfig> | undefined {
  const session = McpProviderSession.readMcpProviderSession(threadId);
  if (session === undefined) {
    return undefined;
  }
  return {
    "t3-code": {
      type: "http",
      url: session.endpoint,
      headers: {
        Authorization: session.authorizationHeader,
      },
    },
  };
}

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    provider: CURSOR_PROVIDER,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: CursorProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function makeProviderThread(input: {
  readonly idAllocator: IdAllocatorV2Shape;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      provider: CURSOR_PROVIDER,
      nativeThreadId: input.nativeThreadId,
    }),
    provider: CURSOR_PROVIDER,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      provider: CURSOR_PROVIDER,
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

function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
  const id = providerThread.nativeThreadRef?.nativeId;
  if (id === null || id === undefined) {
    throw new ProviderAdapterProtocolError({
      provider: CURSOR_PROVIDER,
      detail: `Provider thread ${providerThread.id} is missing its Cursor agent id.`,
    });
  }
  return id;
}

export function makeCursorAgentOptions(input: {
  readonly apiKey?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly threadId: ThreadId;
}): AgentOptions {
  const policy = cursorRuntimeAgentPolicy(input.runtimePolicy);
  const mcpServers = cursorMcpServers(input.threadId);
  return {
    model: cursorSdkModelSelection(input.modelSelection),
    name: `T3 Code ${input.threadId}`,
    mode: input.runtimePolicy.interactionMode === "plan" ? "plan" : "agent",
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    local: {
      ...(input.runtimePolicy.cwd === null ? {} : { cwd: input.runtimePolicy.cwd }),
      autoReview: policy.autoReview,
      sandboxOptions: {
        enabled: policy.sandboxEnabled,
      },
      enableAgentRetries: true,
    },
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nestedString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    current = unknownRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

function cursorToolFailed(toolCall: ToolCall): boolean {
  if (toolCall.result?.status === "error") {
    return true;
  }
  return toolCall.type === "mcp" && toolCall.result?.status === "success"
    ? toolCall.result.value.isError
    : false;
}

function cursorToolOutput(toolCall: ToolCall): unknown {
  const result = toolCall.result;
  if (result === undefined) {
    return undefined;
  }
  return result.status === "success" ? result.value : result.error;
}

function cursorToolOutputText(toolCall: ToolCall): string {
  if (toolCall.type === "shell" && toolCall.result?.status === "success") {
    return [toolCall.result.value.stdout, toolCall.result.value.stderr]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (toolCall.type === "mcp" && toolCall.result?.status === "success") {
    return toolCall.result.value.content
      .flatMap((part) => (part.text === undefined ? [] : [part.text.text]))
      .join("\n");
  }
  const output = cursorToolOutput(toolCall);
  if (output === undefined) {
    return "";
  }
  return typeof output === "string" ? output : stableJson(output);
}

function cursorToolName(toolCall: ToolCall): string {
  if (toolCall.type !== "mcp") {
    return toolCall.type;
  }
  const provider = toolCall.args.providerIdentifier ?? "mcp";
  const tool = toolCall.args.toolName ?? "unknown";
  return `mcp__${provider}__${tool}`;
}

function cursorToolFileName(toolCall: ToolCall): string {
  switch (toolCall.type) {
    case "write":
    case "delete":
    case "read":
    case "edit":
    case "ls":
      return toolCall.args.path;
    case "generateImage":
      return toolCall.args.filePath ?? "generated-image";
    default:
      return cursorToolName(toolCall);
  }
}

function cursorToolSearchPattern(toolCall: ToolCall): string | undefined {
  switch (toolCall.type) {
    case "glob":
      return toolCall.args.globPattern;
    case "grep":
      return toolCall.args.pattern;
    case "semSearch":
      return toolCall.args.query;
    case "read":
    case "ls":
      return toolCall.args.path;
    case "readLints":
      return toolCall.args.paths.join(", ");
    default:
      return undefined;
  }
}

function cursorToolSearchResults(toolCall: ToolCall): ReadonlyArray<{
  readonly fileName: string;
  readonly line?: number;
  readonly preview?: string;
}> {
  if (toolCall.result?.status !== "success") {
    return [];
  }
  switch (toolCall.type) {
    case "read":
      return [
        {
          fileName: toolCall.args.path,
          preview: toolCall.result.value.content,
        },
      ];
    case "glob":
      return toolCall.result.value.files.map((fileName) => ({ fileName }));
    case "grep":
      return Object.values(toolCall.result.value.workspaceResults ?? {}).flatMap((result) => {
        if (result.type === "files") {
          return result.output.files.map((fileName) => ({ fileName }));
        }
        if (result.type === "count") {
          return result.output.counts.map((entry) => ({
            fileName: entry.file,
            preview: `${entry.count} matches`,
          }));
        }
        return result.output.matches.map((entry) => ({
          fileName: entry.file,
          ...(entry.lineNumber === undefined ? {} : { line: entry.lineNumber }),
          preview: entry.line,
        }));
      });
    case "semSearch":
      return [
        {
          fileName: "semantic-search",
          preview: toolCall.result.value.results,
        },
      ];
    default:
      return [];
  }
}

function cursorTodoSteps(
  toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>,
): ReadonlyArray<OrchestrationV2PlanStep> {
  const todos =
    toolCall.result?.status === "success" ? toolCall.result.value.todos : toolCall.args.todos;
  return todos
    .filter((todo) => todo.status !== "cancelled" && todo.content.trim().length > 0)
    .map((todo, index) => ({
      id: `todo-${index + 1}`,
      text: todo.content,
      status:
        todo.status === "inProgress"
          ? "running"
          : todo.status === "completed"
            ? "completed"
            : "pending",
    }));
}

function assistantTextsFromConversationSteps(steps: ReadonlyArray<unknown>): ReadonlyArray<string> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "assistantMessage") {
      const text = nestedString(record, ["message", "text"]);
      return text === undefined || text.length === 0 ? [] : [text];
    }
    const text = nestedString(record, ["assistantMessage", "text"]);
    return text === undefined || text.length === 0 ? [] : [text];
  });
}

function nestedToolResult<Value = Record<string, unknown>>(
  rawResult: unknown,
  mapSuccess: (success: Record<string, unknown>) => Value = (success) => success as Value,
):
  | { readonly status: "success"; readonly value: Value }
  | { readonly status: "error"; readonly error: unknown }
  | undefined {
  const result = unknownRecord(rawResult);
  if (result === undefined) {
    return undefined;
  }
  const success = unknownRecord(result.success);
  if (success !== undefined) {
    return {
      status: "success",
      value: mapSuccess(success),
    };
  }
  return {
    status: "error",
    error: result.error ?? result.permissionDenied ?? result,
  };
}

function nestedGrepWorkspaceResults(success: Record<string, unknown>): Record<string, unknown> {
  const workspaces = unknownRecord(success.workspaceResults);
  if (workspaces === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(workspaces).map(([workspace, rawWorkspaceResult]) => {
      const workspaceResult = unknownRecord(rawWorkspaceResult);
      const content = unknownRecord(workspaceResult?.content);
      const rawMatches = Array.isArray(content?.matches) ? content.matches : [];
      const matches = rawMatches.flatMap((rawFileMatch) => {
        const fileMatch = unknownRecord(rawFileMatch);
        const file = typeof fileMatch?.file === "string" ? fileMatch.file : "";
        const lineMatches = Array.isArray(fileMatch?.matches) ? fileMatch.matches : [];
        return lineMatches.flatMap((rawLineMatch) => {
          const lineMatch = unknownRecord(rawLineMatch);
          if (lineMatch === undefined) {
            return [];
          }
          const line = typeof lineMatch.content === "string" ? lineMatch.content : undefined;
          if (file.length === 0 || line === undefined) {
            return [];
          }
          return [
            {
              file,
              line,
              ...(typeof lineMatch.lineNumber === "number"
                ? { lineNumber: lineMatch.lineNumber }
                : {}),
            },
          ];
        });
      });
      return [
        workspace,
        {
          type: "content",
          output: {
            matches,
            totalMatches:
              typeof content?.totalMatchedLines === "number"
                ? content.totalMatchedLines
                : matches.length,
          },
        },
      ];
    }),
  );
}

function nestedToolCallFromEnvelope(
  envelope: Record<string, unknown>,
): { readonly callId: string; readonly toolCall: ToolCall } | undefined {
  const callId = typeof envelope.toolCallId === "string" ? envelope.toolCallId : undefined;
  const wrapperEntry = Object.entries(envelope).find(([key]) => key.endsWith("ToolCall"));
  if (wrapperEntry === undefined) {
    return undefined;
  }
  const [wrapperName, rawCall] = wrapperEntry;
  const call = unknownRecord(rawCall);
  if (call === undefined) {
    return undefined;
  }
  const args = unknownRecord(call.args) ?? {};
  const fallbackCallId = `nested-${wrapperName}`;
  const nestedCallId = callId ?? fallbackCallId;

  switch (wrapperName) {
    case "readToolCall": {
      const success = unknownRecord(unknownRecord(call.result)?.success);
      const path =
        typeof args.path === "string"
          ? args.path
          : typeof success?.path === "string"
            ? success.path
            : undefined;
      if (path === undefined) {
        return undefined;
      }
      return {
        callId: nestedCallId,
        toolCall: {
          type: "read",
          args: { path },
          result: nestedToolResult(call.result, (value) => ({
            content: typeof value.content === "string" ? value.content : "",
            totalLines: typeof value.totalLines === "number" ? value.totalLines : 0,
            fileSize: typeof value.fileSize === "number" ? value.fileSize : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    case "globToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "glob",
          args: {
            globPattern: typeof args.globPattern === "string" ? args.globPattern : "**/*",
            ...(typeof args.targetDirectory === "string"
              ? { targetDirectory: args.targetDirectory }
              : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            files: Array.isArray(value.files)
              ? value.files.filter((file): file is string => typeof file === "string")
              : [],
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            clientTruncated: false,
            ripgrepTruncated: false,
          })),
        } as unknown as ToolCall,
      };
    case "grepToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "grep",
          args: {
            pattern: typeof args.pattern === "string" ? args.pattern : "",
            ...(typeof args.path === "string" ? { path: args.path } : {}),
            ...(typeof args.glob === "string" ? { glob: args.glob } : {}),
            ...(typeof args.outputMode === "string" ? { outputMode: args.outputMode } : {}),
            ...(typeof args.caseInsensitive === "boolean"
              ? { caseInsensitive: args.caseInsensitive }
              : {}),
            ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
            ...(typeof args.multiline === "boolean" ? { multiline: args.multiline } : {}),
          },
          result: nestedToolResult(call.result, (value) => ({
            workspaceResults: nestedGrepWorkspaceResults(value),
          })),
        } as unknown as ToolCall,
      };
    case "shellToolCall": {
      const rawResult = unknownRecord(call.result);
      const permissionDenied = unknownRecord(rawResult?.permissionDenied);
      const command =
        typeof args.command === "string"
          ? args.command
          : typeof permissionDenied?.command === "string"
            ? permissionDenied.command
            : "<unknown command>";
      return {
        callId: nestedCallId,
        toolCall: {
          type: "shell",
          args: { command },
          result: nestedToolResult(call.result, (value) => ({
            stdout: typeof value.stdout === "string" ? value.stdout : "",
            stderr: typeof value.stderr === "string" ? value.stderr : "",
            exitCode: typeof value.exitCode === "number" ? value.exitCode : 0,
            signal: typeof value.signal === "string" ? value.signal : "",
            executionTime: typeof value.executionTime === "number" ? value.executionTime : 0,
          })),
        } as unknown as ToolCall,
      };
    }
    default: {
      const type = wrapperName.slice(0, -"ToolCall".length);
      return {
        callId: nestedCallId,
        toolCall: {
          type,
          args,
          result: nestedToolResult(call.result),
        } as unknown as ToolCall,
      };
    }
  }
}

function toolCallsFromConversationSteps(
  steps: ReadonlyArray<unknown>,
): ReadonlyArray<{ readonly callId: string; readonly toolCall: ToolCall }> {
  return steps.flatMap((step) => {
    const record = unknownRecord(step);
    if (record?.type === "toolCall") {
      const message = unknownRecord(record.message);
      return typeof message?.type === "string"
        ? [
            {
              callId: typeof record.callId === "string" ? record.callId : `nested-${message.type}`,
              toolCall: message as ToolCall,
            },
          ]
        : [];
    }
    const envelope = unknownRecord(record?.toolCall);
    const nested = envelope === undefined ? undefined : nestedToolCallFromEnvelope(envelope);
    return nested === undefined ? [] : [nested];
  });
}

function textFromAgentMessage(message: AgentMessage): string {
  const value = message.message;
  if (typeof value === "string") {
    return value;
  }
  const direct =
    nestedString(value, ["text"]) ??
    nestedString(value, ["message", "text"]) ??
    nestedString(value, ["userMessage", "text"]) ??
    nestedString(value, ["assistantMessage", "text"]);
  if (direct !== undefined) {
    return direct;
  }
  const content = unknownRecord(value)?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      const text = unknownRecord(part)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

interface CursorProjectionTarget {
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerThreadId: OrchestrationV2ProviderThread["id"] | null;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"] | null;
}

interface ActiveCursorToolCall {
  readonly callId: string;
  toolCall: ToolCall;
  readonly target: CursorProjectionTarget;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  streamedOutput: string;
}

interface ActiveCursorSubagent {
  task: OrchestrationV2Subagent;
  readonly callId: string;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  nextChildOrdinal: number;
  resultProjected: boolean;
}

interface ActiveCursorTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  text: string;
}

interface ActiveCursorTextStream {
  current: ActiveCursorTextSegment | null;
  nextSegment: number;
}

interface ActiveCursorTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly run: CursorAgentSdkRun;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void, never>;
  readonly tools: Map<string, ActiveCursorToolCall>;
  readonly subagents: Map<string, ActiveCursorSubagent>;
  readonly assistant: ActiveCursorTextStream;
  readonly reasoning: ActiveCursorTextStream;
  interrupted: boolean;
  finalized: boolean;
}

interface CursorLiveAgent {
  readonly nativeThreadId: string;
  readonly session: CursorAgentSdkSession;
}

export interface CursorAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CursorSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly runner: CursorAgentSdkRunnerShape;
  readonly serverConfig: ServerConfigShape;
}

export function makeCursorAdapterV2(
  adapterOptions: CursorAdapterV2Options,
): ProviderAdapterV2Shape {
  const { fileSystem, idAllocator, runner, serverConfig } = adapterOptions;
  const apiKey = adapterOptions.environment.CURSOR_API_KEY?.trim() || undefined;

  return ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    provider: CURSOR_PROVIDER,
    getCapabilities: () => Effect.succeed(CursorProviderCapabilitiesV2),
    openSession: Effect.fn("CursorAdapterV2.openSession")(
      function* (input: ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const createdAt = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now: createdAt,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const liveAgent = yield* Ref.make<CursorLiveAgent | null>(null);
        const activeTurn = yield* Ref.make<ActiveCursorTurn | null>(null);
        const itemOrdinals = yield* Ref.make(new Map<string, number>());
        const nextItemOrdinalsByTurn = yield* Ref.make(new Map<string, number>());
        const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());

        const emitProviderEvent = (event: ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const resolveItemOrdinal = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          nativeItemId: string,
        ) {
          const existing = (yield* Ref.get(itemOrdinals)).get(nativeItemId);
          if (existing !== undefined) {
            return existing;
          }
          const nextWithinTurn = yield* Ref.modify(nextItemOrdinalsByTurn, (current) => {
            const next = (current.get(context.run.runId) ?? 0) + 1;
            const updated = new Map(current);
            updated.set(context.run.runId, next);
            return [next, updated];
          });
          const ordinal = context.input.runOrdinal * 100 + nextWithinTurn;
          yield* Ref.update(itemOrdinals, (current) => {
            const updated = new Map(current);
            updated.set(nativeItemId, ordinal);
            return updated;
          });
          return ordinal;
        });

        const resolvePlanId = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          nativeItemId: string,
        ) {
          const existing = (yield* Ref.get(planIds)).get(nativeItemId);
          if (existing !== undefined) {
            return existing;
          }
          const planId = yield* idAllocator.allocate.plan({
            threadId: context.input.threadId,
            runId: context.input.runId,
            provider: CURSOR_PROVIDER,
          });
          yield* Ref.update(planIds, (current) => {
            const updated = new Map(current);
            updated.set(nativeItemId, planId);
            return updated;
          });
          return planId;
        });

        const parentTarget = (context: ActiveCursorTurn): CursorProjectionTarget => ({
          threadId: context.input.threadId,
          runId: context.input.runId,
          rootNodeId: context.input.rootNodeId,
          parentNodeId: context.input.rootNodeId,
          providerThreadId: context.input.providerThread.id,
          providerTurnId: context.providerTurnId,
        });

        const emitAssistant = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          completed: boolean,
        ) {
          const segment = context.assistant.current;
          if (segment === null || segment.text.length === 0) {
            return;
          }
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const messageId = idAllocator.derive.messageFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const nativeItemRef = {
            provider: CURSOR_PROVIDER,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            provider: CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "assistant_message",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "message.updated",
            provider: CURSOR_PROVIDER,
            message: {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              role: "assistant",
              text: segment.text,
              attachments: [],
              streaming: !completed,
              createdAt: segment.startedAt,
              updatedAt: now,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            provider: CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "assistant_message",
              messageId,
              text: segment.text,
              streaming: !completed,
            },
          });
        });

        const emitReasoning = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          completed: boolean,
        ) {
          const segment = context.reasoning.current;
          if (segment === null || segment.text.length === 0) {
            return;
          }
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId: segment.nativeItemId,
          });
          const nativeItemRef = {
            provider: CURSOR_PROVIDER,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            provider: CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "reasoning",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            provider: CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "reasoning",
              text: segment.text,
              streaming: !completed,
            },
          });
        });

        const appendTextSegment = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly stream: ActiveCursorTextStream;
          readonly kind: "assistant" | "reasoning";
          readonly text: string;
        }) {
          if (input.stream.current === null) {
            input.stream.nextSegment += 1;
            input.stream.current = {
              nativeItemId: `${input.kind}:${input.context.run.runId}:${input.stream.nextSegment}`,
              startedAt: yield* DateTime.now,
              text: "",
            };
          }
          input.stream.current.text += input.text;
        });

        const completeAssistant = Effect.fnUntraced(function* (context: ActiveCursorTurn) {
          if (context.assistant.current === null) {
            return;
          }
          yield* emitAssistant(context, true);
          context.assistant.current = null;
        });

        const completeReasoning = Effect.fnUntraced(function* (context: ActiveCursorTurn) {
          if (context.reasoning.current === null) {
            return;
          }
          yield* emitReasoning(context, true);
          context.reasoning.current = null;
        });

        const emitToolArtifacts = Effect.fnUntraced(function* (input: {
          readonly active: ActiveCursorToolCall;
          readonly completed: boolean;
        }) {
          const { active } = input;
          const toolCall = active.toolCall;
          const now = yield* DateTime.now;
          const failed = input.completed && cursorToolFailed(toolCall);
          const status = input.completed ? (failed ? "failed" : "completed") : "running";
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId: active.callId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId: active.callId,
          });
          const nativeItemRef = {
            provider: CURSOR_PROVIDER,
            nativeId: active.callId,
            strength: "strong" as const,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: active.target.threadId,
            runId: active.target.runId,
            parentNodeId: active.target.parentNodeId,
            rootNodeId: active.target.rootNodeId,
            kind: "tool_call",
            status,
            countsForRun: false,
            providerThreadId: active.target.providerThreadId,
            providerTurnId: active.target.providerTurnId,
            nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: active.startedAt,
            completedAt: input.completed ? now : null,
          };
          const base = {
            id: turnItemId,
            threadId: active.target.threadId,
            runId: active.target.runId,
            nodeId,
            providerThreadId: active.target.providerThreadId,
            providerTurnId: active.target.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal: active.ordinal,
            status,
            title: null,
            startedAt: active.startedAt,
            completedAt: input.completed ? now : null,
            updatedAt: now,
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
          const outputText = cursorToolOutputText(toolCall) || active.streamedOutput;
          let turnItem: OrchestrationV2TurnItem;
          switch (toolCall.type) {
            case "shell":
              turnItem = {
                ...base,
                type: "command_execution",
                input: toolCall.args.command,
                ...(outputText.length === 0 ? {} : { output: outputText }),
                ...(toolCall.result?.status === "success"
                  ? { exitCode: toolCall.result.value.exitCode }
                  : {}),
              };
              break;
            case "write":
            case "delete":
            case "edit":
            case "generateImage":
              turnItem = {
                ...base,
                type: "file_change",
                fileName: cursorToolFileName(toolCall),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.linesAdded !== undefined
                  ? { additions: toolCall.result.value.linesAdded }
                  : {}),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.linesRemoved !== undefined
                  ? { deletions: toolCall.result.value.linesRemoved }
                  : {}),
                ...(toolCall.type === "edit" &&
                toolCall.result?.status === "success" &&
                toolCall.result.value.diffString !== undefined
                  ? { diffStr: toolCall.result.value.diffString }
                  : {}),
                ...(toolCall.type === "write" ? { newStr: toolCall.args.fileText } : {}),
              };
              break;
            case "glob":
            case "grep":
            case "read":
            case "ls":
            case "readLints":
            case "semSearch": {
              const results = cursorToolSearchResults(toolCall);
              turnItem = {
                ...base,
                type: "file_search",
                ...(cursorToolSearchPattern(toolCall) === undefined
                  ? {}
                  : { pattern: cursorToolSearchPattern(toolCall) }),
                ...(results.length === 0 ? {} : { results: [...results] }),
              };
              break;
            }
            default:
              turnItem = {
                ...base,
                type: "dynamic_tool",
                toolName: cursorToolName(toolCall),
                input: toolCall.args,
                ...(cursorToolOutput(toolCall) === undefined
                  ? {}
                  : { output: cursorToolOutput(toolCall) }),
              };
          }
          yield* emitProviderEvent({
            type: "node.updated",
            provider: CURSOR_PROVIDER,
            node,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            provider: CURSOR_PROVIDER,
            turnItem,
          });
        });

        const ensureToolStarted = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          callId: string,
          toolCall: ToolCall,
        ) {
          const existing = context.tools.get(callId);
          if (existing !== undefined) {
            existing.toolCall = toolCall;
            return existing;
          }
          const startedAt = yield* DateTime.now;
          const active: ActiveCursorToolCall = {
            callId,
            toolCall,
            target: parentTarget(context),
            ordinal: yield* resolveItemOrdinal(context, callId),
            startedAt,
            streamedOutput: "",
          };
          context.tools.set(callId, active);
          yield* emitToolArtifacts({ active, completed: false });
          return active;
        });

        const emitPlanArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly markdown: string;
          readonly completed: boolean;
          readonly failed: boolean;
        }) {
          const nativeItemId = `plan:${input.callId}`;
          const now = yield* DateTime.now;
          const planId = yield* resolvePlanId(input.context, nativeItemId);
          const ordinal = yield* resolveItemOrdinal(input.context, nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId,
          });
          const status = input.failed ? "failed" : input.completed ? "completed" : "running";
          const nativeItemRef = {
            provider: CURSOR_PROVIDER,
            nativeId: input.callId,
            strength: "strong" as const,
          };
          const plan: OrchestrationV2PlanArtifact = {
            id: planId,
            threadId: input.context.input.threadId,
            runId: input.context.input.runId,
            nodeId,
            kind: "proposed_plan",
            status: input.completed ? "active" : "draft",
            markdown: input.markdown,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            provider: CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "plan",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            provider: CURSOR_PROVIDER,
            plan,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            provider: CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
              updatedAt: now,
              type: "proposed_plan",
              planId,
              markdown: input.markdown,
              streaming: !input.completed,
            },
          });
        });

        const emitTodoArtifacts = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly toolCall: Extract<ToolCall, { readonly type: "updateTodos" }>;
          readonly completed: boolean;
          readonly failed: boolean;
        }) {
          const nativeItemId = `todos:${input.callId}`;
          const now = yield* DateTime.now;
          const planId = yield* resolvePlanId(input.context, nativeItemId);
          const ordinal = yield* resolveItemOrdinal(input.context, nativeItemId);
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId,
          });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({
            provider: CURSOR_PROVIDER,
            nativeItemId,
          });
          const status = input.failed ? "failed" : input.completed ? "completed" : "running";
          const steps = cursorTodoSteps(input.toolCall);
          const nativeItemRef = {
            provider: CURSOR_PROVIDER,
            nativeId: input.callId,
            strength: "strong" as const,
          };
          yield* emitProviderEvent({
            type: "node.updated",
            provider: CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "todo_list",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            provider: CURSOR_PROVIDER,
            plan: {
              id: planId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              kind: "todo_list",
              status: input.completed ? "active" : "draft",
              steps: [...steps],
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            provider: CURSOR_PROVIDER,
            turnItem: {
              id: turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt: input.context.startedAt,
              completedAt: input.completed ? now : null,
              updatedAt: now,
              type: "todo_list",
              planId,
              steps: [...steps],
            },
          });
        });

        const emitSubagent = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly callId: string;
          readonly toolCall: Extract<ToolCall, { readonly type: "task" }>;
          readonly completed: boolean;
        }) {
          const args = input.toolCall.args;
          const result =
            input.toolCall.result?.status === "success" ? input.toolCall.result.value : undefined;
          const existing = input.context.subagents.get(input.callId);
          const now = yield* DateTime.now;
          const status: OrchestrationV2Subagent["status"] = input.completed
            ? cursorToolFailed(input.toolCall)
              ? "failed"
              : "completed"
            : "running";
          const resultText = [
            ...assistantTextsFromConversationSteps(result?.conversationSteps ?? []),
            ...(result?.resultSuffix === undefined ? [] : [result.resultSuffix]),
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n");
          const nativeItemId = input.callId;
          const nodeId =
            existing?.task.id ??
            idAllocator.derive.nodeFromProviderItem({
              provider: CURSOR_PROVIDER,
              nativeItemId,
            });
          const childRootNodeId =
            existing?.childRootNodeId ??
            idAllocator.derive.nodeFromProviderItem({
              provider: CURSOR_PROVIDER,
              nativeItemId: `${nativeItemId}:child-root`,
            });
          const childThreadId =
            existing?.childThreadId ??
            idAllocator.derive.threadFromProviderThread({
              provider: CURSOR_PROVIDER,
              nativeThreadId: `${input.context.run.runId}:task:${input.callId}`,
            });
          const task: OrchestrationV2Subagent = {
            ...(existing?.task ?? {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              origin: "provider_native" as const,
              createdBy: "agent" as const,
              provider: CURSOR_PROVIDER,
              providerThreadId: null,
              childThreadId,
              nativeTaskRef: {
                provider: CURSOR_PROVIDER,
                nativeId: input.callId,
                strength: "strong" as const,
              },
              prompt: args.prompt,
              title: args.description,
              model: args.model ?? input.context.input.modelSelection.model,
              result: null,
              startedAt: now,
            }),
            nativeTaskRef: {
              provider: CURSOR_PROVIDER,
              nativeId: input.callId,
              strength: "strong" as const,
            },
            status,
            result: resultText.length === 0 ? (existing?.task.result ?? null) : resultText,
            completedAt: input.completed ? now : null,
            updatedAt: now,
          };
          const subagent: ActiveCursorSubagent = {
            task,
            callId: input.callId,
            childThreadId,
            childRootNodeId,
            turnItemId:
              existing?.turnItemId ??
              idAllocator.derive.turnItemFromProviderItem({
                provider: CURSOR_PROVIDER,
                nativeItemId,
              }),
            turnItemOrdinal:
              existing?.turnItemOrdinal ?? (yield* resolveItemOrdinal(input.context, nativeItemId)),
            nextChildOrdinal: existing?.nextChildOrdinal ?? 100,
            resultProjected: existing?.resultProjected ?? false,
          };
          input.context.subagents.set(input.callId, subagent);

          if (existing === undefined) {
            yield* emitProviderEvent({
              type: "app_thread.created",
              provider: CURSOR_PROVIDER,
              appThread: makeSubagentChildThread({
                parentThread: input.context.input.appThread,
                childThreadId,
                parentNodeId: nodeId,
                activeProviderThreadId: null,
                providerInstanceId: input.context.input.modelSelection.instanceId,
                modelSelection: input.context.input.modelSelection,
                title: subagentThreadTitle({
                  parentTitle: input.context.input.appThread.title,
                  title: args.description,
                  prompt: args.prompt,
                  ordinal: input.context.subagents.size,
                }),
                now,
                createdBy: "agent",
                creationSource: "provider",
              }),
            });
            const promptNativeId = `${nativeItemId}:prompt`;
            const promptArtifacts = makeSubagentConversationArtifacts({
              messageId: idAllocator.derive.messageFromProviderItem({
                provider: CURSOR_PROVIDER,
                nativeItemId: promptNativeId,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                provider: CURSOR_PROVIDER,
                nativeItemId: promptNativeId,
              }),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: {
                provider: CURSOR_PROVIDER,
                nativeId: promptNativeId,
                strength: "weak",
              },
              role: "user",
              text: args.prompt,
              ordinal: 100,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              provider: CURSOR_PROVIDER,
              message: promptArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              provider: CURSOR_PROVIDER,
              turnItem: promptArtifacts.turnItem,
            });
          }

          yield* emitProviderEvent({
            type: "node.updated",
            provider: CURSOR_PROVIDER,
            node: {
              id: nodeId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              parentNodeId: input.context.input.rootNodeId,
              rootNodeId: input.context.input.rootNodeId,
              kind: "subagent",
              status,
              countsForRun: false,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: task.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            provider: CURSOR_PROVIDER,
            node: {
              id: childRootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: childRootNodeId,
              kind: "root_turn",
              status,
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: task.nativeTaskRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: task.startedAt,
              completedAt: input.completed ? now : null,
            },
          });
          yield* emitProviderEvent({
            type: "subagent.updated",
            provider: CURSOR_PROVIDER,
            subagent: task,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            provider: CURSOR_PROVIDER,
            turnItem: {
              id: subagent.turnItemId,
              threadId: input.context.input.threadId,
              runId: input.context.input.runId,
              nodeId,
              providerThreadId: input.context.input.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: task.nativeTaskRef,
              parentItemId: null,
              ordinal: subagent.turnItemOrdinal,
              status,
              title: task.title,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: task.id,
              origin: task.origin,
              provider: task.provider,
              childThreadId,
              prompt: task.prompt,
              result: task.result,
            },
          });

          if (input.completed && !subagent.resultProjected) {
            for (const [index, nestedTool] of toolCallsFromConversationSteps(
              result?.conversationSteps ?? [],
            ).entries()) {
              const callId = `${nativeItemId}:child-tool:${nestedTool.callId || index + 1}`;
              const startedAt = task.startedAt ?? now;
              const active: ActiveCursorToolCall = {
                callId,
                toolCall: nestedTool.toolCall,
                target: {
                  threadId: childThreadId,
                  runId: null,
                  rootNodeId: childRootNodeId,
                  parentNodeId: childRootNodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                },
                ordinal: ++subagent.nextChildOrdinal,
                startedAt,
                streamedOutput: "",
              };
              yield* emitToolArtifacts({ active, completed: true });
            }
            if (task.result !== null && task.result.length > 0) {
              const resultNativeId = `${nativeItemId}:result`;
              const resultArtifacts = makeSubagentConversationArtifacts({
                messageId: idAllocator.derive.messageFromProviderItem({
                  provider: CURSOR_PROVIDER,
                  nativeItemId: resultNativeId,
                }),
                turnItemId: idAllocator.derive.turnItemFromProviderItem({
                  provider: CURSOR_PROVIDER,
                  nativeItemId: resultNativeId,
                }),
                threadId: childThreadId,
                rootNodeId: childRootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: {
                  provider: CURSOR_PROVIDER,
                  nativeId: resultNativeId,
                  strength: "weak",
                },
                role: "assistant",
                text: task.result,
                ordinal: ++subagent.nextChildOrdinal,
                now,
              });
              yield* emitProviderEvent({
                type: "message.updated",
                provider: CURSOR_PROVIDER,
                message: resultArtifacts.message,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                provider: CURSOR_PROVIDER,
                turnItem: resultArtifacts.turnItem,
              });
            }
            subagent.resultProjected = true;
          }
        });

        const handleToolUpdate = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          update: Extract<
            InteractionUpdate,
            {
              readonly type: "tool-call-started" | "partial-tool-call" | "tool-call-completed";
            }
          >,
        ) {
          const completed = update.type === "tool-call-completed";
          const toolCall = update.toolCall;
          switch (toolCall.type) {
            case "createPlan":
              yield* emitPlanArtifacts({
                context,
                callId: update.callId,
                markdown: toolCall.args.plan,
                completed,
                failed: completed && cursorToolFailed(toolCall),
              });
              return;
            case "updateTodos":
              yield* emitTodoArtifacts({
                context,
                callId: update.callId,
                toolCall,
                completed,
                failed: completed && cursorToolFailed(toolCall),
              });
              return;
            case "task":
              if (update.type === "partial-tool-call") {
                return;
              }
              yield* emitSubagent({
                context,
                callId: update.callId,
                toolCall,
                completed,
              });
              return;
            default: {
              const active = yield* ensureToolStarted(context, update.callId, toolCall);
              active.toolCall = toolCall;
              if (update.type !== "tool-call-started") {
                yield* emitToolArtifacts({ active, completed });
              }
              if (completed) {
                context.tools.delete(update.callId);
              }
            }
          }
        });

        const shellOutputText = (event: Record<string, unknown>): string => {
          const candidates = [
            event.text,
            event.output,
            event.data,
            event.stdout,
            event.stderr,
            event.chunk,
          ];
          return candidates.filter((value): value is string => typeof value === "string").join("");
        };

        const handleInteractionUpdate = Effect.fnUntraced(function* (
          context: ActiveCursorTurn,
          update: InteractionUpdate,
        ) {
          if (context.finalized) {
            return;
          }
          switch (update.type) {
            case "text-delta":
              yield* completeReasoning(context);
              yield* appendTextSegment({
                context,
                stream: context.assistant,
                kind: "assistant",
                text: update.text,
              });
              yield* emitAssistant(context, false);
              return;
            case "thinking-delta":
              yield* completeAssistant(context);
              yield* appendTextSegment({
                context,
                stream: context.reasoning,
                kind: "reasoning",
                text: update.text,
              });
              yield* emitReasoning(context, false);
              return;
            case "thinking-completed":
              yield* completeReasoning(context);
              return;
            case "tool-call-started":
            case "partial-tool-call":
            case "tool-call-completed":
              yield* completeAssistant(context);
              yield* completeReasoning(context);
              yield* handleToolUpdate(context, update);
              return;
            case "step-completed":
            case "turn-ended":
              yield* completeAssistant(context);
              yield* completeReasoning(context);
              return;
            case "shell-output-delta": {
              const shell = Array.from(context.tools.values())
                .toReversed()
                .find((candidate) => candidate.toolCall.type === "shell");
              if (shell === undefined) {
                return;
              }
              shell.streamedOutput += shellOutputText(update.event);
              yield* emitToolArtifacts({ active: shell, completed: false });
              return;
            }
            default:
              return;
          }
        });

        const providerTurnPayload = (input: {
          readonly context: ActiveCursorTurn;
          readonly status: OrchestrationV2ProviderTurn["status"];
          readonly completedAt: DateTime.Utc | null;
        }): OrchestrationV2ProviderTurn => ({
          id: input.context.providerTurnId,
          providerThreadId: input.context.input.providerThread.id,
          nodeId: input.context.input.rootNodeId,
          runAttemptId: input.context.input.attemptId,
          nativeTurnRef: {
            provider: CURSOR_PROVIDER,
            nativeId: input.context.run.runId,
            strength: "strong",
          },
          ordinal: input.context.input.providerTurnOrdinal,
          status: input.status,
          startedAt: input.context.startedAt,
          completedAt: input.completedAt,
        });

        const finalizeTurn = Effect.fnUntraced(function* (input: {
          readonly context: ActiveCursorTurn;
          readonly status: Extract<
            OrchestrationV2ProviderTurn["status"],
            "completed" | "interrupted" | "failed" | "cancelled"
          >;
        }) {
          if (input.context.finalized) {
            return;
          }
          input.context.finalized = true;
          const completedAt = yield* DateTime.now;
          for (const tool of input.context.tools.values()) {
            yield* emitToolArtifacts({ active: tool, completed: true });
          }
          input.context.tools.clear();
          yield* completeReasoning(input.context);
          yield* completeAssistant(input.context);
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            provider: CURSOR_PROVIDER,
            providerTurn: providerTurnPayload({
              context: input.context,
              status: input.status,
              completedAt,
            }),
          });
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            provider: CURSOR_PROVIDER,
            providerThread: {
              ...input.context.input.providerThread,
              providerSessionId: session.id,
              status: input.status === "failed" ? "error" : "idle",
              firstRunOrdinal:
                input.context.input.providerThread.firstRunOrdinal ??
                input.context.input.runOrdinal,
              lastRunOrdinal: input.context.input.runOrdinal,
              updatedAt: completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn.terminal",
            provider: CURSOR_PROVIDER,
            providerTurnId: input.context.providerTurnId,
            status: input.status,
          });
          yield* Ref.update(activeTurn, (current) =>
            current?.providerTurnId === input.context.providerTurnId ? null : current,
          );
          yield* Deferred.succeed(input.context.completed, undefined);
        });

        const terminalStatus = (
          context: ActiveCursorTurn,
          result: RunResult,
        ): Extract<
          OrchestrationV2ProviderTurn["status"],
          "completed" | "interrupted" | "failed" | "cancelled"
        > => {
          if (context.interrupted) {
            return "interrupted";
          }
          switch (result.status) {
            case "finished":
              return "completed";
            case "cancelled":
              return "cancelled";
            case "error":
              return "failed";
          }
        };

        const openAgent = Effect.fnUntraced(function* (openInput: {
          readonly operation: "create" | "resume";
          readonly threadId: ThreadId;
          readonly modelSelection: ModelSelection;
          readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
          readonly agentId?: string;
        }) {
          const existing = yield* Ref.get(liveAgent);
          if (
            existing !== null &&
            openInput.operation === "resume" &&
            existing.nativeThreadId === openInput.agentId
          ) {
            return existing;
          }
          if (existing !== null) {
            yield* existing.session.close.pipe(Effect.ignore);
            yield* Ref.set(liveAgent, null);
          }
          const sdkSession = yield* runner.open({
            operation: openInput.operation,
            ...(openInput.agentId === undefined ? {} : { agentId: openInput.agentId }),
            options: makeCursorAgentOptions({
              ...(apiKey === undefined ? {} : { apiKey }),
              modelSelection: openInput.modelSelection,
              runtimePolicy: openInput.runtimePolicy,
              threadId: openInput.threadId,
            }),
            threadId: openInput.threadId,
            providerSessionId: input.providerSessionId,
          });
          const next = {
            nativeThreadId: sdkSession.agentId,
            session: sdkSession,
          } satisfies CursorLiveAgent;
          yield* Ref.set(liveAgent, next);
          return next;
        });

        const resolveUserMessage = Effect.fnUntraced(function* (
          turnInput: ProviderAdapterV2TurnInput,
        ) {
          const images = yield* Effect.forEach(
            turnInput.message.attachments,
            (attachment: ChatAttachment) =>
              Effect.gen(function* () {
                const path = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (path === null) {
                  return yield* new ProviderAdapterProtocolError({
                    provider: CURSOR_PROVIDER,
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(path).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterProtocolError({
                        provider: CURSOR_PROVIDER,
                        detail: `Failed to read attachment '${attachment.id}'.`,
                        payload: cause,
                      }),
                  ),
                );
                return {
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                };
              }),
            { concurrency: 1 },
          );
          if (turnInput.message.text.length === 0 && images.length === 0) {
            return yield* new ProviderAdapterProtocolError({
              provider: CURSOR_PROVIDER,
              detail: "Cursor turn requires non-empty text or attachments.",
            });
          }
          return images.length === 0
            ? turnInput.message.text
            : ({
                text: turnInput.message.text,
                images,
              } satisfies SDKUserMessage);
        });

        const startTurn = Effect.fn("CursorAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapterV2TurnInput) {
            const current = yield* Ref.get(activeTurn);
            if (current !== null) {
              return yield* new ProviderAdapterProtocolError({
                provider: CURSOR_PROVIDER,
                detail: `Cursor provider turn ${current.providerTurnId} is still active.`,
              });
            }
            const agentId = nativeThreadId(turnInput.providerThread);
            const agent = yield* openAgent({
              operation: "resume",
              agentId,
              threadId: turnInput.threadId,
              modelSelection: turnInput.modelSelection,
              runtimePolicy: turnInput.runtimePolicy,
            });
            const message = yield* resolveUserMessage(turnInput);
            const mcpServers = cursorMcpServers(turnInput.threadId);
            const pendingUpdates: Array<InteractionUpdate> = [];
            let context: ActiveCursorTurn | null = null;
            const sdkRun = yield* agent.session.send({
              message,
              options: {
                model: cursorSdkModelSelection(turnInput.modelSelection),
                mode: turnInput.runtimePolicy.interactionMode === "plan" ? "plan" : "agent",
                ...(mcpServers === undefined ? {} : { mcpServers }),
              },
              onDelta: (update) => {
                if (context === null) {
                  return Effect.sync(() => {
                    pendingUpdates.push(update);
                  });
                }
                return handleInteractionUpdate(context, update);
              },
            });
            const startedAt = yield* DateTime.now;
            const completed = yield* Deferred.make<void, never>();
            const providerTurnId = idAllocator.derive.providerTurn({
              provider: CURSOR_PROVIDER,
              nativeTurnId: sdkRun.runId,
            });
            context = {
              input: turnInput,
              run: sdkRun,
              providerTurnId,
              startedAt,
              completed,
              tools: new Map(),
              subagents: new Map(),
              assistant: {
                current: null,
                nextSegment: 0,
              },
              reasoning: {
                current: null,
                nextSegment: 0,
              },
              interrupted: false,
              finalized: false,
            };
            yield* Ref.set(activeTurn, context);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              provider: CURSOR_PROVIDER,
              providerTurn: providerTurnPayload({
                context,
                status: "running",
                completedAt: null,
              }),
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              provider: CURSOR_PROVIDER,
              providerThread: {
                ...turnInput.providerThread,
                providerSessionId: session.id,
                status: "active",
                updatedAt: startedAt,
              },
            });
            for (const update of pendingUpdates) {
              yield* handleInteractionUpdate(context, update);
            }

            yield* sdkRun.wait.pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (
                    context !== null &&
                    context.assistant.nextSegment === 0 &&
                    result.result !== undefined &&
                    result.result.length > 0
                  ) {
                    yield* appendTextSegment({
                      context,
                      stream: context.assistant,
                      kind: "assistant",
                      text: result.result,
                    });
                  }
                  if (context !== null) {
                    yield* finalizeTurn({
                      context,
                      status: terminalStatus(context, result),
                    });
                  }
                }),
              ),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (context !== null) {
                    yield* finalizeTurn({
                      context,
                      status: context.interrupted ? "interrupted" : "failed",
                    });
                  }
                  yield* Effect.logWarning("orchestration-v2.cursor-run-failed", {
                    providerSessionId: input.providerSessionId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    cause,
                  });
                }),
              ),
              Effect.forkIn(sessionScope),
            );
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterTurnStartError({
                    provider: CURSOR_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        );

        const closeSession = Effect.fnUntraced(function* () {
          const existing = yield* Ref.get(liveAgent);
          if (existing !== null) {
            yield* existing.session.close.pipe(Effect.ignore);
            yield* Ref.set(liveAgent, null);
          }
          yield* runner.assertComplete.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.cursor-runner-incomplete", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        });
        yield* Effect.addFinalizer(() => closeSession());

        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          provider: CURSOR_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          rawEvents: Stream.empty,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: Effect.fn("CursorAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapterV2EnsureThreadInput) {
              const opened = yield* openAgent({
                operation: "create",
                threadId: threadInput.threadId,
                modelSelection: threadInput.modelSelection,
                runtimePolicy: threadInput.runtimePolicy,
              });
              const now = yield* DateTime.now;
              return makeProviderThread({
                idAllocator,
                appThreadId: threadInput.threadId,
                providerSessionId: input.providerSessionId,
                nativeThreadId: opened.nativeThreadId,
                now,
              });
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterEnsureThreadError({
                      provider: CURSOR_PROVIDER,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("CursorAdapterV2.resumeThread")(
            function* (threadInput: { readonly providerThread: OrchestrationV2ProviderThread }) {
              const agentId = nativeThreadId(threadInput.providerThread);
              yield* openAgent({
                operation: "resume",
                agentId,
                threadId: threadInput.providerThread.appThreadId ?? input.threadId,
                modelSelection: input.modelSelection,
                runtimePolicy: input.runtimePolicy,
              });
              const now = yield* DateTime.now;
              return {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                status: "idle" as const,
                updatedAt: now,
              };
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterResumeThreadError({
                      provider: CURSOR_PROVIDER,
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
                provider: CURSOR_PROVIDER,
                providerThreadId: turnInput.providerThread.id,
              }),
            ),
          interruptTurn: Effect.fn("CursorAdapterV2.interruptTurn")(
            function* (turnInput: ProviderAdapterV2InterruptInput) {
              const context = yield* Ref.get(activeTurn);
              if (context?.providerTurnId !== turnInput.providerTurnId) {
                return yield* new ProviderAdapterProtocolError({
                  provider: CURSOR_PROVIDER,
                  detail: `Cursor provider turn ${turnInput.providerTurnId} is not active.`,
                });
              }
              context.interrupted = true;
              yield* context.run.cancel;
              const stopped = yield* Deferred.await(context.completed).pipe(
                Effect.timeoutOption("10 seconds"),
              );
              if (Option.isSome(stopped)) {
                return;
              }
              yield* Effect.logWarning("orchestration-v2.cursor-interrupt-timeout", {
                providerSessionId: input.providerSessionId,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId: turnInput.providerTurnId,
              });
              yield* finalizeTurn({ context, status: "interrupted" });
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterInterruptError({
                      provider: CURSOR_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.fail(
              new ProviderAdapterRuntimeRequestResponseError({
                provider: CURSOR_PROVIDER,
                requestId: requestInput.requestId,
                cause: new ProviderAdapterProtocolError({
                  provider: CURSOR_PROVIDER,
                  detail: "Cursor Agent SDK does not expose interactive approval requests.",
                }),
              }),
            ),
          readThreadSnapshot: Effect.fn("CursorAdapterV2.readThreadSnapshot")(
            function* (snapshotInput) {
              const requestedAgentId = nativeThreadId(snapshotInput.providerThread);
              const agent = yield* openAgent({
                operation: "resume",
                agentId: requestedAgentId,
                threadId: snapshotInput.providerThread.appThreadId ?? input.threadId,
                modelSelection: input.modelSelection,
                runtimePolicy: input.runtimePolicy,
              });
              const messages = yield* agent.session.listMessages;
              const now = yield* DateTime.now;
              const threadId = snapshotInput.providerThread.appThreadId ?? input.threadId;
              const projectedMessages: Array<OrchestrationV2ConversationMessage> = messages.flatMap(
                (message) => {
                  const text = textFromAgentMessage(message);
                  if (text.length === 0) {
                    return [];
                  }
                  return [
                    {
                      createdBy: message.type === "user" ? "user" : "agent",
                      creationSource: "provider",
                      id: idAllocator.derive.messageFromProviderItem({
                        provider: CURSOR_PROVIDER,
                        nativeItemId: message.uuid,
                      }),
                      threadId,
                      runId: null,
                      nodeId: null,
                      role: message.type,
                      text,
                      attachments: [],
                      streaming: false,
                      createdAt: now,
                      updatedAt: now,
                    },
                  ];
                },
              );
              return {
                providerThread: {
                  ...snapshotInput.providerThread,
                  providerSessionId: input.providerSessionId,
                  status: "idle" as const,
                  updatedAt: now,
                },
                providerTurns: [],
                messages: projectedMessages,
                runtimeRequests: [],
                providerPayload: {
                  agentId: requestedAgentId,
                  messages,
                },
              };
            },
            (effect, snapshotInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterReadThreadSnapshotError({
                      provider: CURSOR_PROVIDER,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: (rollbackInput) =>
            Effect.fail(
              new ProviderAdapterRollbackThreadError({
                provider: CURSOR_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause: "Cursor Agent SDK does not expose conversation rollback.",
              }),
            ),
          forkThread: (forkInput) =>
            Effect.fail(
              new ProviderAdapterForkThreadError({
                provider: CURSOR_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause: "Cursor Agent SDK does not expose native agent forks.",
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
                provider: CURSOR_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
}

export type CursorAdapterV2DriverEnv =
  | CursorAgentSdkRunner
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ServerConfig;

export const CursorAdapterV2Driver: ProviderAdapterDriver<
  CursorSettings,
  CursorAdapterV2DriverEnv
> = {
  driverKind: CURSOR_DRIVER_KIND,
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => DEFAULT_CURSOR_SETTINGS,
  create: Effect.fn("CursorAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CursorSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const runner = yield* CursorAgentSdkRunner;
      const serverConfig = yield* ServerConfig;
      if (input.config.apiEndpoint.length > 0) {
        yield* Effect.logWarning(
          "Cursor V2 uses the official SDK, which does not expose an API endpoint override.",
          {
            instanceId: input.instanceId,
          },
        );
      }
      return makeCursorAdapterV2({
        instanceId: input.instanceId,
        settings: {
          ...input.config,
          enabled: input.enabled,
        },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        fileSystem,
        idAllocator,
        runner,
        serverConfig,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: CURSOR_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Cursor Agent SDK adapter.",
              cause,
            }),
        ),
      ),
  ),
};

export const layer: Layer.Layer<
  ProviderAdapterV2,
  never,
  CursorAgentSdkRunner | FileSystem.FileSystem | IdAllocatorV2 | ServerConfig
> = Layer.effect(
  ProviderAdapterV2,
  Effect.gen(function* () {
    const hostEnvironment = yield* HostProcessEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocatorV2;
    const runner = yield* CursorAgentSdkRunner;
    const serverConfig = yield* ServerConfig;
    return makeCursorAdapterV2({
      instanceId: CURSOR_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CURSOR_SETTINGS,
      environment: hostEnvironment,
      fileSystem,
      idAllocator,
      runner,
      serverConfig,
    });
  }),
);
