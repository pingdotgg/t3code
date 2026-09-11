/**
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 * Additional reference provided by the Cursor team: https://anysphere.enterprise.slack.com/files/U068SSJE141/F0APT1HSZRP/cursor-acp-extension-method-schemas.md
 */
import type { UserInputQuestion } from "@t3tools/contracts";
import * as AcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

const CursorTodoStatus = Schema.String;

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(CursorTodoStatus),
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export const CursorUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(CursorTodo),
  merge: Schema.Boolean,
});

const CursorAvailableModel = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  configOptions: Schema.optional(Schema.Array(AcpSchema.SessionConfigOption)),
});

export const CursorListAvailableModelsResponse = Schema.Struct({
  models: Schema.Array(CursorAvailableModel),
});

export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursorUpdateTodosToolName(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const compact = value.replaceAll("_", "").toLowerCase();
  return compact === "updatetodos" || compact === "todowrite";
}

function normalizeCursorTodoStatus(
  status: string | undefined,
): "pending" | "inProgress" | "completed" {
  const compact = (status ?? "")
    .trim()
    .replace(/^TODO_STATUS_/i, "")
    .replaceAll("_", "")
    .toLowerCase();
  if (compact === "completed") {
    return "completed";
  }
  if (compact === "inprogress") {
    return "inProgress";
  }
  return "pending";
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    // Fall back to the title when content is missing OR blank. `??` only
    // covers a missing content, so a present-but-empty content ("" or
    // whitespace) would shadow a real title and drop the step below.
    const step = todo.content?.trim() || todo.title?.trim() || "";
    if (step === "") {
      return [];
    }
    return [{ step, status: normalizeCursorTodoStatus(todo.status) }];
  });
  return { plan };
}

/**
 * Cursor CLI ACP does not send `cursor/update_todos`. It emits a generic
 * `updateTodos` / `TodoWrite` tool call whose `rawInput` carries the todo list.
 */
export function extractTodosAsPlanFromToolCallInput(
  rawInput: unknown,
): ReturnType<typeof extractTodosAsPlan> | undefined {
  if (!isRecord(rawInput) || !isCursorUpdateTodosToolName(rawInput._toolName)) {
    return undefined;
  }
  if (!Array.isArray(rawInput.todos)) {
    return undefined;
  }
  const todos = rawInput.todos.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    return [
      {
        ...(typeof item.id === "string" ? { id: item.id } : {}),
        ...(typeof item.content === "string" ? { content: item.content } : {}),
        ...(typeof item.title === "string" ? { title: item.title } : {}),
        ...(typeof item.status === "string" ? { status: item.status } : {}),
      },
    ];
  });
  const extracted = extractTodosAsPlan({
    toolCallId: "updateTodos",
    todos,
    merge: false,
  });
  return extracted.plan.length > 0 ? extracted : undefined;
}
