import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function option(value: unknown): UserInputQuestion["options"][number] | undefined {
  if (typeof value === "string") {
    const label = text(value);
    return label ? { label, description: label } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const label = text(value.label);
  if (!label) return undefined;
  return { label, description: text(value.description) ?? label };
}

function stableQuestionId(index: number, header: string): string {
  const slug = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `kimi-question-${index + 1}${slug ? `-${slug}` : ""}`;
}

export function extractKimiUserQuestions(
  input: unknown,
): ReadonlyArray<UserInputQuestion> | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0) {
    return undefined;
  }

  const questions: UserInputQuestion[] = [];
  for (const [index, value] of input.questions.entries()) {
    if (!isRecord(value) || !Array.isArray(value.options)) return undefined;
    const header = text(value.header);
    const question = text(value.question);
    if (!header || !question) return undefined;
    const options = value.options.map(option);
    if (options.length < 2 || options.some((entry) => entry === undefined)) return undefined;

    questions.push({
      id: text(value.id) ?? stableQuestionId(index, header),
      header,
      question,
      options: options as Array<UserInputQuestion["options"][number]>,
      multiSelect: value.multi_select === true || value.multiSelect === true,
    });
  }

  return questions;
}

function toolCallQuestionText(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  for (const entry of request.toolCall.content ?? []) {
    if (entry.type === "content" && entry.content.type === "text") {
      const value = text(entry.content.text);
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Kimi Code bridges AskUserQuestion through ACP's permission request surface.
 * Prefer its raw tool input when present, while also supporting the current
 * upstream bridge that exposes only a title, question text, and named options.
 */
export function extractKimiPermissionQuestions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<UserInputQuestion> | undefined {
  if (request.toolCall.title?.trim().toLowerCase() !== "askuserquestion") {
    return undefined;
  }

  const rawQuestions = extractKimiUserQuestions(request.toolCall.rawInput);
  if (rawQuestions) {
    // Kimi's ACP bridge can return only one permission option, so mirror the
    // CLI's first-question, single-select behavior for legacy raw input.
    return [{ ...rawQuestions[0]!, multiSelect: false }];
  }

  const question = toolCallQuestionText(request);
  const options = request.options.flatMap((entry) => {
    if (entry.kind !== "allow_once") return [];
    const label = text(entry.name);
    return label ? [{ label, description: label }] : [];
  });
  if (!question || options.length < 2) return undefined;

  return [
    {
      id: text(request.toolCall.toolCallId) ?? "kimi-question-1-question",
      header: "Question",
      question,
      options,
      multiSelect: false,
    },
  ];
}

function selectedLabels(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  if (isRecord(value) && Array.isArray(value.answers)) {
    return value.answers.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

export function resolveKimiQuestionPermissionOption(input: {
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: ProviderUserInputAnswers;
}): string | undefined {
  const labels = input.questions.flatMap((question) =>
    selectedLabels(input.answers[question.id] ?? input.answers[question.question]),
  );
  for (const label of labels) {
    const normalizedLabel = text(label);
    if (!normalizedLabel) continue;
    const option = input.request.options.find(
      (entry) => entry.kind === "allow_once" && text(entry.name) === normalizedLabel,
    );
    if (option?.optionId.trim()) return option.optionId.trim();
  }
  return undefined;
}
