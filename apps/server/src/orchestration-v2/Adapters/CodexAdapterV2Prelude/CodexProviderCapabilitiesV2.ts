import { pipe } from "effect/Function";
import { mcpToolPresentation, type McpToolPresentation } from "../../../provider/CodexToolPresentation.ts";
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { COMPUTER_USE_TOOL_SOURCE, dynamicToolSurface, dynamicToolTitle } from "@t3tools/shared/toolActivity";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import type { OrchestrationV2ExecutionNode, ModelSelection, OrchestrationV2ProviderCapabilities, OrchestrationV2ProviderTurn, OrchestrationV2PlanStep, OrchestrationV2Subagent, OrchestrationV2TurnItem, ProviderUserInputAnswers, ProviderApprovalDecision, ProviderRequestKind } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MCP_APP_EXTENSION_ID, MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_SCHEME } from "@t3tools/shared/mcpApp";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
export const CODEX_PROVIDER = ProviderDriverKind.make("codex");

export const CODEX_CAPACITY_MAX_RETRIES = 5;

export const CODEX_DRIVER_KIND = CODEX_PROVIDER;

export const CODEX_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER_KIND);

export type CodexFileChangeKinds = Readonly<
Record<string, CodexSchema.V2ItemStartedNotification__PatchChangeKind>
>;

export function codexFileChangeApprovalPrompt(input: {
readonly reason?: string | null;
readonly grantRoot?: string | null;
readonly fileChanges?: CodexFileChangeKinds;
}): string | undefined {
const reason = input.reason?.trim();
if (reason) return reason;
const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
  left.localeCompare(right),
);
if (entries.length > 0) {
  const described = entries.slice(0, 20).map(([path, change]) => {
    const movePath = change.type === "update" ? change.move_path : undefined;
    return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
  });
  const remaining = entries.length - described.length;
  return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
}
return input.grantRoot?.trim() || undefined;
}

export function canReuseCodexContextUsage(previous: ModelSelection, next: ModelSelection): boolean {
return modelSelectionsEqual(
  {
    ...previous,
    options: (previous.options ?? []).filter((option) => option.id !== "reasoningEffort"),
  },
  { ...next, options: (next.options ?? []).filter((option) => option.id !== "reasoningEffort") },
);
}

export function codexProviderTurnTokenUsage(
tokenUsage: CodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
updatedAt: string,
) {
return {
  usedTokens: Math.max(0, tokenUsage.last.totalTokens),
  maxTokens: tokenUsage.modelContextWindow ?? null,
  inputTokens: Math.max(0, tokenUsage.last.inputTokens),
  cachedInputTokens: Math.max(0, tokenUsage.last.cachedInputTokens),
  outputTokens: Math.max(0, tokenUsage.last.outputTokens),
  reasoningOutputTokens: Math.max(0, tokenUsage.last.reasoningOutputTokens),
  updatedAt,
};
}

export const CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS = 50;

export const CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS = 400;

export const CodexBackgroundTerminalTerminateResponse = Schema.Struct({
terminated: Schema.Boolean,
});

export const CodexBackgroundTerminalsListResponse = Schema.Struct({
data: Schema.Array(
  Schema.Struct({
    processId: Schema.String,
  }),
),
nextCursor: Schema.NullOr(Schema.String),
});

export type CodexBackgroundTerminalsListPage = typeof CodexBackgroundTerminalsListResponse.Type;

export const decodeCodexBackgroundTerminalTerminateResponse = Schema.decodeUnknownEffect(
CodexBackgroundTerminalTerminateResponse,
);

export const decodeCodexBackgroundTerminalsListResponse = Schema.decodeUnknownEffect(
CodexBackgroundTerminalsListResponse,
);

export const CODEX_CLIENT_CAPABILITIES = {
experimentalApi: true,
optOutNotificationMethods: ["turn/diff/updated"],
extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
} as const;

