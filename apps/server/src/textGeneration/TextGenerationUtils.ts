import { TextGenerationError } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Schema from "effect/Schema";

/** Guard against pathological nesting when unwrapping a self-wrapped title. */
const MAX_TITLE_UNWRAP_DEPTH = 5;

/**
 * Some models ignore the structured-output contract and emit the whole JSON
 * envelope as the field's value, so a title comes back as the literal string
 * `{"title": "Fix the flaky test"}` instead of `Fix the flaky test`. Detect
 * that shape and unwrap the inner value, recursing to handle double-wrapping.
 *
 * When the object has a single string value we take it regardless of the key
 * name (models label it `title`, `name`, `summary`, ...). Only when several
 * keys make that ambiguous do we prefer a string `title`. Anything that is not
 * a JSON object with such a value is returned as-is.
 */
export function unwrapJsonEnvelopeTitle(raw: string): string {
  let current = raw.trim();
  for (let depth = 0; depth < MAX_TITLE_UNWRAP_DEPTH && current.includes("{"); depth += 1) {
    const candidate = extractJsonObject(current);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return current;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return current;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const stringEntries = entries.filter(([, value]) => typeof value === "string");
    let unwrapped: string | undefined;
    if (stringEntries.length === 1) {
      // Single string value: use it whatever the key is called.
      unwrapped = stringEntries[0]?.[1] as string;
    } else if (stringEntries.length > 1) {
      // Ambiguous: disambiguate with a `title` key when present.
      const title = (parsed as { title?: unknown }).title;
      if (typeof title === "string") {
        unwrapped = title;
      }
    }
    if (unwrapped === undefined) {
      return current;
    }
    current = unwrapped.trim();
  }
  return current;
}

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
  const singleLine = unwrapJsonEnvelopeTitle(raw).split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = unwrapJsonEnvelopeTitle(raw)
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
