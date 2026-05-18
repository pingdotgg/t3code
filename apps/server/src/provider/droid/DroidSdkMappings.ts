import {
  AutonomyLevel,
  type AskUserRequestParams,
  type AskUserResult,
  type ContentBlock,
  DroidInteractionMode,
  ReasoningEffort,
  ToolConfirmationOutcome,
  ToolConfirmationType,
  type RequestPermissionRequestParams,
  type TokenUsageUpdate,
} from "@factory/droid-sdk";
import type {
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderSessionStartInput,
  ProviderUserInputAnswers,
  ThreadTokenUsageSnapshot,
  ToolLifecycleItemType,
  UserInputQuestion,
} from "@t3tools/contracts";

export { DroidInteractionMode };

export function toModelId(model: string | undefined): string | undefined {
  return !model || model === "default" ? undefined : model;
}

export function toReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  switch (value) {
    case "none":
      return ReasoningEffort.None;
    case "dynamic":
      return ReasoningEffort.Dynamic;
    case "off":
      return ReasoningEffort.Off;
    case "minimal":
      return ReasoningEffort.Minimal;
    case "low":
      return ReasoningEffort.Low;
    case "medium":
      return ReasoningEffort.Medium;
    case "high":
      return ReasoningEffort.High;
    case "xhigh":
      return ReasoningEffort.ExtraHigh;
    case "max":
      return ReasoningEffort.Max;
    default:
      return undefined;
  }
}

export function toAutonomyLevel(input: ProviderSessionStartInput): AutonomyLevel {
  switch (input.runtimeMode) {
    case "approval-required":
      return AutonomyLevel.Off;
    case "auto-accept-edits":
      return AutonomyLevel.Low;
    case "medium-access":
      return AutonomyLevel.Medium;
    case "full-access":
      return AutonomyLevel.High;
  }
}

export function contentBlockText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "thinking") return block.thinking;
  return "";
}

export function toRequestType(params: RequestPermissionRequestParams): CanonicalRequestType {
  const type = params.toolUses[0]?.confirmationType;
  switch (type) {
    case ToolConfirmationType.Execute:
      return "command_execution_approval";
    case ToolConfirmationType.Edit:
    case ToolConfirmationType.Create:
    case ToolConfirmationType.ApplyPatch:
      return "file_change_approval";
    case ToolConfirmationType.McpTool:
      return "dynamic_tool_call";
    case ToolConfirmationType.AskUser:
      return "tool_user_input";
    default:
      return "unknown";
  }
}

export function toToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("exec") ||
    normalized.includes("bash") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

export function permissionDetail(params: RequestPermissionRequestParams): string {
  const first = params.toolUses[0];
  if (!first) return "Droid requested permission.";
  const details = first.details;
  switch (details.type) {
    case ToolConfirmationType.Execute:
      return details.fullCommand;
    case ToolConfirmationType.Edit:
    case ToolConfirmationType.Create:
    case ToolConfirmationType.ApplyPatch:
      return "filePath" in details ? details.filePath : "Droid requested a file change.";
    case ToolConfirmationType.McpTool:
      return details.toolName;
    default:
      return first.toolUse.name;
  }
}

export function normalizeAskUserQuestions(
  params: AskUserRequestParams,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question, index) => ({
    id: `question-${question.index ?? index}`,
    header: question.topic || `Question ${index + 1}`,
    question: question.question,
    options: question.options.map((option) => ({
      label: option,
      description: option,
    })),
  }));
}

function answerString(value: unknown): string {
  if (Array.isArray(value)) return value.map(answerString).join(", ");
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

export function toAskUserResult(
  questions: AskUserRequestParams["questions"],
  answers: ProviderUserInputAnswers,
): AskUserResult {
  return {
    answers: questions.map((question, index) => ({
      index: question.index,
      question: question.question,
      answer: answerString(
        answers[`question-${question.index ?? index}`] ?? answers[question.question],
      ),
    })),
  };
}

export function toOutcome(decision: ProviderApprovalDecision): ToolConfirmationOutcome {
  switch (decision) {
    case "accept":
      return ToolConfirmationOutcome.ProceedOnce;
    case "acceptForSession":
      return ToolConfirmationOutcome.ProceedAlways;
    case "decline":
    case "cancel":
      return ToolConfirmationOutcome.Cancel;
  }
}

export function toTokenUsageSnapshot(
  usage: TokenUsageUpdate,
  previous?: ThreadTokenUsageSnapshot,
  turnBaseline?: ThreadTokenUsageSnapshot,
): ThreadTokenUsageSnapshot {
  const inputDelta = usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
  const outputDelta = usage.outputTokens + usage.thinkingTokens;
  const cachedInputDelta = usage.cacheReadTokens;
  const reasoningOutputDelta = usage.thinkingTokens;
  const inputTokens = (previous?.inputTokens ?? 0) + inputDelta;
  const cachedInputTokens = (previous?.cachedInputTokens ?? 0) + cachedInputDelta;
  const outputTokens = (previous?.outputTokens ?? 0) + outputDelta;
  const reasoningOutputTokens = (previous?.reasoningOutputTokens ?? 0) + reasoningOutputDelta;
  const lastInputTokens = inputTokens - (turnBaseline?.inputTokens ?? 0);
  const lastCachedInputTokens = cachedInputTokens - (turnBaseline?.cachedInputTokens ?? 0);
  const lastOutputTokens = outputTokens - (turnBaseline?.outputTokens ?? 0);
  const lastReasoningOutputTokens =
    reasoningOutputTokens - (turnBaseline?.reasoningOutputTokens ?? 0);
  return {
    usedTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    lastUsedTokens: lastInputTokens + lastOutputTokens,
    lastInputTokens,
    lastCachedInputTokens,
    lastOutputTokens,
    lastReasoningOutputTokens,
  };
}
