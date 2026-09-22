import type { FormInfo, FormAnswer } from "@opencode/client";
import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OpenCode2RequestError } from "./OpenCode2Client.ts";
const decodeAnswer = Schema.decodeUnknownEffect(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);

/** T3 cannot render conditional or external forms; decline rather than dropping constraints. */
export function supported(form: FormInfo): boolean {
  return form.fields.every(
    (field) => field.type !== "external" && !field.hidden && !field.when?.length,
  );
}

export function questions(form: FormInfo): OrchestrationV2UserInputQuestion[] {
  return form.fields.map((field) => ({
    id: field.key,
    header: field.title || form.title,
    question: field.description || field.title || field.key,
    required: "required" in field && field.required === true,
    multiSelect: field.type === "multiselect",
    allowCustomAnswer:
      field.type === "string" || field.type === "multiselect"
        ? field.custom !== false
        : field.type !== "boolean",
    options:
      field.type === "boolean"
        ? [
            { label: "Yes", value: "true", description: "Yes" },
            { label: "No", value: "false", description: "No" },
          ]
        : "options" in field
          ? (field.options ?? []).map((option) => ({
              label: option.label,
              value: option.value,
              description: option.label,
            }))
          : [],
  }));
}

/** Preserve text verbatim and let the native server validate format/pattern constraints. */
export const answer = Effect.fn("OpenCode2Forms.answer")(function* (
  form: FormInfo,
  answers: ProviderUserInputAnswers,
) {
  const result: FormAnswer = Object.create(null);
  for (const field of form.fields) {
    const raw = answers[field.key];
    const decoded =
      raw === undefined
        ? []
        : yield* decodeAnswer(raw).pipe(
            Effect.mapError(
              (cause) => new OpenCode2RequestError({ operation: "form.answer", cause }),
            ),
          );
    const values = typeof decoded === "string" ? [decoded] : decoded;
    const value = values[0];
    if (value === undefined || value === "") {
      if ("required" in field && field.required)
        return yield* new OpenCode2RequestError({ operation: "form.required" });
      continue;
    }
    switch (field.type) {
      case "string":
        result[field.key] = value;
        break;
      case "multiselect":
        result[field.key] = [...values];
        break;
      case "boolean":
        if (value !== "true" && value !== "false")
          return yield* new OpenCode2RequestError({ operation: "form.boolean" });
        result[field.key] = value === "true";
        break;
      case "number":
      case "integer": {
        const number = Number(value);
        if (
          value.trim() === "" ||
          !Number.isFinite(number) ||
          (field.type === "integer" && !Number.isInteger(number))
        )
          return yield* new OpenCode2RequestError({ operation: "form.number" });
        result[field.key] = number;
        break;
      }
      case "external":
        return yield* new OpenCode2RequestError({ operation: "form.external" });
    }
  }
  return result;
});
