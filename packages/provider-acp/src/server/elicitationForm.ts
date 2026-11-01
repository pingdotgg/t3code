import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

import { unknownRecord } from "./clientPolicy.ts";

type Field =
  | { readonly kind: "text" }
  | { readonly kind: "number"; readonly integer: boolean }
  | { readonly kind: "boolean" }
  | { readonly kind: "choice"; readonly values: ReadonlySet<string> }
  | {
      readonly kind: "multiChoice";
      readonly values: ReadonlySet<string>;
      readonly minItems: number;
      readonly maxItems: number;
    };

type Option = OrchestrationV2UserInputQuestion["options"][number];

export interface ElicitationForm {
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  /**
   * Types answers as the schema declares them. Unknown keys and options are
   * dropped, as is an answer that does not fit its field. Returns undefined
   * when a required field is left without a valid answer.
   */
  readonly content: (
    answers: ProviderUserInputAnswers,
  ) => Record<string, EffectAcpSchema.ElicitationContentValue> | undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** All of `entries` as options, or undefined when any entry cannot be one. */
function choiceOptions(
  entries: unknown,
  toOption: (entry: unknown) => Option | undefined,
): Option[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const options = entries.map(toOption);
  return options.every((option) => option !== undefined) ? options : undefined;
}

/** `enum` values label themselves. */
function enumOption(value: unknown): Option | undefined {
  const label = text(value);
  return typeof value === "string" && label !== undefined
    ? { label, description: label, value }
    : undefined;
}

/** Titled entries (`oneOf` on strings, `anyOf` on array items) carry a title for their `const`. */
function titledOption(entry: unknown): Option | undefined {
  const option = unknownRecord(entry);
  const label = text(option?.title) ?? text(option?.const);
  return typeof option?.const === "string" && label !== undefined
    ? { label, description: text(option.description) ?? label, value: option.const }
    : undefined;
}

function parseField(
  property: Readonly<Record<string, unknown>>,
): { readonly field: Field; readonly options: Option[] } | undefined {
  switch (property.type) {
    case "string": {
      // ACP treats a null `enum` or `oneOf` like an omitted one.
      if ((property.enum ?? property.oneOf ?? undefined) === undefined) {
        return { field: { kind: "text" }, options: [] };
      }
      const options = Array.isArray(property.oneOf)
        ? choiceOptions(property.oneOf, titledOption)
        : choiceOptions(property.enum, enumOption);
      return options === undefined
        ? undefined
        : {
            field: { kind: "choice", values: new Set(options.map(optionValue)) },
            options,
          };
    }
    case "array": {
      // String items list plain values in `enum`; titled items list `{ const, title }` in `anyOf`.
      const items = unknownRecord(property.items);
      const options =
        items?.type === "string"
          ? choiceOptions(items.enum, enumOption)
          : items !== undefined && items.type === undefined
            ? choiceOptions(items.anyOf, titledOption)
            : undefined;
      if (options === undefined) return undefined;
      // The schema decode already limits counts to non-negative integers.
      const values = new Set(options.map(optionValue));
      const minItems = typeof property.minItems === "number" ? property.minItems : 0;
      const maxItems = typeof property.maxItems === "number" ? property.maxItems : Infinity;
      // Clients require a selection, so empty-only questions cannot be answered.
      if (maxItems === 0 || minItems > maxItems || minItems > values.size) return undefined;
      return { field: { kind: "multiChoice", values, minItems, maxItems }, options };
    }
    case "boolean":
      return {
        field: { kind: "boolean" },
        options: [
          { label: "true", description: "Yes", value: "true" },
          { label: "false", description: "No", value: "false" },
        ],
      };
    case "number":
    case "integer":
      return { field: { kind: "number", integer: property.type === "integer" }, options: [] };
    default:
      return undefined;
  }
}

function optionValue(option: Option): string {
  return option.value ?? option.label;
}

function typedAnswer(
  field: Field,
  answer: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  switch (field.kind) {
    case "text":
      return typeof answer === "string" ? answer : undefined;
    case "boolean":
      if (typeof answer === "boolean") return answer;
      return answer === "true" ? true : answer === "false" ? false : undefined;
    case "number": {
      const parsed =
        typeof answer === "number"
          ? answer
          : typeof answer === "string" && answer.trim().length > 0
            ? Number(answer.trim())
            : Number.NaN;
      if (!Number.isFinite(parsed)) return undefined;
      return field.integer && !Number.isInteger(parsed) ? undefined : parsed;
    }
    case "choice":
      return typeof answer === "string" && field.values.has(answer) ? answer : undefined;
    case "multiChoice": {
      if (!Array.isArray(answer)) return undefined;
      const selected = [
        ...new Set(
          answer.filter(
            (entry): entry is string => typeof entry === "string" && field.values.has(entry),
          ),
        ),
      ];
      // `[]` is an explicit empty selection, but a selection of only unknown
      // options is not one.
      if (selected.length === 0 && answer.length > 0) return undefined;
      return selected.length >= field.minItems && selected.length <= field.maxItems
        ? selected
        : undefined;
    }
  }
}

// Decline unaskable forms; validate types and selection counts, leaving other constraints to the agent.
export function parseElicitationForm(
  requestedSchema: unknown,
  message: string,
): ElicitationForm | undefined {
  const schema = unknownRecord(requestedSchema);
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const fields = new Map<string, Field>();
  const questions: OrchestrationV2UserInputQuestion[] = [];
  for (const [id, value] of Object.entries(unknownRecord(schema?.properties) ?? {})) {
    const property = unknownRecord(value);
    const parsed = property === undefined ? undefined : parseField(property);
    // Question ids must survive the contract's trim to round-trip answers.
    if (property === undefined || parsed === undefined || text(id) !== id) return undefined;
    fields.set(id, parsed.field);
    questions.push({
      id,
      header: text(property.title) ?? `Question ${questions.length + 1}`,
      question: text(property.description) ?? message,
      options: parsed.options,
      ...(parsed.field.kind === "text" || parsed.field.kind === "number"
        ? {}
        : { allowCustomAnswer: false }),
      ...(parsed.field.kind === "multiChoice" ? { multiSelect: true } : {}),
    });
  }
  return {
    questions,
    content: (answers) => {
      const entries: Array<[string, EffectAcpSchema.ElicitationContentValue]> = [];
      for (const [id, field] of fields) {
        const typed = Object.hasOwn(answers, id) ? typedAnswer(field, answers[id]) : undefined;
        if (typed !== undefined) entries.push([id, typed]);
        else if (required.has(id)) return undefined;
      }
      // Own properties for every field, `__proto__` included; assigning to
      // `{}` would hit its inherited setter instead.
      return Object.fromEntries(entries);
    },
  };
}
