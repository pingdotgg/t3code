/**
 * Devin surfaces `ask_user_question` over ACP form elicitation: each question
 * becomes one property of the requested schema. Single-select questions are
 * string properties with `oneOf` (const = option label, title = description);
 * multi-select questions are array properties whose items carry the same
 * options. Free-form questions are plain string properties.
 *
 * Devin currently sends the request with the unstable `_session/elicitation`
 * method name; adapters should also register the stable `session/elicitation`
 * handler so a future CLI promotion keeps working.
 */
import type { UserInputQuestion, ProviderUserInputAnswers } from "@t3tools/contracts";
import * as AcpSchema from "effect-acp/schema";

export const DEVIN_UNSTABLE_ELICITATION_METHOD = "_session/elicitation";

export const DevinElicitationRequest = AcpSchema.ElicitationRequest;

type ElicitationFormRequest = Extract<AcpSchema.ElicitationRequest, { readonly mode: "form" }>;
type ElicitationProperty = AcpSchema.ElicitationPropertySchema;

interface ElicitationOption {
  readonly label: string;
  readonly description: string;
}

function optionsFromEnumValues(values: ReadonlyArray<string>): Array<ElicitationOption> {
  return values
    .filter((value) => value.trim().length > 0)
    .map((value) => ({ label: value, description: value }));
}

function optionsFromEnumOptions(
  values: ReadonlyArray<AcpSchema.EnumOption>,
): Array<ElicitationOption> {
  return values
    .filter((option) => option.const.trim().length > 0)
    .map((option) => ({
      label: option.const,
      description: option.title.trim() || option.const,
    }));
}

function optionsFromProperty(property: ElicitationProperty): {
  readonly options: Array<ElicitationOption>;
  readonly multiSelect: boolean;
} {
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return { options: optionsFromEnumOptions(property.oneOf), multiSelect: false };
    }
    if (property.enum && property.enum.length > 0) {
      return { options: optionsFromEnumValues(property.enum), multiSelect: false };
    }
    return { options: [], multiSelect: false };
  }
  if (property.type === "array") {
    const items = property.items;
    const options =
      "anyOf" in items ? optionsFromEnumOptions(items.anyOf) : optionsFromEnumValues(items.enum);
    return { options, multiSelect: true };
  }
  return { options: [], multiSelect: false };
}

export function extractElicitationQuestions(
  request: ElicitationFormRequest,
): ReadonlyArray<UserInputQuestion> {
  const properties = request.requestedSchema.properties ?? {};
  const fallbackQuestion = request.message.trim() || "Provide input";
  return Object.entries(properties).map(([id, property]) => {
    const { options, multiSelect } = optionsFromProperty(property);
    const title = property.title?.trim();
    const description = property.description?.trim();
    return {
      id,
      header: title || "Question",
      question: description || title || fallbackQuestion,
      options,
      multiSelect,
    };
  });
}

function coerceAnswer(
  property: ElicitationProperty | undefined,
  answer: unknown,
): AcpSchema.ElicitationContentValue | undefined {
  const values = (Array.isArray(answer) ? answer : [answer]).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (values.length === 0) {
    if (property?.type === "boolean" && typeof answer === "boolean") {
      return answer;
    }
    if (
      (property?.type === "number" || property?.type === "integer") &&
      typeof answer === "number"
    ) {
      return answer;
    }
    return undefined;
  }
  // The UI answers with strings even for numeric and boolean properties, so
  // convert them back to the declared type; a string here would be
  // schema-invalid elicitation content and Devin would reject the answer.
  if (property?.type === "number" || property?.type === "integer") {
    if (values.length !== 1) return undefined;
    const numeric = Number(values[0]);
    if (!Number.isFinite(numeric)) return undefined;
    return property.type === "integer" && !Number.isInteger(numeric) ? undefined : numeric;
  }
  if (property?.type === "boolean") {
    const normalized = values[0]?.trim().toLowerCase();
    return normalized === "true" ? true : normalized === "false" ? false : undefined;
  }
  return property?.type === "array" ? values : values.join(", ");
}

/**
 * Maps the UI's answers (question id -> selected label(s) or free text) back
 * to the elicitation response content. Returns `undefined` when nothing was
 * answered so callers can respond with a `cancel` action instead.
 */
export function buildElicitationResponseContent(
  request: ElicitationFormRequest,
  answers: ProviderUserInputAnswers,
): Record<string, AcpSchema.ElicitationContentValue> | undefined {
  const properties = request.requestedSchema.properties ?? {};
  const content: Record<string, AcpSchema.ElicitationContentValue> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const coerced = coerceAnswer(properties[id], answer);
    if (coerced !== undefined) {
      content[id] = coerced;
    }
  }
  return Object.keys(content).length > 0 ? content : undefined;
}