export const CodexProviderCapabilitiesV2 = {
sessions: {
  supportsMultipleProviderThreadsPerSession: true,
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
  canForkFromSubagentThread: true,
  exposesNativeThreadId: true,
},
turns: {
  exposesNativeTurnId: true,
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
  supportsApplyPatchApproval: true,
  approvalsHaveNativeRequestIds: true,
  approvalCallbacksAreLiveOnly: true,
  approvalsCanOriginateFromSubagents: true,
},
planning: {
  emitsPlanUpdated: true,
  emitsTodoList: true,
  emitsProposedPlan: true,
  supportsStructuredQuestions: true,
  planDeltasHaveItemIds: true,
},
subagents: {
  supportsSubagents: true,
  exposesSubagentThreadIds: true,
  emitsSubagentLifecycle: true,
  canWaitForSubagents: true,
  canCloseSubagents: true,
  canForkSubagentThread: true,
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
  nativeTurnIds: "strong",
  nativeItemIds: "strong",
  nativeRequestIds: "strong",
},
runtimePolicy: {
  enforcement: "native",
},
} satisfies OrchestrationV2ProviderCapabilities;

export function toProtocolError(
detail: string,
payload?: unknown,
): ProviderAdapter.ProviderAdapterProtocolError {
return new ProviderAdapter.ProviderAdapterProtocolError({
  driver: CODEX_PROVIDER,
  detail,
  ...(payload === undefined ? {} : { payload }),
});
}

export const CODEX_THREAD_IN_USE_MESSAGE =
"This conversation is open in another Codex client, such as the Codex app, the Codex CLI, or an IDE extension. Codex lets one client write to a conversation at a time. Quit that client, then send your message again.";

export const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

export function isCodexActiveWriterError(error: unknown): boolean {
return (
  isCodexAppServerRequestError(error) &&
  error.code === -32600 &&
  error.errorMessage.includes("already has an active writer")
);
}

export function codexTimestamp(seconds: number | null | undefined): DateTime.Utc {
return seconds === null || seconds === undefined
  ? DateTime.nowUnsafe()
  : DateTime.makeUnsafe(seconds * 1000);
}

export function codexUserMessageText(
content: ReadonlyArray<CodexSchema.V2ItemCompletedNotification__UserInput>,
): string {
return content
  .flatMap((item) => (item.type === "text" ? [item.text] : []))
  .join("\n")
  .trim();
}

export function mapCodexTurnStatus(
status: CodexSchema.V2TurnCompletedNotification__TurnStatus,
): OrchestrationV2ProviderTurn["status"] {
switch (status) {
  case "completed":
    return "completed";
  case "interrupted":
    return "interrupted";
  case "failed":
    return "failed";
  case "inProgress":
    return "running";
}
}

export function providerTurnStatusToTerminal(
status: OrchestrationV2ProviderTurn["status"],
): Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>["status"] {
switch (status) {
  case "completed":
    return "completed";
  case "interrupted":
    return "interrupted";
  case "failed":
    return "failed";
  case "cancelled":
    return "cancelled";
  case "pending":
  case "running":
    return "failed";
}
}

export function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
readonly node: OrchestrationV2ExecutionNode["status"];
readonly turnItem: OrchestrationV2TurnItem["status"];
readonly completed: boolean;
} {
switch (status) {
  case "inProgress":
    return { node: "running", turnItem: "running", completed: false };
  case "completed":
    return {
      node: "completed",
      turnItem: "completed",
      completed: true,
    };
  case "failed":
    return { node: "failed", turnItem: "failed", completed: true };
  case "declined":
    return {
      node: "cancelled",
      turnItem: "cancelled",
      completed: true,
    };
}
}

export function codexSkillMentionText(text: string): string {
return text.replace(SKILL_MENTION_PATTERN, "$1$$$2");
}

export const BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH = 200;

export const BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH = 1_000;

export function codexBackgroundCommandDetail(item: {
readonly command: string;
readonly exitCode?: number | null | undefined;
readonly aggregatedOutput?: string | null | undefined;
}): string {
// Codex rejects a turn/start with a lone surrogate and never answers it, so cut on code points.
let commandEnd = BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH;
const finalCommandUnit = item.command.charCodeAt(commandEnd - 1);
if (finalCommandUnit >= 0xd800 && finalCommandUnit <= 0xdbff) commandEnd -= 1;
const command =
  item.command.length > BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH
    ? `${item.command.slice(0, commandEnd)}...`
    : item.command;
const exit =
  item.exitCode === null || item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
const output = (item.aggregatedOutput ?? "").trimEnd();
let outputStart = output.length - BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH;
const firstOutputUnit = output.charCodeAt(outputStart);
if (firstOutputUnit >= 0xdc00 && firstOutputUnit <= 0xdfff) outputStart += 1;
const outputTail = outputStart > 0 ? `...${output.slice(outputStart)}` : output;
const header = `Background command completed${exit}: ${command}`;
return outputTail.length === 0 ? header : `${header}\n\nOutput tail:\n${outputTail}`;
}

