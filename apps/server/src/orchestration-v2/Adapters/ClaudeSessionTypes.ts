// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
// @effect-diagnostics anyUnknownInErrorContext:off
import { field, text } from "../unknownField.ts";

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";

import { ClaudeSettings, TrimmedNonEmptyString } from "@t3tools/contracts";
import type {
  ModelSelection,
  OrchestrationV2PlanStep,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";

import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Deferred from "effect/Deferred";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as Ref from "effect/Ref";

import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";

import {
  getClaudeCatalogModelCapabilities,
  resolveClaudeModelSlug,
} from "../../provider/ClaudeModelCatalog.ts";
import type { ClaudeModelCatalog } from "../../provider/ClaudeModelCatalog.ts";

import type { ClaudeScopedLimitNames } from "../../provider/claudeUsageLimits.ts";

import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import { firstStringInputField } from "./ClaudeToolClassification.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAssistantArtifacts.ts";
import type { ClaudeAgentSdkQueryRunnerShape } from "./ClaudeAdapterV2.ts";
import type { ClaudeNativeToolInput } from "./ClaudeToolClassification.ts";

/** Claude writes blocks separately with stop_reason null until the last.
 * Missing stop_reason keeps the turn open; pre-tool text is not the reply. */
export function isClaudeTranscriptTurnEnd(entry: unknown): boolean {
  if (field(entry, "type") !== "assistant") return false;
  const stopReason = field(field(entry, "message"), "stop_reason");
  return typeof stopReason === "string" && stopReason !== "tool_use";
}

export function isClaudeTranscriptConversationLine(
  entry: unknown,
): entry is SDKAssistantMessage | SDKUserMessage {
  const type = field(entry, "type");
  const content = field(field(entry, "message"), "content");
  return (
    typeof field(entry, "uuid") === "string" &&
    ((type === "assistant" && Array.isArray(content)) ||
      (type === "user" && (Array.isArray(content) || typeof content === "string")))
  );
}

export interface PendingClaudeSubagentLaunch {
  readonly model?: string;
  readonly effort?: string;
  readonly ownerToolUseId?: string;
}

export function canonicalClaudeSubagentModel(catalog: ClaudeModelCatalog, model: string): string {
  return resolveClaudeModelSlug(catalog, model);
}

export function claudeSubagentModelSelection(
  catalog: ClaudeModelCatalog,
  instanceId: ModelSelection["instanceId"],
  model: string,
  effort: string | undefined,
): ModelSelection {
  const descriptor = getClaudeCatalogModelCapabilities(catalog, model).optionDescriptors?.find(
    (candidate) => candidate.id === "effort",
  );
  const offered =
    effort !== undefined &&
    descriptor?.type === "select" &&
    descriptor.options.some((option) => option.id === effort);
  return { instanceId, model, ...(offered ? { options: [{ id: "effort", value: effort }] } : {}) };
}

export const PENDING_CLAUDE_SUBAGENT_CAP = 64;
export const PENDING_CLAUDE_SUBAGENT_FRAME_CAP = 256;

export function rememberPendingClaudeSubagentLaunch(
  pending: Map<string, PendingClaudeSubagentLaunch>,
  toolUseId: string,
  launch: PendingClaudeSubagentLaunch,
): void {
  pending.set(toolUseId, { ...pending.get(toolUseId), ...launch });
  if (pending.size <= PENDING_CLAUDE_SUBAGENT_CAP) {
    return;
  }
  const oldest = pending.keys().next();
  if (!oldest.done) {
    pending.delete(oldest.value);
  }
}

export function rememberClaudeSubagentLaunch(
  catalog: ClaudeModelCatalog,
  context: ActiveClaudeTurnContext,
  pending: Map<string, PendingClaudeSubagentLaunch>,
  toolUseId: string,
  input: ClaudeNativeToolInput,
  ownerToolUseId: string | null,
): void {
  if (context.subagentsByToolUseId.has(toolUseId)) return;
  const requested = firstStringInputField(input, ["model"]);
  const model =
    requested !== "inherit"
      ? requested && canonicalClaudeSubagentModel(catalog, requested)
      : ownerToolUseId === null
        ? context.input.modelSelection.model
        : undefined;
  const effort = firstStringInputField(input, ["effort"]);
  const launch: PendingClaudeSubagentLaunch = {
    ...(model === undefined || pending.get(toolUseId)?.model !== undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(ownerToolUseId === null ? {} : { ownerToolUseId }),
  };
  if (
    launch.model !== undefined ||
    launch.effort !== undefined ||
    launch.ownerToolUseId !== undefined
  ) {
    rememberPendingClaudeSubagentLaunch(pending, toolUseId, launch);
  }
}

export type ClaudeApprovalResponse = {
  readonly decision: ProviderApprovalDecision;
  readonly feedback?: string;
};

export type PendingClaudeRuntimeRequest =
  | {
      readonly type: "approval";
      readonly requestKind: ProviderRequestKind;
      readonly decision: Deferred.Deferred<ClaudeApprovalResponse, never>;
    }
  | {
      readonly type: "user_input";
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers, never>;
    };

export function claudeUserInputQuestions(
  input: unknown,
): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  const value =
    typeof input === "object" && input !== null && Reflect.get(input, "type") === "record"
      ? Reflect.get(input, "value")
      : input;
  const questions =
    typeof value === "object" && value !== null ? Reflect.get(value, "questions") : undefined;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((value: unknown, index: number) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (question.length === 0) return [];
    const header =
      typeof record.header === "string" && record.header.trim().length > 0
        ? record.header.trim()
        : `Question ${index + 1}`;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (typeof option !== "object" || option === null) return [];
          const optionRecord = option as Record<string, unknown>;
          const label = typeof optionRecord.label === "string" ? optionRecord.label.trim() : "";
          if (label.length === 0) return [];
          const description =
            typeof optionRecord.description === "string" ? optionRecord.description.trim() : "";
          return [
            {
              label,
              description: description || label,
              ...(typeof optionRecord.preview === "string"
                ? { preview: optionRecord.preview }
                : {}),
            },
          ];
        })
      : [];
    return [
      {
        id: question,
        header,
        question,
        options,
        multiSelect: record.multiSelect === true,
      },
    ];
  });
}

