import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

function trimmedString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function optionDescription(label: string, fallback: string | undefined): string {
  return trimmedString(fallback) ?? label;
}

function enumOptionMaps(entries: ReadonlyArray<EffectAcpSchema.EnumOption>): {
  readonly options: UserInputQuestion["options"];
  readonly valuesByLabel: ReadonlyMap<string, string>;
} {
  const valuesByLabel = new Map<string, string>();
  const options = entries.flatMap((entry) => {
    const label = trimmedString(entry.title) ?? trimmedString(entry.const);
    const value = trimmedString(entry.const);
    if (!label || !value) {
      return [];
    }
    valuesByLabel.set(label, value);
    return [
      {
        label,
        description: optionDescription(label, value),
      },
    ];
  });
  return { options, valuesByLabel };
}

function stringEnumOptionMaps(values: ReadonlyArray<string>): {
  readonly options: UserInputQuestion["options"];
  readonly valuesByLabel: ReadonlyMap<string, string>;
} {
  const valuesByLabel = new Map<string, string>();
  const options = values.flatMap((entry) => {
    const label = trimmedString(entry);
    if (!label) {
      return [];
    }
    valuesByLabel.set(label, label);
    return [{ label, description: label }];
  });
  return { options, valuesByLabel };
}

function answerStrings(answer: unknown): ReadonlyArray<string> {
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const value = typeof entry === "string" ? trimmedString(entry) : undefined;
      return value ? [value] : [];
    });
  }
  if (typeof answer !== "string") {
    return [];
  }
  const value = trimmedString(answer);
  return value ? [value] : [];
}

function normalizeStringAnswer(
  answer: unknown,
  valuesByLabel: ReadonlyMap<string, string>,
  fallback: string | null | undefined,
): string | undefined {
  const value = answerStrings(answer)[0] ?? trimmedString(fallback);
  return value ? (valuesByLabel.get(value) ?? value) : undefined;
}

