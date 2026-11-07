import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const isForm = Schema.is(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
);
const choice = Schema.Struct({
  const: Schema.String,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
});
const isChoiceQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    oneOf: Schema.Array(choice),
  }),
);
const isMultiChoiceQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("array"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    items: Schema.Struct({ anyOf: Schema.Array(choice) }),
  }),
);
const isTextQuestion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
  }),
);
// The companion only carries a free-form answer, never a title we can show.
const isCustomCompanion = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    description: Schema.Literals(["Type your own answer", "Add your own answer"]),
  }),
);

const questionId = /^q\d+$/;
const companionSuffix = "_custom";

// Intake appends file references to a user's answer; keep them with the custom text.
const splitAttachments = (value: string) => {
  const marker = value.indexOf("\n\n");
  if (marker < 0) return undefined;
  const suffix = value.slice(marker);
  if (!/^\n\nAttached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/.test(suffix)) return undefined;
  return { prefix: value.slice(0, marker), suffix };
};

type Option = OrchestrationV2UserInputQuestion["options"][number];

const findChoice = (options: ReadonlyArray<Option>, value: string) =>
  options.find((option) => option.value === value);

const optionValue = (option: Option) => option.value ?? option.label;

/** OpenCode 2.1 asks through ACP with a `qN` choice field plus a `qN_custom` companion. */
export const extractOpenCodeElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isForm(request.requestedSchema)) return undefined;
  const { properties } = request.requestedSchema;
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  const withCompanion = new Set<string>();
  let recognized = 0;
  let choices = 0;
  for (const [id, field] of Object.entries(properties)) {
    if (!questionId.test(id)) {
      const owner = id.endsWith(companionSuffix) ? id.slice(0, -companionSuffix.length) : undefined;
      if (owner === undefined || !questionId.test(owner) || !Object.hasOwn(properties, owner)) {
        return undefined;
      }
      continue;
    }
    const companion = properties[`${id}${companionSuffix}`];
    const hasCompanion = companion !== undefined;
    if (hasCompanion && !isCustomCompanion(companion)) return undefined;
    const fieldChoices = isChoiceQuestion(field)
      ? field.oneOf
      : isMultiChoiceQuestion(field)
        ? field.items.anyOf
        : undefined;
    if (fieldChoices === undefined) {
      if (!isTextQuestion(field)) return undefined;
      // Unsupported choice schemas belong to the generic mapping.
      if ("enum" in field || "oneOf" in field || "anyOf" in field || "items" in field) {
        return undefined;
      }
    }
    if (!isTextQuestion(field) && !isMultiChoiceQuestion(field)) return undefined;
    const options = (fieldChoices ?? []).map((option) => ({
      label: option.title,
      description: option.description?.trim() || option.title,
      value: option.const,
    }));
    if (options.length > 0) choices += 1;
    if (hasCompanion) withCompanion.add(id);
    recognized += hasCompanion ? 2 : 1;
    questions.push({
      id,
      header: field.title,
      question: field.description?.trim() || field.title,
      options,
      ...(field.type === "array" ? { multiSelect: true } : {}),
      allowCustomAnswer: hasCompanion || options.length === 0,
    });
  }
  // Recognize only complete question forms; leave every other schema to the ACP fallback.
  if (questions.length === 0 || choices === 0 || recognized !== Object.keys(properties).length) {
    return undefined;
  }
  return {
    questions,
    respond: (answers) => {
      const content: Record<string, string | ReadonlyArray<string>> = {};
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        const values = Array.isArray(answer)
          ? answer.filter(Predicate.isString)
          : Predicate.isString(answer)
            ? [answer]
            : [];
        if (values.length === 0 || (question.multiSelect !== true && values.length > 1)) {
          return { action: "cancel" };
        }
        const companion = withCompanion.has(question.id);
        const selected: Array<string> = [];
        const custom: Array<string> = [];
        for (const value of values) {
          const exact = findChoice(question.options, value);
          if (exact !== undefined) {
            selected.push(optionValue(exact));
            continue;
          }
          if (value.trim().length === 0) return { action: "cancel" };
          const split = splitAttachments(value);
          const attached =
            split === undefined ? undefined : findChoice(question.options, split.prefix);
          if (companion && attached !== undefined && split !== undefined) {
            selected.push(optionValue(attached));
            custom.push(`${attached.label}${split.suffix}`);
          } else if (companion) {
            custom.push(value);
          } else if (question.options.length === 0) {
            selected.push(value);
          } else {
            return { action: "cancel" };
          }
        }
        if (selected.length > 0) {
          content[question.id] = question.multiSelect === true ? selected : selected[0]!;
        }
        if (custom.length > 0) content[`${question.id}${companionSuffix}`] = custom.join("\n");
      }
      return { action: "accept", content };
    },
  };
};