export function claudeSdkUserInputAnswers(
  answers: ProviderUserInputAnswers,
): NonNullable<AskUserQuestionInput["answers"]> {
  return Object.fromEntries(
    Object.entries(answers).map(([question, answer]) => [
      question,
      Array.isArray(answer)
        ? answer.filter((value): value is string => typeof value === "string").join(", ")
        : typeof answer === "string"
          ? answer
          : String(answer ?? ""),
    ]),
  );
}

export function claudeTodoSteps(input: unknown): ReadonlyArray<OrchestrationV2PlanStep> {
  const value =
    typeof input === "object" && input !== null && Reflect.get(input, "type") === "record"
      ? Reflect.get(input, "value")
      : input;
  const todos =
    typeof value === "object" && value !== null ? Reflect.get(value, "todos") : undefined;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo, index) => {
    if (typeof todo !== "object" || todo === null) return [];
    const text =
      typeof Reflect.get(todo, "content") === "string"
        ? String(Reflect.get(todo, "content")).trim()
        : "";
    if (text.length === 0) return [];
    const nativeStatus = Reflect.get(todo, "status");
    return [
      {
        id: `todo-${index}`,
        text,
        status:
          nativeStatus === "completed"
            ? "completed"
            : nativeStatus === "in_progress"
              ? "running"
              : "pending",
      },
    ];
  });
}

export type ClaudeTaskList = ReadonlyMap<string, Omit<OrchestrationV2PlanStep, "id">>;

