import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type {
  BranchNameGenerationResult,
  CommitMessageGenerationResult,
  PrContentGenerationResult,
  ThreadTitleGenerationResult,
} from "./TextGeneration.ts";

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

type BranchSanitizer = (raw: string) => string;

export function makeCommitMessageGenerationResult(input: {
  readonly generated: {
    readonly subject: string;
    readonly body: string;
    readonly branch?: unknown;
  };
  readonly includeBranch: boolean;
  readonly sanitizeBranch: BranchSanitizer;
}): CommitMessageGenerationResult {
  return {
    subject: sanitizeCommitSubject(input.generated.subject),
    body: input.generated.body.trim(),
    ...(input.includeBranch && typeof input.generated.branch === "string"
      ? { branch: input.sanitizeBranch(input.generated.branch) }
      : {}),
  };
}

export function makePrContentGenerationResult(input: {
  readonly title: string;
  readonly body: string;
}): PrContentGenerationResult {
  return {
    title: sanitizePrTitle(input.title),
    body: input.body.trim(),
  };
}

export function makeBranchNameGenerationResult(
  input: { readonly branch: string },
  sanitizeBranch: BranchSanitizer,
): BranchNameGenerationResult {
  return {
    branch: sanitizeBranch(input.branch),
  };
}

export function makeThreadTitleGenerationResult(input: {
  readonly title: string;
}): ThreadTitleGenerationResult {
  return {
    title: sanitizeThreadTitle(input.title),
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
