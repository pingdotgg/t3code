import type {
  OrchestrationV2GoalCommand,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2PlanStep,
  OrchestrationV2ProviderGoal,
  OrchestrationV2ProviderTurnTokenUsage,
  RuntimeMode,
  ServerProviderModel,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { array, record, string } from "./rpc.ts";

export const ompRuntimeModes = ["approval-required", "full-access"] as const;

export function ompApprovalMode(mode: RuntimeMode) {
  switch (mode) {
    case "approval-required":
      return "always-ask";
    case "full-access":
      return "yolo";
    default:
      return undefined;
  }
}

export const ompCapabilities = {
  runtimePolicy: { enforcement: "client-boundary" },
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
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsNativeResume: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    supportsNativeGoals: true,
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
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export function goalRequest(command: OrchestrationV2GoalCommand) {
  switch (command.type) {
    case "show":
      return { type: "goal", op: "get" };
    case "clear":
      return { type: "goal", op: "drop" };
    case "pause":
      return { type: "goal", op: "pause" };
    case "resume":
      return { type: "goal", op: "resume" };
    case "set": {
      if (/^show$/iu.test(command.objective)) return { type: "goal", op: "get" };
      if (/^drop$/iu.test(command.objective)) return { type: "goal", op: "drop" };
      const input = command.objective.replace(/^set\s+/iu, "");
      const budget = /^--budget\s+([0-9]+)\s+([\s\S]+)$/u.exec(input);
      return budget
        ? { type: "goal", op: "create", objective: budget[2], token_budget: Number(budget[1]) }
        : { type: "goal", op: "create", objective: input };
    }
  }
}

function counter(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function readTokenUsage(
  stats: unknown,
  messageUsage: unknown,
  updatedAt: string,
): OrchestrationV2ProviderTurnTokenUsage | undefined {
  const context = record(record(stats).contextUsage);
  const usedTokens = counter(context.tokens);
  const maxTokens = counter(context.contextWindow);
  if (usedTokens === undefined || !maxTokens) return undefined;
  const usage = record(messageUsage);
  const inputTokens = counter(usage.input);
  const cachedInputTokens = counter(usage.cacheRead);
  const outputTokens = counter(usage.output);
  const reasoningOutputTokens = counter(usage.reasoningTokens);
  return {
    usedTokens,
    maxTokens,
    updatedAt,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
  };
}

export function readGoal(value: unknown): OrchestrationV2ProviderGoal | null {
  const goal = record(value);
  const objective = string(goal.objective)?.trim();
  const status =
    goal.status === "completed" ? "complete" : string(goal.status)?.replaceAll("-", "_");
  if (
    !objective ||
    (status !== "active" &&
      status !== "paused" &&
      status !== "complete" &&
      status !== "blocked" &&
      status !== "budget_limited" &&
      status !== "usage_limited")
  )
    return null;
  const tokensUsed = counter(goal.tokensUsed);
  const tokenBudget = counter(goal.tokenBudget);
  const timeUsedSeconds = counter(goal.timeUsedSeconds);
  return {
    objective,
    status,
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(timeUsedSeconds === undefined ? {} : { timeUsedSeconds }),
  };
}

export function modelSlug(value: unknown) {
  const model = record(value);
  const provider = string(model.provider)?.trim();
  const id = string(model.id)?.trim();
  return provider && id ? `${provider}/${id}` : undefined;
}

export function readModels(payload: unknown): ReadonlyArray<ServerProviderModel> {
  const models = new Map<string, ServerProviderModel>();
  for (const value of array(record(payload).models)) {
    const model = record(value);
    const slug = modelSlug(model);
    if (!slug) continue;
    const levels = array(model.thinking).filter(
      (level): level is string => typeof level === "string" && level.trim() !== "",
    );
    models.set(slug, {
      slug,
      name: string(model.name)?.trim() || slug,
      isCustom: false,
      capabilities:
        levels.length === 0
          ? null
          : {
              optionDescriptors: [
                {
                  id: "thinking",
                  label: "Reasoning effort",
                  role: "reasoning",
                  type: "select",
                  // The passive catalog lists concrete efforts. OMP also accepts its per-turn Auto selector.
                  options: [...new Set(["off", "auto", ...levels])].map((id) => ({
                    id,
                    label: id,
                  })),
                },
              ],
            },
    });
  }
  return [...models.values()];
}

export const ompLocalCommands = [
  { name: "omp:subagents", description: "List running Oh My Pi subagents and their task IDs" },
  {
    name: "omp:subagent-log",
    description: "Read a subagent transcript from this Oh My Pi session",
    input: { hint: "<task ID> [byte offset]" },
  },
  {
    name: "omp:subagent-steer",
    description: "Send a message to a running Oh My Pi subagent using Steer now",
    input: { hint: "<task ID> <message>" },
  },
  {
    name: "omp:btw",
    description: "Ask a side question without changing the main Oh My Pi conversation",
    input: { hint: "<question>" },
  },
  {
    name: "omp:btw-follow-up",
    description: "Continue an Oh My Pi side question",
    input: { hint: "<topic ID> <question>" },
  },
  { name: "omp:btw-history", description: "Show Oh My Pi side-question topics and answers" },
] satisfies ReadonlyArray<ServerProviderSlashCommand>;

export function readSideQuestionCommand(text: string) {
  const input = text.trim();
  const match = /^\/omp:btw(?:\s+([\s\S]+))?$/iu.exec(input);
  if (match) return { type: "btw", question: match[1] ?? "" } as const;
  const followUp = /^\/omp:btw-follow-up(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/iu.exec(input);
  if (followUp) return { type: "btw", recordId: followUp[1], question: followUp[2] ?? "" } as const;
  if (/^\/omp:btw-history$/iu.test(input)) return { type: "get_btw_history" } as const;
  return undefined;
}

export function readSubagentCommand(text: string) {
  const match = /^\/omp:subagent(s|-log|-steer)(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return undefined;
  const [, kind, args = ""] = match;
  if (kind?.toLowerCase() === "s" && !args) return { type: "get_subagents" } as const;
  const selector = /^([\w.-]{1,256})(?:\s+([\s\S]+))?$/u.exec(args);
  if (selector?.[1] && kind?.toLowerCase() === "-log") {
    const cursor = selector[2];
    const fromByte = cursor === undefined ? 0 : Number(cursor);
    if ((cursor === undefined || /^\d+$/u.test(cursor)) && Number.isSafeInteger(fromByte)) {
      return { type: "get_subagent_messages", subagentId: selector[1], fromByte } as const;
    }
  }
  if (selector?.[1] && selector[2] && kind?.toLowerCase() === "-steer") {
    return { type: "steer_subagent", subagentId: selector[1], message: selector[2] } as const;
  }
  return { type: "invalid_subagent_command" } as const;
}

export function readSlashCommands(value: unknown): ReadonlyArray<ServerProviderSlashCommand> {
  const commands = new Map<string, ServerProviderSlashCommand>();
  for (const entry of array(value)) {
    const command = record(entry);
    const name = string(command.name)?.trim();
    if (!name || !/^[\w:.-]+$/u.test(name) || name === "security") continue;
    const description = string(command.description)?.trim();
    const hint = string(record(command.input).hint)?.trim();
    commands.set(name, {
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return [...commands.values()];
}

export function readTodoSteps(value: unknown): ReadonlyArray<OrchestrationV2PlanStep> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry, phaseIndex) => {
    const phase = record(entry);
    const name = string(phase.name)?.trim();
    return array(phase.tasks).flatMap((item, taskIndex) => {
      const task = record(item);
      const text = string(task.content)?.trim();
      const status = task.status;
      if (!text || (status !== "pending" && status !== "in_progress" && status !== "completed"))
        return [];
      return [
        {
          id: `${phaseIndex}:${taskIndex}`,
          text: name && value.length > 1 ? `${name}: ${text}` : text,
          status: status === "in_progress" ? "running" : status,
        },
      ];
    });
  });
}

export function contentText(value: unknown, type: "text" | "thinking" = "text") {
  if (type === "text" && typeof value === "string") return value;
  return array(value)
    .map(record)
    .filter((part) => part.type === type)
    .map((part) => string(part[type]) ?? "")
    .join("\n");
}