export function claudeTaskField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export function claudeTaskString(value: unknown, key: string): string | undefined {
  const field = claudeTaskField(value, key);
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

// A Claude Code mod can hold a tool call until the user acts in its terminal
// pane. T3 cannot provide the requested pane interaction.
// Passive panes never request focus and keep working.
export function claudeFocusRequestedPanePlugin(message: SDKMessage): string | null {
  if (message.type !== "system" || claudeTaskField(message, "subtype") !== "ui_panes") return null;
  const paneId = claudeTaskString(message, "focus_requested_id");
  if (paneId === undefined) return null;
  const panes = claudeTaskField(message, "panes");
  const pane = Array.isArray(panes)
    ? panes.find((entry) => claudeTaskField(entry, "id") === paneId)
    : undefined;
  return claudeTaskString(pane, "plugin") ?? paneId;
}

export function claudeTaskStatus(value: unknown): OrchestrationV2PlanStep["status"] | undefined {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

export function applyClaudeTaskTool(
  tasks: ClaudeTaskList,
  toolName: string,
  input: unknown,
  result: unknown,
): ClaudeTaskList | undefined {
  if (toolName === "TaskList") {
    const listed = claudeTaskField(result, "tasks");
    if (!Array.isArray(listed)) return undefined;
    const next = new Map<string, Omit<OrchestrationV2PlanStep, "id">>();
    for (const task of listed) {
      const id = claudeTaskString(task, "id");
      const text = claudeTaskString(task, "subject");
      const status = claudeTaskStatus(claudeTaskField(task, "status"));
      if (id !== undefined && text !== undefined && status !== undefined) {
        next.set(id, { text, status });
      }
    }
    return next.size === 0 && tasks.size === 0 ? undefined : next;
  }
  if (toolName === "TaskCreate") {
    const created = claudeTaskField(result, "task");
    const fromText = claudeCreatedTaskFromText(result);
    const id = claudeTaskString(created, "id") ?? fromText?.id;
    const text =
      claudeTaskString(created, "subject") ??
      fromText?.subject ??
      claudeTaskString(input, "subject");
    if (id === undefined || text === undefined) return undefined;
    return new Map(tasks).set(id, { text, status: "pending" });
  }
  if (
    toolName !== "TaskUpdate" ||
    claudeTaskField(result, "success") === false ||
    (typeof result === "string" && !result.startsWith("Updated task #"))
  ) {
    return undefined;
  }
  const id = claudeTaskString(input, "taskId") ?? claudeTaskString(result, "taskId");
  const task = id === undefined ? undefined : tasks.get(id);
  if (id === undefined || task === undefined) return undefined;
  const nativeStatus = claudeTaskField(input, "status");
  if (nativeStatus === "deleted") {
    const next = new Map(tasks);
    next.delete(id);
    return next;
  }
  const text = claudeTaskString(input, "subject") ?? task.text;
  const status = claudeTaskStatus(nativeStatus) ?? task.status;
  if (text === task.text && status === task.status) return undefined;
  return new Map(tasks).set(id, { text, status });
}

// Subagent results carry no structured `tool_use_result`, only the text
// "Task #3 created successfully: <subject>".
export function claudeCreatedTaskFromText(
  result: unknown,
): { readonly id: string; readonly subject: string } | undefined {
  const match =
    typeof result === "string" ? /^Task #(\S+) created successfully: (.+)$/s.exec(result) : null;
  return match === null ? undefined : { id: match[1]!, subject: match[2]!.trim() };
}

export const CLAUDE_TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskList"]);
export const decodeClaudeTaskFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      subject: TrimmedNonEmptyString,
      status: Schema.Literals(["pending", "in_progress", "completed"]),
      metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

export const readClaudeTaskList = Effect.fnUntraced(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string | null | undefined;
    readonly nativeThreadId: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDirOverride = input.environment.CLAUDE_CONFIG_DIR?.trim();
    const configDir = configDirOverride
      ? path.resolve(input.cwd ?? ".", configDirOverride)
      : yield* resolveClaudeHomePath({ homePath: "" });
    const listId = input.environment.CLAUDE_CODE_TASK_LIST_ID?.trim() || input.nativeThreadId;
    const directory = path.join(configDir, "tasks", listId.replace(/[^a-zA-Z0-9_-]/g, "-"));
    const tasks = new Map<string, Omit<OrchestrationV2PlanStep, "id">>();
    const names = (yield* fileSystem.readDirectory(directory))
      .filter((name) => /^\d+\.json$/.test(name))
      .toSorted((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10));
    for (const name of names) {
      const contents = yield* fileSystem
        .readFileString(path.join(directory, name))
        .pipe(Effect.orElseSucceed(() => ""));
      const task = Option.getOrUndefined(decodeClaudeTaskFile(contents));
      if (task === undefined || task.metadata?._internal) continue;
      tasks.set(task.id, {
        text: task.subject,
        status: task.status === "in_progress" ? "running" : task.status,
      });
    }
    return tasks;
  },
  Effect.orElseSucceed((): ClaudeTaskList | undefined => undefined),
);

export function claudeTaskSteps(tasks: ClaudeTaskList): ReadonlyArray<OrchestrationV2PlanStep> {
  return [...tasks].map(([id, task]) => ({ id: `task-${id}`, ...task }));
}

export function claudeProposedPlan(input: unknown): string | null {
  const value =
    typeof input === "object" && input !== null && Reflect.get(input, "type") === "record"
      ? Reflect.get(input, "value")
      : input;
  const plan = typeof value === "object" && value !== null ? Reflect.get(value, "plan") : undefined;
  return typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : null;
}

export interface ClaudeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly queryRunner: ClaudeAgentSdkQueryRunnerShape;
  readonly scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>;
  readonly onUsageLimits?: ManagedServerProvider["applyUsageLimits"];
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}
