import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47).trimEnd()}...`;
}

/**
 * Normalise a raw thread-review generation into the service result shape:
 * collapse whitespace, drop empty/no-op title suggestions, and force
 * `recommendSettle` off for active threads regardless of model output.
 */
export function normalizeThreadReview(
  raw: {
    summary: string;
    nextStep: string;
    suggestedTitle: string | null;
    recommendSettle: boolean;
    settleReason: string | null;
  },
  isActive: boolean,
): {
  summary: string;
  nextStep: string;
  suggestedTitle: string | null;
  recommendSettle: boolean;
  settleReason: string | null;
} {
  const summary = raw.summary.trim().replace(/\s+/g, " ");
  // Backstop against rambling: first sentence only, hard-capped. The prompt
  // asks for a <=10-word command, but models drift — never render a recap.
  const nextStepFirstSentence =
    raw.nextStep
      .trim()
      .replace(/\s+/g, " ")
      .match(/^[^.!?]*[.!?]?/)?.[0]
      ?.trim() ?? "";
  const nextStep =
    nextStepFirstSentence.length > 80
      ? `${nextStepFirstSentence.slice(0, 77).trimEnd()}...`
      : nextStepFirstSentence;
  const suggestedTitle =
    raw.suggestedTitle && raw.suggestedTitle.trim().length > 0
      ? sanitizeThreadTitle(raw.suggestedTitle)
      : null;
  const recommendSettle = raw.recommendSettle && !isActive;
  const settleReason =
    recommendSettle && raw.settleReason && raw.settleReason.trim().length > 0
      ? raw.settleReason.trim().replace(/\s+/g, " ")
      : null;
  return {
    summary: summary.length > 0 ? summary : "No summary available.",
    nextStep: nextStep.length > 0 ? nextStep : "Review this thread.",
    suggestedTitle: suggestedTitle === "New thread" ? null : suggestedTitle,
    recommendSettle,
    settleReason,
  };
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
