/**
 * AcpElicitation — maps the ACP `session/elicitation` request onto T3 Code's
 * existing structured user-input flow (the same channel used for xAI's
 * `ask_user_question`), and maps the collected answers back to an
 * `ElicitationResponse`.
 *
 * Why this exists: agents such as Kiro can pause a turn to ask the user for a
 * decision/confirmation via `session/elicitation`. Without a registered
 * handler the ACP client answers `methodNotFound`, so the agent's turn stalls
 * with no visible prompt. Routing elicitation through `user-input.requested`
 * surfaces the prompt in the UI and lets the user answer it.
 *
 * Only the `form` elicitation mode is supported (we advertise `elicitation.form`
 * as a client capability). `url` mode cannot be rendered here and is declined.
 *
 * @module provider/acp/AcpElicitation
 */
import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

/** Loose view over a single form property; the generated schema is a union. */
interface ElicitationPropertyLike {
  readonly type?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly enum?: ReadonlyArray<string> | null;
  readonly oneOf?: ReadonlyArray<{ readonly const: string; readonly title: string }> | null;
}

const HEADER_MAX_LENGTH = 200;

function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length > 0 ? text : undefined;
}

function truncateHeader(value: string): string {
  return value.length > HEADER_MAX_LENGTH ? `${value.slice(0, HEADER_MAX_LENGTH - 1)}…` : value;
}

function formRequestedSchema(request: EffectAcpSchema.ElicitationRequest): {
  properties: Record<string, ElicitationPropertyLike>;
  title?: string;
  description?: string;
} {
  if (request.mode !== "form") {
    return { properties: {} };
  }
  const schema = request.requestedSchema;
  return {
    properties: (schema.properties ?? {}) as Record<string, ElicitationPropertyLike>,
    ...(trimmed(schema.title) ? { title: trimmed(schema.title)! } : {}),
    ...(trimmed(schema.description) ? { description: trimmed(schema.description)! } : {}),
  };
}

function optionsForProperty(
  property: ElicitationPropertyLike,
): ReadonlyArray<{ readonly label: string; readonly description: string }> {
  if (property.type === "boolean") {
    return [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ];
  }
  if (Array.isArray(property.oneOf) && property.oneOf.length > 0) {
    return property.oneOf.flatMap((option) => {
      const label = trimmed(option.title) ?? trimmed(option.const);
      const description = trimmed(option.const) ?? trimmed(option.title);
      return label && description ? [{ label, description }] : [];
    });
  }
  if (Array.isArray(property.enum) && property.enum.length > 0) {
    return property.enum.flatMap((value) => {
      const label = trimmed(value);
      return label ? [{ label, description: label }] : [];
    });
  }
  // Free-form string / number: no fixed options (rendered as a text input).
  return [];
}

/**
 * Projects a form-mode elicitation onto the structured user-input questions the
 * UI already renders. Non-form modes yield no questions (declined upstream).
 */
export function extractElicitationQuestions(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode !== "form") {
    return [];
  }
  const schema = formRequestedSchema(request);
  const header = truncateHeader(trimmed(request.message) ?? schema.title ?? "Input requested");
  const keys = Object.keys(schema.properties);
  if (keys.length === 0) {
    return [
      {
        id: "confirm",
        header,
        question: schema.description ?? trimmed(request.message) ?? "Please confirm to continue.",
        options: [{ label: "Continue", description: "Proceed" }],
        multiSelect: false,
      },
    ];
  }
  return keys.map((key) => {
    const property = schema.properties[key]!;
    return {
      id: key,
      header,
      question: trimmed(property.description) ?? trimmed(property.title) ?? key,
      options: optionsForProperty(property),
      multiSelect: false,
    } satisfies UserInputQuestion;
  });
}

function firstAnswerString(answer: unknown): string | undefined {
  if (Array.isArray(answer)) {
    for (const entry of answer) {
      const text = typeof entry === "string" ? trimmed(entry) : undefined;
      if (text) {
        return text;
      }
    }
    return undefined;
  }
  if (typeof answer === "string") {
    return trimmed(answer);
  }
  if (typeof answer === "boolean" || typeof answer === "number") {
    return String(answer);
  }
  return undefined;
}

function coerceAnswer(
  property: ElicitationPropertyLike,
  answer: unknown,
): EffectAcpSchema.ElicitationContentValue | undefined {
  const value = firstAnswerString(answer);
  if (value === undefined) {
    return undefined;
  }
  if (property.type === "boolean") {
    return value === "Yes" || value.toLowerCase() === "true";
  }
  if (property.type === "number" || property.type === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return property.type === "integer" ? Math.trunc(parsed) : parsed;
  }
  if (Array.isArray(property.oneOf) && property.oneOf.length > 0) {
    const match = property.oneOf.find((option) => option.title === value || option.const === value);
    return match ? match.const : value;
  }
  return value;
}

/**
 * Builds an `accept` elicitation response, coercing the collected answers into
 * the primitive content values the requested schema expects.
 */
export function makeElicitationAcceptedResponse(
  request: EffectAcpSchema.ElicitationRequest,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.ElicitationResponse {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  if (request.mode === "form") {
    const properties = (request.requestedSchema.properties ?? {}) as Record<
      string,
      ElicitationPropertyLike
    >;
    for (const key of Object.keys(properties)) {
      const value = coerceAnswer(properties[key]!, answers[key]);
      if (value !== undefined) {
        content[key] = value;
      }
    }
  }
  return { action: { action: "accept", content } };
}

/** Declines the elicitation (user cancelled, or an unsupported mode). */
export function makeElicitationDeclinedResponse(): EffectAcpSchema.ElicitationResponse {
  return { action: { action: "decline" } };
}
