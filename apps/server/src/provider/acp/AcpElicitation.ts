import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

type FormElicitationRequest = Extract<
  EffectAcpSchema.ElicitationRequest,
  { readonly mode: "form" }
>;
type ElicitationProperty = EffectAcpSchema.ElicitationPropertySchema;
type ElicitationValue = EffectAcpSchema.ElicitationContentValue;

interface ElicitationChoice {
  readonly label: string;
  readonly value: string;
}

export interface AcpElicitationForm {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly resolve: (answers: ProviderUserInputAnswers) => EffectAcpSchema.ElicitationResponse;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function choicesForProperty(property: ElicitationProperty): ReadonlyArray<ElicitationChoice> {
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      return property.oneOf.map((option) => ({
        label: nonEmpty(option.title) ?? option.const,
        value: option.const,
      }));
    }
    return (property.enum ?? []).map((value) => ({ label: value, value }));
  }
  if (property.type === "boolean") {
    return [
      { label: "Yes", value: "true" },
      { label: "No", value: "false" },
    ];
  }
  if (property.type === "array") {
    if ("anyOf" in property.items) {
      return property.items.anyOf.map((option) => ({
        label: nonEmpty(option.title) ?? option.const,
        value: option.const,
      }));
    }
    return property.items.enum.map((value) => ({ label: value, value }));
  }
  return [];
}

function questionForProperty(input: {
  readonly request: FormElicitationRequest;
  readonly id: string;
  readonly property: ElicitationProperty;
  readonly propertyCount: number;
}): UserInputQuestion {
  const { request, id, property, propertyCount } = input;
  const choices = choicesForProperty(property);
  const propertyTitle = nonEmpty(property.title);
  const formTitle = nonEmpty(request.requestedSchema.title);
  const requestMessage = nonEmpty(request.message) ?? "The agent needs additional input.";
  const propertyDescription = nonEmpty(property.description);

  return {
    id,
    header: propertyTitle ?? formTitle ?? "Question",
    question: propertyDescription ?? (propertyCount === 1 ? requestMessage : (propertyTitle ?? id)),
    options: choices.map((choice) => ({
      label: choice.label,
      description: choice.label === choice.value ? choice.label : choice.value,
    })),
    ...(property.type === "array" ? { multiSelect: true } : {}),
  };
}

function firstAnswer(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function labelToValue(property: ElicitationProperty, raw: string): string {
  const choice = choicesForProperty(property).find((candidate) => candidate.label === raw);
  return choice?.value ?? raw;
}

function resolvePropertyValue(
  property: ElicitationProperty,
  rawAnswer: unknown,
): ElicitationValue | undefined {
  if (rawAnswer === undefined || rawAnswer === null) {
    return property.default ?? undefined;
  }

  switch (property.type) {
    case "string": {
      const raw = firstAnswer(rawAnswer);
      if (typeof raw !== "string") return undefined;
      return labelToValue(property, raw);
    }
    case "boolean": {
      const raw = firstAnswer(rawAnswer);
      if (typeof raw === "boolean") return raw;
      if (typeof raw !== "string") return undefined;
      const normalized = labelToValue(property, raw).trim().toLowerCase();
      if (normalized === "true" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "no") return false;
      return undefined;
    }
    case "integer":
    case "number": {
      const raw = firstAnswer(rawAnswer);
      const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isFinite(parsed)) return undefined;
      if (property.type === "integer" && !Number.isInteger(parsed)) return undefined;
      return parsed;
    }
    case "array": {
      const rawValues = Array.isArray(rawAnswer) ? rawAnswer : [rawAnswer];
      if (!rawValues.every((value) => typeof value === "string")) return undefined;
      return rawValues.map((value) => labelToValue(property, value));
    }
  }
}

/**
 * Project an ACP form elicitation onto T3 Code's provider-neutral structured
 * question surface. URL elicitations are intentionally not handled because
 * the client advertises only `elicitation.form` support.
 */
export function buildAcpElicitationForm(
  request: EffectAcpSchema.ElicitationRequest,
): AcpElicitationForm | undefined {
  if (request.mode !== "form") return undefined;

  const propertyEntries = Object.entries(request.requestedSchema.properties ?? {});
  if (propertyEntries.length === 0) return undefined;
  const required = new Set(request.requestedSchema.required ?? []);
  // T3's structured user-input surface currently renders selectable options
  // only. A required optionless question cannot be answered, so cancel the
  // whole form. Optional optionless properties are omitted and resolve as
  // absent.
  if (
    propertyEntries.some(
      ([id, property]) => required.has(id) && choicesForProperty(property).length === 0,
    )
  ) {
    return undefined;
  }

  const questionEntries = propertyEntries.filter(
    ([, property]) => choicesForProperty(property).length > 0,
  );
  const questions = questionEntries.map(([id, property]) =>
    questionForProperty({
      request,
      id,
      property,
      propertyCount: questionEntries.length,
    }),
  );

  return {
    questions,
    resolve: (answers) => {
      const content: Record<string, ElicitationValue> = {};
      for (const [id, property] of propertyEntries) {
        const value = resolvePropertyValue(property, answers[id]);
        if (value === undefined) {
          if (required.has(id)) {
            return { action: { action: "cancel" } };
          }
          continue;
        }
        content[id] = value;
      }
      return { action: { action: "accept", content } };
    },
  };
}
