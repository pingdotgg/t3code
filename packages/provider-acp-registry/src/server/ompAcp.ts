import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// omp askDialog emits `q{N}` string fields whose oneOf consts are the option
// labels, plus an unconditional `q{N}__other` free-text companion, with the
// question in `title` and the header in `description`. The generic fallback
// reads options only from `enum`, splits companions out, and swaps the pair.
const isOmpForm = Schema.is(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
);
const isOmpQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    oneOf: Schema.Array(
      Schema.Struct({
        const: TrimmedNonEmptyString,
        title: TrimmedNonEmptyString,
        description: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const isOmpCompanion = Schema.is(Schema.Struct({ type: Schema.Literal("string") }));

// The client already offers a custom answer per question, so hide the
// companion question and restore it in the response. omp reads `q{N}` as one
// of the option labels and `q{N}__other` as the custom text; when the
// companion is set, the label field is ignored.
export const extractOmpElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isOmpForm(request.requestedSchema)) return undefined;
  const { properties } = request.requestedSchema;
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [id, field] of Object.entries(properties)) {
    if (!/^q\d+$/.test(id)) continue;
    if (!isOmpQuestion(field) || !isOmpCompanion(properties[`${id}__other`])) return undefined;
    const header = field.description?.trim();
    questions.push({
      id,
      header: header ? header : `Question ${questions.length + 1}`,
      question: field.title,
      options: field.oneOf.map((option) => ({
        label: option.title,
        description: option.description?.trim() ? option.description : option.title,
        value: option.const,
      })),
    });
  }
  // Recognize only complete askDialog forms; leave every other schema to the
  // ACP fallback.
  if (questions.length === 0 || Object.keys(properties).length !== questions.length * 2) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const entries: Array<[string, string]> = [];
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (!Predicate.isString(answer) || answer.trim().length === 0) return { action: "cancel" };
        if (question.options.some((option) => option.value === answer)) {
          entries.push([question.id, answer]);
        } else {
          entries.push([`${question.id}__other`, answer]);
        }
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};
