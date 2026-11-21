import { type OrchestrationV2UserInputQuestion, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import type { AcpAdapterV2Flavor } from "./adapter.ts";

const QUESTION_TEXT_LIMIT = 8_000;
const QUESTION_LABEL_LIMIT = 512;
const QUESTION_ID_PATTERN = /^q([1-9]\d*)$/;
const COMPANION_SUFFIX = "_other";
const ATTACHMENT_REFERENCE_PATTERN = /^Attached (?:image|file) "(?:\\.|[^"\\\r\n])*": "/;

const isForm = Schema.is(
  Schema.Struct({
    properties: Schema.Record(Schema.String, Schema.Unknown),
    required: Schema.optional(Schema.Array(Schema.String)),
  }),
);

const choiceOptionSchema = Schema.Struct({
  const: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
});

const isSingleSelectField = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    oneOf: Schema.Array(choiceOptionSchema),
  }),
);

const isMultiSelectField = Schema.is(
  Schema.Struct({
    type: Schema.Literal("array"),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    items: Schema.Struct({
      anyOf: Schema.Array(choiceOptionSchema),
    }),
  }),
);

const isCompanionField = Schema.is(
  Schema.Struct({
    type: Schema.Literal("string"),
    title: Schema.Literal("Other"),
    description: Schema.optional(Schema.String),
  }),
);

function copyBoundedText(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}

function boundPrefix(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const prefix = trimmed.slice(0, limit - 3).replace(/[\uD800-\uDBFF]$/u, "");
  return copyBoundedText(`${prefix}...`);
}

function splitAppendedAttachments(
  value: string,
): { readonly prefix: string; readonly attachments: string } | undefined {
  const marker = value.indexOf("\n\n");
  if (marker < 0) return undefined;
  const attachments = value.slice(marker + 2);
  if (!ATTACHMENT_REFERENCE_PATTERN.test(attachments)) return undefined;
  return { prefix: value.slice(0, marker), attachments };
}

function hasExtraFieldKeys(
  record: Readonly<Record<string, unknown>>,
  forbidden: ReadonlyArray<string>,
): boolean {
  return forbidden.some((key) => key in record && record[key] !== undefined);
}

/**
 * Antigravity (`agy acp`) maps `ask_question` calls to ACP `elicitation/create` forms
 * with optional `qN` choice fields (single-select `oneOf` or multi-select `items.anyOf`)
 * paired with `qN_other` free-text fields. Fold each pair into a single question with
 * custom answers enabled so choosing "Other" does not leave `qN` failing form validation.
 */
export const extractAntigravityElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isForm(request.requestedSchema)) return undefined;
  const { properties, required } = request.requestedSchema;
  if (required !== undefined && required.length > 0) return undefined;

  const matchedIds: Array<{ readonly id: string; readonly index: number }> = [];
  for (const id of Object.keys(properties)) {
    const match = QUESTION_ID_PATTERN.exec(id);
    if (match !== null) {
      matchedIds.push({ id, index: Number(match[1]) });
    }
  }
  if (matchedIds.length === 0 || Object.keys(properties).length !== matchedIds.length * 2) {
    return undefined;
  }

  // Go serializes map keys lexicographically (`q1`, `q10`, `q2`); restore numeric order.
  matchedIds.sort((left, right) => left.index - right.index);

  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  const optionValuesById = new Map<string, ReadonlySet<string>>();

  for (const [position, { id }] of matchedIds.entries()) {
    const field = properties[id];
    const companion = properties[`${id}${COMPANION_SUFFIX}`];
    if (
      !Predicate.isObject(field) ||
      !Predicate.isObject(companion) ||
      !isCompanionField(companion) ||
      hasExtraFieldKeys(companion, ["enum", "oneOf", "anyOf", "items"])
    ) {
      return undefined;
    }

    let choices: ReadonlyArray<typeof choiceOptionSchema.Type>;
    let title: string;
    let multiSelect: boolean;
    if (isSingleSelectField(field)) {
      if (hasExtraFieldKeys(field, ["enum", "anyOf", "items"])) return undefined;
      choices = field.oneOf;
      title = field.title;
      multiSelect = false;
    } else if (isMultiSelectField(field)) {
      if (
        hasExtraFieldKeys(field, ["enum", "oneOf", "anyOf", "minItems", "maxItems"]) ||
        !Predicate.isObject(field.items) ||
        hasExtraFieldKeys(field.items, ["type", "enum", "oneOf"])
      ) {
        return undefined;
      }
      choices = field.items.anyOf;
      title = field.title;
      multiSelect = true;
    } else {
      return undefined;
    }

    if (choices.length === 0) return undefined;
    const optionValues = new Set<string>();
    const options: Array<OrchestrationV2UserInputQuestion["options"][number]> = [];
    for (const choice of choices) {
      if (optionValues.has(choice.const)) return undefined;
      optionValues.add(choice.const);
      const label = boundPrefix(choice.title, QUESTION_LABEL_LIMIT);
      const description = choice.description?.trim()
        ? boundPrefix(choice.description, QUESTION_LABEL_LIMIT)
        : label;
      options.push({ label, description, value: choice.const });
    }

    optionValuesById.set(id, optionValues);
    questions.push({
      id,
      header: `Question ${position + 1}`,
      question: boundPrefix(title, QUESTION_TEXT_LIMIT),
      options,
      ...(multiSelect ? { multiSelect: true } : {}),
    });
  }

  return {
    questions,
    respond: (answers) => {
      const entries: Array<[string, EffectAcpSchema.ElicitationContentValue]> = [];
      for (const question of questions) {
        const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        const optionValues = optionValuesById.get(question.id);
        const companionId = `${question.id}${COMPANION_SUFFIX}`;
        if (optionValues === undefined) return { action: "cancel" };

        if (question.multiSelect) {
          if (Array.isArray(answer)) {
            const selected: string[] = [];
            const seen = new Set<string>();
            const attachments: string[] = [];
            for (const entry of answer) {
              if (!Predicate.isString(entry)) return { action: "cancel" };
              if (optionValues.has(entry)) {
                if (!seen.has(entry)) {
                  seen.add(entry);
                  selected.push(entry);
                }
              } else if (ATTACHMENT_REFERENCE_PATTERN.test(entry)) {
                attachments.push(entry);
              } else {
                return { action: "cancel" };
              }
            }
            if (selected.length === 0 && attachments.length === 0) return { action: "cancel" };
            if (selected.length > 0) entries.push([question.id, selected]);
            if (attachments.length > 0) entries.push([companionId, attachments.join("\n")]);
          } else if (Predicate.isString(answer) && answer.trim().length > 0) {
            entries.push([companionId, answer]);
          } else {
            return { action: "cancel" };
          }
          continue;
        }

        if (!Predicate.isString(answer)) return { action: "cancel" };
        if (optionValues.has(answer)) {
          entries.push([question.id, answer]);
          continue;
        }
        const split = splitAppendedAttachments(answer);
        if (split !== undefined && optionValues.has(split.prefix)) {
          entries.push([question.id, split.prefix], [companionId, split.attachments]);
        } else if (answer.trim().length > 0) {
          entries.push([companionId, answer]);
        } else {
          return { action: "cancel" };
        }
      }
      return { action: "accept", content: Object.fromEntries(entries) };
    },
  };
};
