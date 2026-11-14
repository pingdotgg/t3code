import type {
  AgentMessage,
  AgentOptions,
  McpServerConfig,
  SettingSource,
  ToolCall,
} from "@cursor/sdk";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { CursorTransportFailure } from "./transportFailure.ts";
import { cursorSdkModelSelection } from "./sdkModel.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { isCursorSdkError } from "./sdk.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { ServerProviderModel } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
export { cursorSdkModelSelection } from "./sdkModel.ts";

export const CURSOR_DRIVER_KIND = CursorAgentSdk.CURSOR_PROVIDER;
export const CURSOR_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CURSOR_DRIVER_KIND);

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
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CursorRuntimeAgentPolicy {
  readonly autoReview: boolean;
  readonly sandboxEnabled: boolean;
}

export function cursorRuntimeAgentPolicy(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  platform: NodeJS.Platform,
): CursorRuntimeAgentPolicy {
  const sandboxPolicyType =
    typeof runtimePolicy.sandboxPolicy === "object" &&
    runtimePolicy.sandboxPolicy !== null &&
    "type" in runtimePolicy.sandboxPolicy &&
    typeof runtimePolicy.sandboxPolicy.type === "string"
      ? runtimePolicy.sandboxPolicy.type
      : undefined;
  const autoReview =
    runtimePolicy.approvalPolicy === undefined
      ? runtimePolicy.runtimeMode === "approval-required" || runtimePolicy.runtimeMode === "auto"
      : runtimePolicy.approvalPolicy !== "never";
  return {
    autoReview,
    // The Windows SDK has no filesystem sandbox; omit the default only when
    // Auto-review still gates execution. Explicit policies remain authoritative.
    sandboxEnabled:
      runtimePolicy.sandboxPolicy === undefined
        ? runtimePolicy.runtimeMode !== "full-access" && !(platform === "win32" && autoReview)
        : sandboxPolicyType !== "dangerFullAccess",
  };
}

export function cursorMcpServers(
  session: McpProviderSession.McpProviderSessionConfig | undefined,
): Record<string, McpServerConfig> | undefined {
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

export function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: CursorProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

export function makeProviderThread(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: CursorAgentSdk.CURSOR_PROVIDER,
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

export function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
  const id = providerThread.nativeThreadRef?.nativeId;
  if (id === null || id === undefined) {
    throw new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CursorAgentSdk.CURSOR_PROVIDER,
      detail: `Provider thread ${providerThread.id} is missing its Cursor agent id.`,
    });
  }
  return id;
}

/** The SDK loads no CLI settings unless `settingSources` is supplied. */
export const CURSOR_AGENT_SETTING_SOURCES = [
  "project",
  "user",
  "team",
  "mdm",
  "plugins",
] as const satisfies ReadonlyArray<SettingSource>;

export function makeCursorAgentOptions(input: {
  readonly apiKey?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly threadId: ThreadId;
  readonly mcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
  readonly platform: NodeJS.Platform;
}): AgentOptions {
  const policy = cursorRuntimeAgentPolicy(input.runtimePolicy, input.platform);
  const mcpServers = cursorMcpServers(input.mcpSession);
  return {
    model: cursorSdkModelSelection(input.modelSelection),
    name: `T3 Code ${input.threadId}`,
    mode: input.runtimePolicy.interactionMode === "plan" ? "plan" : "agent",
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    local: {
      ...(input.runtimePolicy.cwd === null ? {} : { cwd: input.runtimePolicy.cwd }),
      autoReview: policy.autoReview,
      settingSources: [...CURSOR_AGENT_SETTING_SOURCES],
      sandboxOptions: {
        enabled: policy.sandboxEnabled,
      },
      enableAgentRetries: true,
    },
    ...(mcpServers === undefined ? {} : { mcpServers }),
  };
}

export class CursorModelUnavailableError extends Schema.TaggedError<CursorModelUnavailableError>()(
  "CursorModelUnavailableError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Cursor cannot run the model "${this.model}". Cursor only runs models from your Cursor account. Choose one of those, or use OpenCode for OpenRouter and other API-key models.`;
  }
}

// Uncoded SDK model rejections are identifiable only by message prefix.
export const classifyCursorModelRejection =
  (modelSelection: ModelSelection) => (error: CursorAgentSdk.CursorAgentSdkRunnerError) =>
    isCursorSdkError(error.cause, "ConfigurationError") &&
    error.cause.message.startsWith("Cannot use this model:")
      ? new CursorModelUnavailableError({ model: modelSelection.model, cause: error.cause })
      : error;

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function nestedString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    current = unknownRecord(current)?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

export type CursorLsDirectoryNode = Extract<
  Extract<ToolCall, { readonly type: "ls" }>["result"],
  { readonly status: "success" }
>["value"]["directoryTreeRoot"];

export function cursorLsSearchResults(
  node: CursorLsDirectoryNode,
  path: Path.Path,
): ReadonlyArray<{ readonly fileName: string }> {
  return [
    ...node.childrenFiles.map((file) => ({ fileName: path.join(node.absPath, file.name) })),
    ...node.childrenDirs.flatMap((child) => cursorLsSearchResults(child, path)),
  ];
}

