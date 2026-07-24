import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

/**
 * The Kimi CLI bridges its `AskUserQuestion` tool through the standard ACP
 * `session/request_permission` method:
 *
 * - `toolCall.title` is `"AskUserQuestion"` and the question text rides in the
 *   tool call content (or raw input, depending on CLI version).
 * - Options are `q{questionIndex}_opt_{optionIndex}` with `kind: "allow_once"`
 *   and `name` set to the option label, plus a trailing `q{questionIndex}_skip`
 *   with `kind: "reject_once"`.
 * - The returned `optionId` is reverse-mapped by the CLI to the selected label;
 *   selecting skip (or cancelling) dismisses the question. The bridge is
 *   single-select and degrades multi-question calls to the first question.
 */
export const KIMI_ASK_USER_QUESTION_TITLE = "AskUserQuestion";

const KIMI_QUESTION_OPTION_ID_PATTERN = /^q(\d+)_(opt_\d+|skip)$/;

interface KimiQuestionOption {
  readonly optionId: string;
  readonly name: string;
}

function trimmed(value: string | undefined | null): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isKimiAskUserQuestionRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  if (trimmed(params.toolCall.title) === KIMI_ASK_USER_QUESTION_TITLE) {
    return true;
  }
  return params.options.some((option) => KIMI_QUESTION_OPTION_ID_PATTERN.test(option.optionId));
}

function questionTextFromRawInput(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) {
    return undefined;
  }
  const direct = typeof rawInput.question === "string" ? trimmed(rawInput.question) : undefined;
  if (direct) {
    return direct;
  }
  if (Array.isArray(rawInput.questions)) {
    for (const entry of rawInput.questions) {
      if (isRecord(entry) && typeof entry.question === "string") {
        const text = trimmed(entry.question);
        if (text) {
          return text;
        }
      }
    }
  }
  return undefined;
}

function extractQuestionText(params: EffectAcpSchema.RequestPermissionRequest): string | undefined {
  for (const block of params.toolCall.content ?? []) {
    if (block.type === "content" && block.content.type === "text") {
      const text = trimmed(block.content.text);
      if (text) {
        return text;
      }
    }
  }
  const fromRawInput = questionTextFromRawInput(params.toolCall.rawInput);
  if (fromRawInput) {
    return fromRawInput;
  }
  const title = trimmed(params.toolCall.title);
  return title === KIMI_ASK_USER_QUESTION_TITLE ? undefined : title;
}

function collectQuestionOptions(
  params: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyMap<number, ReadonlyArray<KimiQuestionOption>> {
  const byQuestionIndex = new Map<number, KimiQuestionOption[]>();
  for (const option of params.options) {
    const match = KIMI_QUESTION_OPTION_ID_PATTERN.exec(option.optionId);
    if (!match || match[2] === "skip") {
      continue;
    }
    const questionIndex = Number(match[1]);
    const options = byQuestionIndex.get(questionIndex) ?? [];
    options.push({ optionId: option.optionId, name: option.name });
    byQuestionIndex.set(questionIndex, options);
  }
  return byQuestionIndex;
}

export function extractKimiAskUserQuestions(
  params: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<UserInputQuestion> {
  const byQuestionIndex = collectQuestionOptions(params);
  const questionText = extractQuestionText(params) ?? "Question";
  return Array.from(byQuestionIndex.entries())
    .sort(([left], [right]) => left - right)
    .map(([questionIndex, options]) => ({
      id: `q${questionIndex}`,
      header: "Question",
      question: questionText,
      multiSelect: false,
      options: options.map((option) => ({
        label: option.name,
        description: option.name,
      })),
    }));
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const text = typeof entry === "string" ? trimmed(entry) : undefined;
      return text ? [text] : [];
    });
  }
  const text = typeof answer === "string" ? trimmed(answer) : undefined;
  return text ? [text] : [];
}

/**
 * Maps structured user answers back to the `q{index}_opt_{n}` optionId the
 * CLI expects. Returns `undefined` when no answer matches an option label —
 * the CLI's permission bridge cannot convey free text, so callers should fall
 * back to the skip option in that case.
 */
export function selectKimiAskUserQuestionOptionId(
  params: EffectAcpSchema.RequestPermissionRequest,
  answers: ProviderUserInputAnswers,
): string | undefined {
  const byQuestionIndex = collectQuestionOptions(params);
  const questionText = extractQuestionText(params);
  for (const [questionIndex, options] of Array.from(byQuestionIndex.entries()).sort(
    ([left], [right]) => left - right,
  )) {
    const answer =
      answers[`q${questionIndex}`] ?? (questionText ? answers[questionText] : undefined);
    const values = answerValues(answer);
    if (values.length === 0) {
      continue;
    }
    for (const value of values) {
      const option = options.find((entry) => entry.name.trim() === value);
      if (option) {
        return option.optionId;
      }
    }
  }
  return undefined;
}

export function kimiAskUserQuestionSkipOptionId(
  params: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const option = params.options.find(
    (entry) =>
      KIMI_QUESTION_OPTION_ID_PATTERN.test(entry.optionId) && entry.optionId.endsWith("_skip"),
  );
  return option?.optionId.trim() || undefined;
}
