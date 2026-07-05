import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";

type DevinAskQuestionOption = {
  readonly id?: string;
  readonly value?: string;
  readonly label: string;
  readonly description?: string;
};

type DevinAskQuestion = {
  readonly id: string;
  readonly question: string;
  readonly options: ReadonlyArray<DevinAskQuestionOption>;
  readonly multiSelect: boolean;
};

export interface DevinAskQuestionPrompt {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly makeResponse: (answers: ProviderUserInputAnswers) => DevinAskQuestionResponse;
  readonly makeCancelledResponse: () => DevinAskQuestionResponse;
}

export interface DevinAskQuestionAcceptedResponse {
  readonly outcome: "accepted";
  readonly answers: Record<string, string | ReadonlyArray<string>>;
}

export interface DevinAskQuestionCancelledResponse {
  readonly outcome: "cancelled";
}

export type DevinAskQuestionResponse =
  | DevinAskQuestionAcceptedResponse
  | DevinAskQuestionCancelledResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function unwrapParams(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  return isRecord(payload.params) ? payload.params : payload;
}

function optionFromUnknown(value: unknown): DevinAskQuestionOption | undefined {
  if (typeof value === "string") {
    const label = trimmed(value);
    return label ? { label } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const label = trimmed(value.label) ?? trimmed(value.title) ?? trimmed(value.name);
  if (!label) {
    return undefined;
  }
  const id = trimmed(value.id);
  const optionValue = trimmed(value.value);
  const description = trimmed(value.description);
  return {
    label,
    ...(id ? { id } : {}),
    ...(optionValue ? { value: optionValue } : {}),
    ...(description ? { description } : {}),
  };
}

function optionsFromUnknown(value: unknown): ReadonlyArray<DevinAskQuestionOption> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const option = optionFromUnknown(entry);
    return option ? [option] : [];
  });
}

function questionFromUnknown(value: unknown): DevinAskQuestion | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const question =
    trimmed(value.question) ??
    trimmed(value.prompt) ??
    trimmed(value.message) ??
    trimmed(value.text);
  if (!question) {
    return undefined;
  }
  const id = trimmed(value.id) ?? question;
  return {
    id,
    question,
    options: optionsFromUnknown(value.options),
    multiSelect: value.multiSelect === true || value.allowMultiple === true,
  };
}

export function methodLooksLikeDevinAskQuestion(method: string): boolean {
  const normalized = method
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  return (
    normalized === "devin/ask_question" ||
    normalized === "devin/ask_user_question" ||
    normalized === "_devin/ask_question" ||
    normalized === "_devin/ask_user_question" ||
    normalized === "ask_question" ||
    normalized === "ask_user_question"
  );
}

export function parseDevinAskQuestionPayload(payload: unknown): ReadonlyArray<DevinAskQuestion> {
  const params = unwrapParams(payload);
  if (!isRecord(params)) {
    return [];
  }
  if (Array.isArray(params.questions)) {
    return params.questions.flatMap((entry) => {
      const question = questionFromUnknown(entry);
      return question ? [question] : [];
    });
  }
  const singleQuestion = questionFromUnknown(params);
  return singleQuestion ? [singleQuestion] : [];
}

function resolveAnswerValue(question: DevinAskQuestion, value: string): string {
  const option = question.options.find((entry) => entry.label === value);
  return option?.value ?? option?.id ?? option?.label ?? value;
}

function answerValues(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const value = trimmed(entry);
      return value ? [value] : [];
    });
  }
  const value = trimmed(answer);
  return value ? [value] : [];
}

function answerForQuestion(answers: ProviderUserInputAnswers, question: DevinAskQuestion): unknown {
  return answers[question.id] ?? answers[question.question];
}

export function makeDevinAskQuestionPrompt(payload: unknown): DevinAskQuestionPrompt | undefined {
  const questions = parseDevinAskQuestionPayload(payload);
  if (questions.length === 0) {
    return undefined;
  }
  return {
    questions: questions.map((question) => ({
      id: question.id,
      header: "Question",
      question: question.question,
      multiSelect: question.multiSelect,
      options:
        question.options.length > 0
          ? question.options.map((option) => ({
              label: option.label,
              description: option.description ?? option.label,
            }))
          : [{ label: "OK", description: "Continue" }],
    })),
    makeResponse: (answers) => ({
      outcome: "accepted",
      answers: Object.fromEntries(
        questions.map((question) => {
          const values = answerValues(answerForQuestion(answers, question)).map((value) =>
            resolveAnswerValue(question, value),
          );
          return [question.id, question.multiSelect ? values : (values[0] ?? "")];
        }),
      ),
    }),
    makeCancelledResponse: () => ({ outcome: "cancelled" }),
  };
}