export function nestedToolResult<Value = Record<string, unknown>>(
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

export function nestedGrepWorkspaceResults(
  success: Record<string, unknown>,
): Record<string, unknown> {
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

export function nestedArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

export function nestedLsDirectory(rawNode: unknown): CursorLsDirectoryNode {
  const node = unknownRecord(rawNode);
  return {
    absPath: typeof node?.absPath === "string" ? node.absPath : "",
    childrenDirs: nestedArray(node?.childrenDirs).map(nestedLsDirectory),
    childrenFiles: nestedArray(node?.childrenFiles).flatMap((rawFile) => {
      const name = unknownRecord(rawFile)?.name;
      return typeof name === "string" ? [{ name }] : [];
    }),
    childrenWereProcessed: node?.childrenWereProcessed === true,
    fullSubtreeExtensionCounts: Object.fromEntries(
      Object.entries(unknownRecord(node?.fullSubtreeExtensionCounts) ?? {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    ),
    numFiles: typeof node?.numFiles === "number" ? node.numFiles : 0,
  };
}

export function nestedToolCallFromEnvelope(
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
            : "<unknown path>";
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
    case "lsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "ls",
          args: { path: typeof args.path === "string" ? args.path : "" },
          result: nestedToolResult(call.result, (value) => ({
            directoryTreeRoot: nestedLsDirectory(value.directoryTreeRoot),
          })),
        } as unknown as ToolCall,
      };
    case "readLintsToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "readLints",
          args: {
            paths: nestedArray(args.paths).filter(
              (path): path is string => typeof path === "string",
            ),
          },
          result: nestedToolResult(call.result, (value) => ({
            fileDiagnostics: nestedArray(value.fileDiagnostics).map((rawFile) => {
              const file = unknownRecord(rawFile);
              return {
                path: typeof file?.path === "string" ? file.path : "",
                diagnostics: nestedArray(file?.diagnostics).flatMap((rawDiagnostic) => {
                  const diagnostic = unknownRecord(rawDiagnostic);
                  return diagnostic === undefined
                    ? []
                    : [
                        {
                          ...diagnostic,
                          message: typeof diagnostic.message === "string" ? diagnostic.message : "",
                        },
                      ];
                }),
              };
            }),
            totalFiles: typeof value.totalFiles === "number" ? value.totalFiles : 0,
            totalDiagnostics:
              typeof value.totalDiagnostics === "number" ? value.totalDiagnostics : 0,
          })),
        } as unknown as ToolCall,
      };
    case "mcpToolCall":
      return {
        callId: nestedCallId,
        toolCall: {
          type: "mcp",
          args,
          result: nestedToolResult(call.result, (value) => ({
            content: nestedArray(value.content).flatMap((rawPart) => {
              const part = unknownRecord(rawPart);
              return part === undefined ? [] : [part];
            }),
            isError: value.isError === true,
          })),
        } as unknown as ToolCall,
      };
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

export function textFromAgentMessage(message: AgentMessage): string {
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

export interface CursorProjectionTarget {
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerThreadId: OrchestrationV2ProviderThread["id"] | null;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"] | null;
}

// Cursor results can omit output; retain more streamed fallback than the persisted tail.

export const CURSOR_RESUME_NO_PROGRESS_MESSAGE =
  "Agent turn stopped after repeated resume attempts made no progress";

export interface ActiveCursorToolCall {
  readonly callId: string;
  toolCall: ToolCall;
  readonly target: CursorProjectionTarget;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  streamedOutput: string;
}

export interface ActiveCursorSubagent {
  task: OrchestrationV2Subagent;
  toolCall: Extract<ToolCall, { readonly type: "task" }>;
  readonly callId: string;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  nextChildOrdinal: number;
  resultProjected: boolean;
}

export interface ActiveCursorTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  text: string;
}

export interface ActiveCursorTextStream {
  current: ActiveCursorTextSegment | null;
  nextSegment: number;
}

export interface ActiveCursorTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly run: CursorAgentSdk.CursorAgentSdkRun;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void, never>;
  readonly itemOrdinals: Map<string, number>;
  readonly tools: Map<string, ActiveCursorToolCall>;
  readonly subagents: Map<string, ActiveCursorSubagent>;
  readonly assistant: ActiveCursorTextStream;
  assistantReply: CursorTransportFailure;
  readonly reasoning: ActiveCursorTextStream;
  interrupted: boolean;
  finalized: boolean;
  /** The agent's latest turn ended and no new work has started since. */
  turnEnded: boolean;
}

export interface CursorLiveAgent {
  readonly nativeThreadId: string;
  readonly session: CursorAgentSdk.CursorAgentSdkSession;
}

export interface CursorAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly getModels?: () => ReadonlyArray<ServerProviderModel>;
}

export type CursorAdapterV2DriverEnv =
  | CursorAgentSdk.CursorAgentSdkRunner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;
