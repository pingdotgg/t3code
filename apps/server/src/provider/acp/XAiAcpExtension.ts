import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const XAiAskUserQuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
  preview: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

const XAiAskUserQuestion = Schema.Struct({
  id: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.Array(XAiAskUserQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean),
});

const XAiAskUserQuestionParams = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  questions: Schema.Array(XAiAskUserQuestion),
  mode: Schema.Union([Schema.Literal("default"), Schema.Literal("plan")]),
});

const XAiWrappedAskUserQuestionParams = Schema.Struct({
  method: Schema.Literal("x.ai/ask_user_question"),
  params: XAiAskUserQuestionParams,
});

export const XAiAskUserQuestionRequest = Schema.Unknown;

type XAiAskUserQuestionRequestParams = typeof XAiAskUserQuestionParams.Type;

const decodeXAiAskUserQuestionParams = Schema.decodeUnknownSync(XAiAskUserQuestionParams);
const decodeXAiWrappedAskUserQuestionParamsExit = Schema.decodeUnknownExit(
  XAiWrappedAskUserQuestionParams,
);

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function unwrapAskUserQuestionParams(params: unknown): XAiAskUserQuestionRequestParams {
  const wrapped = decodeXAiWrappedAskUserQuestionParamsExit(params);
  if (Exit.isSuccess(wrapped)) {
    return wrapped.value.params;
  }
  return decodeXAiAskUserQuestionParams(params);
}

export function extractXAiAskUserQuestions(params: unknown): ReadonlyArray<UserInputQuestion> {
  return unwrapAskUserQuestionParams(params).questions.map((question) => ({
    id: question.id ?? question.question,
    header: "Question",
    question: question.question,
    multiSelect: question.multiSelect === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
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

export function makeXAiAskUserQuestionResponse(answers: ProviderUserInputAnswers): {
  readonly outcome: "accepted";
  readonly answers: Record<string, ReadonlyArray<string>>;
} {
  return {
    outcome: "accepted",
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, answer]) => [questionId, answerValues(answer)]),
    ),
  };
}
