import { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const PI_USER_INPUT_VERSION_ENV = "T3_PI_USER_INPUT_VERSION";
export const PI_USER_INPUT_PREFIX = "t3:user-input:";

// Pi RPC exposes only string-valued dialogs. Extensions can opt into a
// versioned envelope carried by input's placeholder and string response.
const Questions = Schema.Struct({
  version: Schema.Literal(1),
  questions: Schema.Array(OrchestrationV2UserInputQuestion).check(Schema.isMinLength(1)),
});
const Answer = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const Answers = Schema.Record(Schema.String, Answer);
const decodeQuestions = Schema.decodeUnknownOption(Schema.fromJsonString(Questions));
const decodeAnswers = Schema.decodeUnknownOption(Answers);
const encodeAnswers = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Literal(1), answers: Answers })),
);

export function piStructuredQuestions(placeholder: string) {
  if (!placeholder.startsWith(PI_USER_INPUT_PREFIX)) return null;
  const decoded = decodeQuestions(placeholder.slice(PI_USER_INPUT_PREFIX.length));
  if (Option.isNone(decoded)) return null;
  const questions = decoded.value.questions;
  if (new Set(questions.map((question) => question.id)).size !== questions.length) return null;
  return questions;
}

export function piStructuredAnswers(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: Record<string, unknown> | undefined,
): string | null {
  const decoded = decodeAnswers(answers);
  if (Option.isNone(decoded)) return null;
  const result: Array<readonly [string, string | ReadonlyArray<string>]> = [];
  for (const question of questions) {
    const answer = Object.hasOwn(decoded.value, question.id)
      ? decoded.value[question.id]
      : undefined;
    if (answer === undefined) return null;
    const values = new Set(question.options.map((option) => option.value ?? option.label));
    if (typeof answer === "string") {
      if (question.allowCustomAnswer === false && (question.multiSelect || !values.has(answer)))
        return null;
    } else if (
      !question.multiSelect ||
      answer.length === 0 ||
      answer.some((value) => !values.has(value))
    ) {
      return null;
    }
    result.push([question.id, answer]);
  }
  return encodeAnswers({ version: 1, answers: Object.fromEntries(result) });
}
