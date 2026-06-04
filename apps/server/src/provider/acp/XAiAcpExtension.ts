import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const XAiAskUserQuestionRequest = Schema.Unknown;

type UnknownRecord = Record<string, unknown>;

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: UnknownRecord, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const text = trimmed(value);
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function booleanField(record: UnknownRecord, keys: ReadonlyArray<string>): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function arrayField(record: UnknownRecord, keys: ReadonlyArray<string>): ReadonlyArray<unknown> {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function nestedRecord(
  record: UnknownRecord,
  keys: ReadonlyArray<string>,
): UnknownRecord | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function unwrapParams(params: unknown): UnknownRecord {
  if (!isRecord(params)) {
    return {};
  }
  const request = nestedRecord(params, ["request"]);
  const requestInput = request ? nestedRecord(request, ["input", "arguments", "args"]) : undefined;
  return nestedRecord(params, ["input", "arguments", "args", "params"]) ?? requestInput ?? params;
}

function extractOptionLabel(option: unknown): string | undefined {
  return typeof option === "string"
    ? trimmed(option)
    : isRecord(option)
      ? stringField(option, ["label", "value", "id", "text", "title", "name"])
      : undefined;
}

function extractOptions(options: ReadonlyArray<unknown>) {
  const extracted = (options ?? []).flatMap((option) => {
    const label = extractOptionLabel(option);
    if (!label) {
      return [];
    }
    const description =
      typeof option === "string"
        ? label
        : isRecord(option)
          ? (stringField(option, ["description", "detail", "subtitle"]) ?? label)
          : label;
    return [{ label, description }];
  });
  return extracted.length > 0 ? extracted : [{ label: "OK", description: "Continue" }];
}

function extractQuestion(
  question: unknown,
  fallbackTitle: string | undefined,
  index: number,
): UserInputQuestion {
  const record = isRecord(question) ? question : {};
  const nestedQuestion = nestedRecord(record, ["question"]);
  const questionSource = nestedQuestion ?? record;
  const questionText =
    (typeof question === "string" ? trimmed(question) : undefined) ??
    stringField(questionSource, ["question", "prompt", "text", "content", "message"]) ??
    fallbackTitle ??
    `Question ${index + 1}`;
  const id = stringField(questionSource, ["id", "questionId", "key"]) ?? questionText;
  return {
    id,
    header:
      stringField(questionSource, ["header", "title", "label"]) ?? fallbackTitle ?? "Question",
    question: questionText,
    multiSelect:
      booleanField(questionSource, ["multiSelect", "allowMultiple", "allow_multiple"]) === true,
    options: extractOptions(arrayField(questionSource, ["options", "choices", "answers"])),
  };
}

export function extractXAiAskUserQuestions(params: unknown): ReadonlyArray<UserInputQuestion> {
  const root = unwrapParams(params);
  const title = stringField(root, ["title", "header", "toolTitle"]);
  const questions = arrayField(root, ["questions", "items", "prompts"]);
  if (questions.length > 0) {
    return questions.map((question, index) => extractQuestion(question, title, index));
  }
  const singleQuestion = nestedRecord(root, ["question"]) ?? root;
  const singleQuestionOptions = arrayField(root, ["options", "choices", "answers"]);
  const question =
    singleQuestion === root || singleQuestionOptions.length === 0
      ? singleQuestion
      : { ...singleQuestion, options: singleQuestionOptions };
  return [extractQuestion(question, title, 0)];
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
