/**
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 * Additional reference provided by the Cursor team: https://anysphere.enterprise.slack.com/files/U068SSJE141/F0APT1HSZRP/cursor-acp-extension-method-schemas.md
 */
import type { UserInputQuestion } from "@t3tools/contracts";
import * as AcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

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
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export interface CursorTaskToolFields {
  readonly title: string;
  readonly role?: string;
}

/**
 * Cursor exposes native Task/subagent launches as ordinary ACP tool calls.
 * Ask-question, plan, and execute/read/edit tools must not match.
 */
export function cursorTaskToolFields(toolCall: AcpToolCallState): CursorTaskToolFields | undefined {
  const kind = toolCall.kind;
  if (
    kind === "execute" ||
    kind === "read" ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move"
  ) {
    return undefined;
  }
  const raw = toolCall.data.rawInput;
  if (isRecord(raw) && Array.isArray(raw.questions)) {
    return undefined;
  }
  if (isRecord(raw) && (typeof raw.plan === "string" || Array.isArray(raw.todos))) {
    return undefined;
  }
  const role = isRecord(raw) ? trimmedString(raw.subagent_type) : undefined;
  const description = isRecord(raw) ? trimmedString(raw.description) : undefined;
  const title = trimmedString(toolCall.title);
  const titleLooksLikeTask =
    title !== undefined &&
    (title.toLowerCase() === "task" ||
      title.toLowerCase() === "running task" ||
      title.toLowerCase().startsWith("task "));
  if (role === undefined && !titleLooksLikeTask) {
    return undefined;
  }
  return {
    title: description ?? title ?? "Task",
    ...(role !== undefined ? { role } : {}),
  };
}

export function classifyCursorTaskToolCall(toolCall: AcpToolCallState): boolean {
  return cursorTaskToolFields(toolCall) !== undefined;
}
