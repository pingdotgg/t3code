import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as Schema from "effect/Schema";

const isForm = Schema.is(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
);
const choice = Schema.Struct({
  const: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
});
const isQuestion = Schema.is(
  Schema.Struct({
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    type: Schema.Literal("string"),
    oneOf: Schema.Array(choice),
  }),
);
const isCompanion = Schema.is(
  Schema.Struct({ type: Schema.Literal("string"), title: Schema.Literal("Other (type your own)") }),
);

/** OMP askDialog pairs qN choices with qN__other and puts the question in title. */
export const extractOmpElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isForm(request.requestedSchema)) return undefined;
  const { properties } = request.requestedSchema;
  const questions: OrchestrationV2UserInputQuestion[] = [];
  for (const [id, field] of Object.entries(properties)) {
    if (!/^q\d+$/.test(id)) continue;
    if (!isQuestion(field) || !isCompanion(properties[`${id}__other`])) return undefined;
    const choices = field.oneOf;
    if (choices.length === 0) return undefined;
    questions.push({
      id,
      header: field.description?.trim() || `Question ${questions.length + 1}`,
      question: field.title,
      options: choices.map((option) => ({
        label: option.title,
        value: option.const,
        description: option.description?.trim() || option.title,
      })),
    });
  }
  // Do not hide unknown fields or partially reinterpret a different form.
  if (questions.length === 0 || Object.keys(properties).length !== questions.length * 2)
    return undefined;
  return {
    questions,
    respond: (answers) => {
      const content: Record<string, string> = {};
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        if (typeof answer !== "string" || !answer.trim()) return { action: "cancel" };
        if (question.options.some((option) => option.value === answer))
          content[question.id] = answer;
        else content[`${question.id}__other`] = answer;
      }
      return { action: "accept", content };
    },
  };
};
