import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const isOpenCodeForm = Schema.is(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.Array(Schema.String),
  }),
);
const isOpenCodeQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: TrimmedNonEmptyString,
    oneOf: Schema.NonEmptyArray(
      Schema.Struct({
        const: Schema.String,
        title: TrimmedNonEmptyString,
        description: Schema.optional(Schema.String),
      }),
    ),
  }),
);
const isOpenCodeCompanion = Schema.is(Schema.Struct({ type: Schema.Literal("string") }));

// OpenCode pairs each optional choice q<n> with an optional q<n>_custom text
// field. The client already offers custom answers, so hide the companion and
// send a typed answer back in it.
export const extractOpenCodeElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isOpenCodeForm(request.requestedSchema)) return undefined;
  const { properties, required } = request.requestedSchema;
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [id, field] of Object.entries(properties)) {
    if (!/^q\d+$/.test(id)) continue;
    if (!isOpenCodeQuestion(field) || !isOpenCodeCompanion(properties[`${id}_custom`])) {
      return undefined;
    }
    questions.push({
      id,
      header: field.title,
      question: field.description,
      options: field.oneOf.map((option) => ({
        label: option.title,
        description: option.description?.trim() || option.title,
        value: option.const,
      })),
    });
  }
  // Recognize only complete forms; leave every other schema to the ACP fallback.
  if (
    questions.length === 0 ||
    Object.keys(properties).length !== questions.length * 2 ||
    required.length !== 0
  ) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const entries: Array<[string, string]> = [];
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (!Predicate.isString(answer) || answer.trim().length === 0) continue;
        entries.push(
          question.options.some((option) => option.value === answer)
            ? [question.id, answer]
            : [`${question.id}_custom`, answer],
        );
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};
