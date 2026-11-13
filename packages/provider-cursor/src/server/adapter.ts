import type {
  AgentMessage,
  AgentOptions,
  InteractionUpdate,
  McpServerConfig,
  RunResult,
  SDKUserMessage,
  SettingSource,
  ToolCall,
} from "@cursor/sdk";
import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isOrchestrationV2WorkActive,
  defaultInstanceIdForDriver,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { CursorTransportFailure } from "./transportFailure.ts";
import { cursorContextWindowTokens, cursorSdkModelSelection } from "./sdkModel.ts";
import { makeCursorAdapterProjection } from "./cursorAdapterProjection.ts";
import {
  discoverCursorSkills,
  hasCursorSkillMention,
  rewriteCursorSkillMentions,
} from "./skills.ts";
import { t3OrchestrationPrompt } from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { isCursorSdkError } from "./sdk.ts";
export { cursorSdkModelSelection } from "./sdkModel.ts";

const CURSOR_DRIVER_KIND = CursorAgentSdk.CURSOR_PROVIDER;
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

function providerSession(input: {
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

function makeProviderThread(input: {
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

function nativeThreadId(providerThread: OrchestrationV2ProviderThread): string {
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
const CURSOR_AGENT_SETTING_SOURCES = [
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

class CursorModelUnavailableError extends Schema.TaggedError<CursorModelUnavailableError>()(
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
const classifyCursorModelRejection =
  (modelSelection: ModelSelection) => (error: CursorAgentSdk.CursorAgentSdkRunnerError) =>
    isCursorSdkError(error.cause, "ConfigurationError") &&
    error.cause.message.startsWith("Cannot use this model:")
      ? new CursorModelUnavailableError({ model: modelSelection.model, cause: error.cause })
      : error;


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







type CursorLsDirectoryNode = Extract<
  Extract<ToolCall, { readonly type: "ls" }>["result"],
  { readonly status: "success" }
>["value"]["directoryTreeRoot"];

function cursorLsSearchResults(
  node: CursorLsDirectoryNode,
  path: Path.Path,
): ReadonlyArray<{ readonly fileName: string }> {
  return [
    ...node.childrenFiles.map((file) => ({ fileName: path.join(node.absPath, file.name) })),
    ...node.childrenDirs.flatMap((child) => cursorLsSearchResults(child, path)),
  ];
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

function nestedArray(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function nestedLsDirectory(rawNode: unknown): CursorLsDirectoryNode {
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

export interface CursorProjectionTarget {
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerThreadId: OrchestrationV2ProviderThread["id"] | null;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"] | null;
}

// Cursor results can omit output; retain more streamed fallback than the persisted tail.

const CURSOR_RESUME_NO_PROGRESS_MESSAGE =
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

interface ActiveCursorTextSegment {
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

interface CursorLiveAgent {
  readonly nativeThreadId: string;
  readonly session: CursorAgentSdk.CursorAgentSdkSession;
}

export interface CursorAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly getModels?: () => ReadonlyArray<ServerProviderModel>;
}

export const makeCursorAdapterV2 = Effect.fn("makeCursorAdapterV2")(function* (
  options: CursorAdapterV2Options,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
  const platform = yield* HostProcess.Platform;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const adapterOptions = options;
  const apiKey = adapterOptions.environment.CURSOR_API_KEY?.trim() || undefined;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CursorAgentSdk.CURSOR_PROVIDER,
    getCapabilities: Effect.fn("CursorAdapter.getCapabilities")(function () {
      return Effect.succeed(CursorProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("CursorAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("CursorAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const createdAt = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          providerInstanceId: adapterOptions.instanceId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now: createdAt,
        });
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const liveAgent = yield* Ref.make<CursorLiveAgent | null>(null);
        // What the native conversation was told since it started or was last compacted.
        const told = yield* Ref.make<{
          readonly agent: string;
          readonly orchestration: boolean;
          readonly device: boolean;
        } | null>(null);
        const warnedUnsupportedSandbox = yield* Ref.make(false);
        const activeTurn = yield* Ref.make<ActiveCursorTurn | null>(null);
        const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());

        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const resolveItemOrdinal = (context: ActiveCursorTurn, nativeItemId: string) =>
          Effect.sync(() => {
            const existing = context.itemOrdinals.get(nativeItemId);
            if (existing !== undefined) {
              return existing;
            }
            const ordinal = context.input.providerTurnOrdinal * 100 + context.itemOrdinals.size + 1;
            context.itemOrdinals.set(nativeItemId, ordinal);
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
            driver: CursorAgentSdk.CURSOR_PROVIDER,
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

  const { emitAssistant, emitReasoning, appendTextSegment, completeAssistant, completeReasoning, emitToolArtifacts, ensureToolStarted, emitPlanArtifacts, emitTodoArtifacts, emitSubagent, handleToolUpdate, shellOutputText, handleInteractionUpdate } = yield* makeCursorAdapterProjection({ idAllocator, createdAt, emitProviderEvent, parentTarget, resolvePlanId, resolveItemOrdinal, path });
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
            driver: CursorAgentSdk.CURSOR_PROVIDER,
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
          readonly failure?: OrchestrationV2ProviderFailure;
          readonly threadDisposition?: "reusable" | "broken";
        }) {
          if (input.context.finalized) {
            return;
          }
          input.context.finalized = true;
          const completedAt = yield* DateTime.now;
          for (const tool of input.context.tools.values()) {
            yield* emitToolArtifacts({
              active: tool,
              completed: true,
              // No completion event means the tool outcome is unknown.
              unfinishedStatus: input.status === "completed" ? "interrupted" : input.status,
            });
          }
          input.context.tools.clear();
          for (const subagent of input.context.subagents.values()) {
            if (!isOrchestrationV2WorkActive(subagent.task.status)) continue;
            yield* emitSubagent({
              context: input.context,
              callId: subagent.callId,
              toolCall: subagent.toolCall,
              completed: true,
              status: input.status === "completed" ? "idle" : input.status,
            });
          }
          yield* completeReasoning(input.context);
          yield* completeAssistant(input.context);
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            providerTurn: providerTurnPayload({
              context: input.context,
              status: input.status,
              completedAt,
            }),
          });
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: CursorAgentSdk.CURSOR_PROVIDER,
            providerThread: {
              ...input.context.input.providerThread,
              providerSessionId: session.id,
              status: "active",
              firstRunOrdinal:
                input.context.input.providerThread.firstRunOrdinal ??
                input.context.input.runOrdinal,
              lastRunOrdinal: input.context.input.runOrdinal,
              updatedAt: completedAt,
            },
          });
          const threadDisposition = input.threadDisposition ?? "reusable";
          yield* emitProviderEvent(
            input.status === "failed"
              ? {
                  type: "turn.terminal",
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
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
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
                  providerThreadId: input.context.input.providerThread.id,
                  providerTurnId: input.context.providerTurnId,
                  runOrdinal: input.context.input.runOrdinal,
                  status: input.status,
                  failure: null,
                  threadDisposition,
                },
          );
          yield* Ref.update(activeTurn, (current) =>
            current?.providerTurnId === input.context.providerTurnId ? null : current,
          );
          yield* Deferred.succeed(input.context.completed, undefined);
        });

        const isResumeFailureAfterTurnEnded = (context: ActiveCursorTurn, result: RunResult) =>
          context.turnEnded &&
          result.status === "error" &&
          result.error?.message === CURSOR_RESUME_NO_PROGRESS_MESSAGE;

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
              return isResumeFailureAfterTurnEnded(context, result) ? "completed" : "failed";
          }
        };

        const openAgent = Effect.fnUntraced(function* (openInput: {
          readonly operation: "create" | "resume";
          readonly threadId: ThreadId;
          readonly modelSelection: ModelSelection;
          readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
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
          const options = makeCursorAgentOptions({
            ...(apiKey === undefined ? {} : { apiKey }),
            modelSelection: openInput.modelSelection,
            runtimePolicy: openInput.runtimePolicy,
            platform,
            threadId: openInput.threadId,
            mcpSession: yield* mcpSessions.read(openInput.threadId),
          });
          if (
            platform === "win32" &&
            openInput.runtimePolicy.sandboxPolicy === undefined &&
            openInput.runtimePolicy.runtimeMode !== "full-access" &&
            options.local?.sandboxOptions?.enabled === false &&
            !(yield* Ref.getAndSet(warnedUnsupportedSandbox, true))
          ) {
            yield* Effect.logWarning(
              "Cursor cannot sandbox the filesystem on Windows; this thread runs without filesystem isolation.",
            );
          }
          const sdkSession = yield* runner
            .open({
              operation: openInput.operation,
              ...(openInput.agentId === undefined ? {} : { agentId: openInput.agentId }),
              options,
              threadId: openInput.threadId,
              providerSessionId: input.providerSessionId,
            })
            .pipe(Effect.mapError(classifyCursorModelRejection(openInput.modelSelection)));
          const next = {
            nativeThreadId: sdkSession.agentId,
            session: sdkSession,
          } satisfies CursorLiveAgent;
          yield* Ref.set(liveAgent, next);
          return next;
        });

        let cursorSkillNames: ReadonlySet<string> | undefined;
        const resolveUserMessage = Effect.fnUntraced(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          mcpServers: Record<string, McpServerConfig> | undefined,
          hasDeviceTools: boolean,
          delivered: { readonly orchestration: boolean; readonly device: boolean },
        ) {
          const rawText = turnInput.message.text;
          if (rawText.trim() === "/compress" && turnInput.message.attachments.length === 0) {
            return "/compress";
          }
          if (hasCursorSkillMention(rawText) && cursorSkillNames === undefined) {
            const skills = yield* discoverCursorSkills(
              turnInput.runtimePolicy.cwd ?? undefined,
              adapterOptions.environment,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
            cursorSkillNames = new Set(
              skills
                .filter((skill) => skill.enabled && skill.userInvocable !== false)
                .map((skill) => skill.name),
            );
          }
          const userText = t3OrchestrationPrompt({
            prompt: yield* providerMessageTextWithAttachmentPaths({
              text:
                cursorSkillNames === undefined
                  ? rawText
                  : rewriteCursorSkillMentions(rawText, cursorSkillNames),
              attachments: turnInput.message.attachments,
              resolveAttachmentPath: host.resolveAttachmentPath,
              resolveExtractedTextPath: host.resolveExtractedTextPath,
            }),
            hasT3Mcp: mcpServers !== undefined,
            hasDeviceTools,
            orchestrationDelivered: delivered.orchestration,
            deviceInstructionsDelivered: delivered.device,
          });
          const images = yield* Effect.forEach(
            turnInput.message.attachments.filter(isProviderNativeImageAttachment),
            (attachment: ChatAttachment) =>
              Effect.gen(function* () {
                const path = host.resolveAttachmentPath(attachment);
                if (path === null) {
                  return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: CursorAgentSdk.CURSOR_PROVIDER,
                    detail: `Invalid attachment id '${attachment.id}'.`,
                  });
                }
                const bytes = yield* fileSystem.readFile(path).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterProtocolError({
                        driver: CursorAgentSdk.CURSOR_PROVIDER,
                        detail: `Failed to read attachment '${attachment.id}'.`,
                        reason: "attachment_unreadable",
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
          if (userText.length === 0 && images.length === 0) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              detail: "Cursor turn requires non-empty text or attachments.",
            });
          }
          const text = `${userText}\n\n${buildRuntimeInstructions({ harness: "Cursor", model: turnInput.modelSelection.model })}`;
          return images.length === 0
            ? text
            : ({
                text,
                images,
              } satisfies SDKUserMessage);
        });

        const startTurn = Effect.fn("CursorAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
            const current = yield* Ref.get(activeTurn);
            if (current !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                detail: `Cursor provider turn ${current.providerTurnId} is still active.`,
                reason: "previous_turn_active",
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
            const mcpSession = yield* mcpSessions.read(turnInput.threadId);
            const mcpServers = cursorMcpServers(mcpSession);
            const hasDeviceTools =
              mcpServers !== undefined && mcpSession?.capabilities?.has("device") === true;
            const known = yield* Ref.get(told);
            // A conversation this process has not sent to was told on its first run.
            const delivered =
              known?.agent === agent.nativeThreadId
                ? known
                : { orchestration: turnInput.runOrdinal > 1, device: false };
            const message = yield* resolveUserMessage(
              turnInput,
              mcpServers,
              hasDeviceTools,
              delivered,
            );
            const compacted = message === "/compress";
            const pendingUpdates: Array<InteractionUpdate> = [];
            let context: ActiveCursorTurn | null = null;
            // Create-time and send-time mcpServers merge with settingSources (SDK >= 1.0.39).
            const sdkRun = yield* agent.session
              .send({
                message,
                summarize: compacted,
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
              })
              .pipe(Effect.mapError(classifyCursorModelRejection(turnInput.modelSelection)));
            yield* Ref.set(told, {
              agent: agent.nativeThreadId,
              orchestration: !compacted && (delivered.orchestration || mcpServers !== undefined),
              device: !compacted && hasDeviceTools,
            });
            const startedAt = yield* DateTime.now;
            const completed = yield* Deferred.make<void, never>();
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              nativeTurnId: sdkRun.runId,
            });
            context = {
              input: turnInput,
              run: sdkRun,
              providerTurnId,
              startedAt,
              completed,
              itemOrdinals: new Map(),
              tools: new Map(),
              subagents: new Map(),
              assistant: {
                current: null,
                nextSegment: 0,
              },
              assistantReply: new CursorTransportFailure(),
              reasoning: {
                current: null,
                nextSegment: 0,
              },
              interrupted: false,
              finalized: false,
              turnEnded: false,
            };
            yield* Ref.set(activeTurn, context);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
              providerTurn: providerTurnPayload({
                context,
                status: "running",
                completedAt: null,
              }),
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: CursorAgentSdk.CURSOR_PROVIDER,
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
                    // A summarize run's result is the summary, not an answer.
                    !compacted &&
                    // Text from a resume that made no progress is not the turn's answer.
                    !isResumeFailureAfterTurnEnded(context, result) &&
                    result.result !== undefined &&
                    result.result.length > 0
                  ) {
                    context.assistantReply.push(result.result);
                    yield* appendTextSegment({
                      context,
                      stream: context.assistant,
                      kind: "assistant",
                      text: result.result,
                    });
                  }
                  if (context !== null && isResumeFailureAfterTurnEnded(context, result)) {
                    yield* Effect.logWarning(
                      "orchestration-v2.cursor-resume-failed-after-turn-ended",
                      {
                        providerSessionId: input.providerSessionId,
                        providerThreadId: turnInput.providerThread.id,
                        providerTurnId,
                      },
                    );
                  }
                  if (context !== null) {
                    const transportFailure = context.assistantReply.failure;
                    const status =
                      transportFailure === undefined ? terminalStatus(context, result) : "failed";
                    yield* finalizeTurn({
                      context,
                      status,
                      ...(status === "failed"
                        ? {
                            failure:
                              transportFailure === undefined
                                ? makeProviderFailure({
                                    cause: result.error,
                                    // makeProviderFailure never reads a cause's own text.
                                    message: result.error?.message,
                                    class: CursorAgentSdk.isCursorUsageLimitError(result.error)
                                      ? "usage_limit"
                                      : "provider_error",
                                  })
                                : makeProviderFailure({
                                    cause: transportFailure,
                                    class: "transport_error",
                                  }),
                          }
                        : {}),
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
                      ...(context.interrupted
                        ? {}
                        : {
                            failure: makeProviderFailure({
                              cause,
                              message: CursorAgentSdk.isCursorAgentSdkRunnerError(cause)
                                ? CursorAgentSdk.cursorSdkFailureMessage(cause)
                                : undefined,
                              class: CursorAgentSdk.isCursorUsageLimitError(cause)
                                ? "usage_limit"
                                : "transport_error",
                            }),
                          }),
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
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: CursorAgentSdk.CURSOR_PROVIDER,
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

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          driver: CursorAgentSdk.CURSOR_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          getModelContextWindow: (selection) =>
            selection.instanceId === adapterOptions.instanceId
              ? cursorContextWindowTokens(selection, adapterOptions.getModels?.() ?? [])
              : undefined,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: Effect.fn("CursorAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) {
              const opened = yield* openAgent({
                operation: "create",
                threadId: threadInput.threadId,
                modelSelection: threadInput.modelSelection,
                runtimePolicy: threadInput.runtimePolicy,
              });
              const now = yield* DateTime.now;
              return makeProviderThread({
                idAllocator,
                providerInstanceId: adapterOptions.instanceId,
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
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
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
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn,
          compactThread: (turnInput) =>
            startTurn({
              ...turnInput,
              message: { ...turnInput.message, text: "/compress" },
            }),
          steerTurn: (turnInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: turnInput.providerThread.id,
              }),
            ),
          interruptTurn: Effect.fn("CursorAdapterV2.interruptTurn")(
            function* (turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput) {
              const context = yield* Ref.get(activeTurn);
              if (context === null && turnInput.requestRuntimeRestart === true) return;
              if (context?.providerTurnId !== turnInput.providerTurnId) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
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
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                requestId: requestInput.requestId,
                cause: new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CursorAgentSdk.CURSOR_PROVIDER,
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
                        driver: CursorAgentSdk.CURSOR_PROVIDER,
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
                    new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                      driver: CursorAgentSdk.CURSOR_PROVIDER,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: (rollbackInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause: "Cursor Agent SDK does not expose conversation rollback.",
              }),
            ),
          forkThread: (forkInput) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
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
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CursorAgentSdk.CURSOR_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        ),
    ),
  });
});

export type CursorAdapterV2DriverEnv =
  | CursorAgentSdk.CursorAgentSdkRunner
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;