function normalizeStringArrayAnswer(
  answer: unknown,
  valuesByLabel: ReadonlyMap<string, string>,
  fallback: ReadonlyArray<string> | null | undefined,
): ReadonlyArray<string> | undefined {
  const values = Array.isArray(answer)
    ? answerStrings(answer)
    : typeof answer === "string"
      ? answer
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : (fallback ?? []).flatMap((entry) => {
          const value = trimmedString(entry);
          return value ? [value] : [];
        });
  const normalized = values.map((value) => valuesByLabel.get(value) ?? value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeNumberAnswer(
  answer: unknown,
  fallback: number | null | undefined,
  integer: boolean,
): number | undefined {
  const value =
    typeof answer === "number"
      ? answer
      : typeof answer === "string"
        ? Number(answer.trim())
        : fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (integer && !Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

function normalizeBooleanAnswer(
  answer: unknown,
  fallback: boolean | null | undefined,
): boolean | undefined {
  if (typeof answer === "boolean") {
    return answer;
  }
  if (typeof answer === "string") {
    const normalized = answer.trim().toLowerCase();
    if (normalized === "yes" || normalized === "true") {
      return true;
    }
    if (normalized === "no" || normalized === "false") {
      return false;
    }
  }
  return typeof fallback === "boolean" ? fallback : undefined;
}

interface DevinElicitationQuestionMapping {
  readonly id: string;
  readonly question: UserInputQuestion;
  readonly toContentValue: (answer: unknown) => EffectAcpSchema.ElicitationContentValue | undefined;
}

export interface DevinElicitationPrompt {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly makeResponse: (answers: ProviderUserInputAnswers) => EffectAcpSchema.ElicitationResponse;
}

function makeDevinElicitationQuestion(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
  id: string,
  property: EffectAcpSchema.ElicitationPropertySchema,
): DevinElicitationQuestionMapping | undefined {
  const schema = request.requestedSchema;
  const header = trimmedString(schema.title) ?? "Question";
  const title = trimmedString(property.title) ?? id;
  const question = trimmedString(property.description) ?? title;

  switch (property.type) {
    case "string": {
      const mappedOptions =
        property.oneOf && property.oneOf.length > 0
          ? enumOptionMaps(property.oneOf)
          : property.enum && property.enum.length > 0
            ? stringEnumOptionMaps(property.enum)
            : { options: [], valuesByLabel: new Map<string, string>() };
      return {
        id,
        question: {
          id,
          header,
          question,
          options: mappedOptions.options,
          multiSelect: false,
        },
        toContentValue: (answer) =>
          normalizeStringAnswer(answer, mappedOptions.valuesByLabel, property.default),
      };
    }
    case "number":
    case "integer":
      return {
        id,
        question: {
          id,
          header,
          question,
          options: [],
          multiSelect: false,
        },
        toContentValue: (answer) =>
          normalizeNumberAnswer(answer, property.default, property.type === "integer"),
      };
    case "boolean":
      return {
        id,
        question: {
          id,
          header,
          question,
          options: [
            { label: "Yes", description: "True" },
            { label: "No", description: "False" },
          ],
          multiSelect: false,
        },
        toContentValue: (answer) => normalizeBooleanAnswer(answer, property.default),
      };
    case "array": {
      const mappedOptions =
        "anyOf" in property.items
          ? enumOptionMaps(property.items.anyOf)
          : stringEnumOptionMaps(property.items.enum);
      return {
        id,
        question: {
          id,
          header,
          question,
          options: mappedOptions.options,
          multiSelect: true,
        },
        toContentValue: (answer) =>
          normalizeStringArrayAnswer(answer, mappedOptions.valuesByLabel, property.default),
      };
    }
  }
}

function makeDevinFormElicitationPrompt(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
): DevinElicitationPrompt {
  const properties = request.requestedSchema.properties ?? {};
  const required = new Set(request.requestedSchema.required ?? []);
  const mappings = Object.entries(properties).flatMap(([id, property]) => {
    const mapping = makeDevinElicitationQuestion(request, id, property);
    return mapping ? [mapping] : [];
  });

  if (mappings.length === 0) {
    const id = "__devin_elicitation_continue";
    const question = {
      id,
      header: trimmedString(request.requestedSchema.title) ?? "Question",
      question: trimmedString(request.message) ?? "Continue?",
      options: [{ label: "Continue", description: "Continue" }],
      multiSelect: false,
    } satisfies UserInputQuestion;
    return {
      questions: [question],
      makeResponse: () => ({ action: { action: "accept" } }),
    };
  }

  return {
    questions: mappings.map((mapping) => mapping.question),
    makeResponse: (answers) => {
      const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
      for (const mapping of mappings) {
        const value = mapping.toContentValue(answers[mapping.id]);
        if (value === undefined) {
          if (required.has(mapping.id)) {
            return { action: { action: "decline" } };
          }
          continue;
        }
        content[mapping.id] = value;
      }
      return {
        action: {
          action: "accept",
          ...(Object.keys(content).length > 0 ? { content } : {}),
        },
      };
    },
  };
}

function makeDevinUrlElicitationPrompt(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "url" }>,
): DevinElicitationPrompt {
  const id = "__devin_elicitation_url";
  return {
    questions: [
      {
        id,
        header: "Devin",
        question: `${request.message}\n${request.url}`,
        options: [
          { label: "Done", description: "Continue after completing the request" },
          { label: "Cancel", description: "Cancel this request" },
        ],
        multiSelect: false,
      },
    ],
    makeResponse: (answers) => {
      const answer = normalizeStringAnswer(answers[id], new Map(), undefined);
      return answer === "Cancel"
        ? { action: { action: "cancel" } }
        : { action: { action: "accept" } };
    },
  };
}

export function makeDevinElicitationPrompt(
  request: EffectAcpSchema.ElicitationRequest,
): DevinElicitationPrompt {
  return request.mode === "form"
    ? makeDevinFormElicitationPrompt(request)
    : makeDevinUrlElicitationPrompt(request);
}