export function codexNativeSubagentLabel(task: OrchestrationV2Subagent): string | undefined {
return task.title?.trim() || task.prompt.trim() || undefined;
}

export function codexNativeSubagentDetail(task: OrchestrationV2Subagent): string {
const header = `Subagent ${task.status}: ${codexNativeSubagentLabel(task) ?? task.id}`;
return task.result == null || task.result.length === 0
  ? header
  : `${header}\n\nResult:\n${task.result}`;
}

export interface CodexDynamicToolProjection extends McpToolPresentation {
readonly toolName: string;
readonly title?: string;
readonly input: unknown;
readonly output?: unknown;
readonly status: OrchestrationV2TurnItem["status"];
}

export function codexMcpToolOutput(
item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
): unknown | undefined {
const resultOutput =
  item.result === null || item.result === undefined
    ? undefined
    : item.result.structuredContent !== null && item.result.structuredContent !== undefined
      ? item.result.structuredContent
      : item.result.content;

if (item.error === null || item.error === undefined) {
  return resultOutput;
}
return resultOutput === undefined
  ? { error: item.error.message }
  : { error: item.error.message, result: resultOutput };
}

export const MCP_APP_CAPTURE_TIMEOUT = "20 seconds";

export function codexMcpAppResourceUri(item: CodexDynamicToolItem): string | undefined {
if (item.type !== "mcpToolCall") return undefined;
const uri = item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri ?? item.appContext?.resourceUri;
return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

export const CODEX_IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

export function codexDynamicToolOutput(
item: Extract<CodexDynamicToolItem, { readonly type: "dynamicToolCall" }>,
): unknown | undefined {
if (item.contentItems !== null && item.contentItems !== undefined) {
  return item.contentItems.map((content) => {
    if (content.type !== "inputImage") return content;
    const match = CODEX_IMAGE_DATA_URL.exec(content.imageUrl);
    return match?.[1] && match[2]
      ? { type: "image", mimeType: match[1].toLowerCase(), data: match[2] }
      : content;
  });
}
return item.success === false ? { success: false } : undefined;
}

export const projectCodexDynamicToolItem = Effect.fn("CodexAdapterV2.projectDynamicToolItem")(function* (
item: CodexDynamicToolItem,
): Effect.fn.Return<CodexDynamicToolProjection, never, Digest.Digest> {
const output =
  item.type === "mcpToolCall" ? codexMcpToolOutput(item) : codexDynamicToolOutput(item);
const toolName =
  item.type === "mcpToolCall"
    ? `${item.server}.${item.tool}`
    : [trimText(item.namespace), item.tool].filter(Boolean).join(".");
const presentation: McpToolPresentation =
  item.type === "mcpToolCall" ? yield* mcpToolPresentation(item) : {};
const title =
  dynamicToolTitle(toolName, item.arguments, presentation.title) ?? presentation.title;
const toolSurface = presentation.toolSurface ?? dynamicToolSurface(toolName, item.arguments);
const toolSource =
  toolSurface === "computer" && presentation.toolSource?.kind !== "computer"
    ? COMPUTER_USE_TOOL_SOURCE
    : presentation.toolSource;
const projection: CodexDynamicToolProjection = {
  ...presentation,
  ...(toolSurface ? { toolSurface } : {}),
  ...(toolSource ? { toolSource } : {}),
  toolName,
  ...(title ? { title } : {}),
  input: item.arguments,
  status: codexItemStatus(item.status).turnItem,
};
return output === undefined ? projection : { ...projection, output };
});

export function codexNativeItemRef(nativeItemId: string) {
return {
  driver: CODEX_PROVIDER,
  nativeId: nativeItemId,
  strength: "strong" as const,
};
}

export function trimText(value: string | null | undefined): string | undefined {
const trimmed = value?.trim();
return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function nonEmptyText(value: string | null | undefined, fallback: string): string {
return trimText(value) ?? fallback;
}

export function codexPlanStepStatus(
status: CodexSchema.V2TurnPlanUpdatedNotification__TurnPlanStepStatus,
): OrchestrationV2PlanStep["status"] {
switch (status) {
  case "completed":
    return "completed";
  case "inProgress":
    return "running";
  case "pending":
    return "pending";
}
}

export function approvalDecisionToLegacyReviewDecision(
decision: ProviderApprovalDecision,
): CodexSchema.ExecCommandApprovalResponse__ReviewDecision {
switch (decision) {
  case "accept":
    return "approved";
  case "acceptForSession":
  case "acceptAlways":
    return "approved_for_session";
  case "decline":
    return { denied: { rejection: "User declined the request." } };
  case "cancel":
    return "abort";
}
}

export function providerRequestKindFromPermissions(
permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ProviderRequestKind {
// Codex leaves the legacy `read`/`write` lists out when a path is a glob or
// special path, and is replacing them with `entries`.
const requests = (access: "read" | "write") =>
  (permissions.fileSystem?.[access]?.length ?? 0) > 0 ||
  permissions.fileSystem?.entries?.some((entry) => entry.access === access);
if (requests("write")) {
  return "file-change";
}
if (requests("read")) {
  return "file-read";
}
return "command";
}

export function permissionsResponseFromDecision(input: {
readonly decision: ProviderApprovalDecision;
readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
}): CodexSchema.PermissionsRequestApprovalResponse {
if (input.decision !== "accept" && input.decision !== "acceptForSession") {
  return { permissions: {}, scope: "turn" };
}

return {
  permissions: input.permissions,
  scope: input.decision === "acceptForSession" ? "session" : "turn",
};
}

export function answerValueToStrings(value: unknown): ReadonlyArray<string> {
if (Array.isArray(value)) {
  return value.map((item) => String(item));
}
if (typeof value === "string") {
  return [value];
}
if (value === null || value === undefined) {
  return [];
}
if (typeof value === "number" || typeof value === "boolean") {
  return [String(value)];
}
return [JSON.stringify(value)];
}

export function toCodexUserInputAnswers(
answers: ProviderUserInputAnswers,
allowedQuestionIds: ReadonlySet<string>,
): CodexSchema.ToolRequestUserInputResponse["answers"] {
return Object.fromEntries(
  Object.entries(answers).flatMap(([questionId, value]) =>
    allowedQuestionIds.has(questionId)
      ? [[questionId, { answers: [...answerValueToStrings(value)] }]]
      : [],
  ),
);
}

export function compactStrings(values: ReadonlyArray<string | null | undefined>): ReadonlyArray<string> {
return values.flatMap((value) => {
  const trimmed = trimText(value);
  return trimmed === undefined ? [] : [trimmed];
});
}

export function webSearchPatterns(item: CodexWebSearchItem): ReadonlyArray<string> {
if (item.action === null || item.action === undefined) {
  return compactStrings([item.query]);
}

switch (item.action.type) {
  case "search":
    return compactStrings([...(item.action.queries ?? []), item.action.query, item.query]);
  case "openPage":
    return compactStrings([item.action.url, item.query]);
  case "findInPage":
    return compactStrings([item.action.pattern, item.action.url, item.query]);
  case "other":
    return compactStrings([item.query]);
}
}

export const decodeTurnApprovalPolicy = Schema.decodeUnknownEffect(
Schema.Union([CodexSchema.V2TurnStartParams__AskForApproval, Schema.Null]),
);

export const decodeTurnSandboxPolicy = Schema.decodeUnknownEffect(
Schema.Union([CodexSchema.V2TurnStartParams__SandboxPolicy, Schema.Null]),
);

export const decodeTurnReasoningEffort = Schema.decodeUnknownEffect(
Schema.Union([CodexSchema.V2TurnStartParams__ReasoningEffort, Schema.Null]),
);

export const CodexTurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
Schema.fieldsAssign({
  collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
  additionalContext: Schema.optionalKey(
    Schema.Record(Schema.String, CodexSchema.V2TurnStartParams__AdditionalContextEntry),
  ),
}),
);

export type CodexTurnStartParamsWithCollaborationMode =
typeof CodexTurnStartParamsWithCollaborationMode.Type;

export const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
CodexTurnStartParamsWithCollaborationMode,
);

export const isProviderAdapterRuntimeRequestResponseError = Schema.is(
ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);

export type CodexWebSearchItem = {
readonly id: string;
readonly type: "webSearch";
readonly query?: string | null;
readonly action?:
  | CodexSchema.V2ItemStartedNotification__WebSearchAction
  | CodexSchema.V2ItemCompletedNotification__WebSearchAction
  | null;
};

export type CodexDynamicToolItem = Extract<
| CodexSchema.V2ItemStartedNotification__ThreadItem
| CodexSchema.V2ItemCompletedNotification__ThreadItem,
{ readonly type: "mcpToolCall" | "dynamicToolCall" }
>;
