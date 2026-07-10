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

const SCENERY_TIME_OF_DAY = new Set(["dawn", "day", "dusk", "night"]);
const SCENERY_SEASON = new Set(["spring", "summer", "autumn", "winter"]);

/** Compact place name for scenery thread seeds. */
export function sanitizeSceneName(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ");

  if (!normalized || normalized.length === 0) {
    return "";
  }
  if (normalized.length <= 48) {
    return normalized;
  }
  return `${normalized.slice(0, 45).trimEnd()}...`;
}

type SceneryTimeOfDayTag = "dawn" | "day" | "dusk" | "night";
type ScenerySeasonTag = "spring" | "summer" | "autumn" | "winter";

type SceneryQuerySanitized = {
  text: string;
  timeOfDay?: SceneryTimeOfDayTag | undefined;
  season?: ScenerySeasonTag | undefined;
};

type SceneryLocationSanitized = {
  name: string;
  query: string;
  timeOfDay?: SceneryTimeOfDayTag | undefined;
  season?: ScenerySeasonTag | undefined;
};

function sanitizeOptionalTags(raw: {
  timeOfDay?: string | undefined;
  season?: string | undefined;
}): {
  timeOfDay?: SceneryTimeOfDayTag | undefined;
  season?: ScenerySeasonTag | undefined;
} {
  const timeOfDay =
    raw.timeOfDay && SCENERY_TIME_OF_DAY.has(raw.timeOfDay)
      ? (raw.timeOfDay as SceneryTimeOfDayTag)
      : undefined;
  const season =
    raw.season && SCENERY_SEASON.has(raw.season) ? (raw.season as ScenerySeasonTag) : undefined;
  return {
    ...(timeOfDay ? { timeOfDay } : {}),
    ...(season ? { season } : {}),
  };
}

/**
 * Normalise model scenery-set output: unique named locations (capped),
 * derived scene names, and non-empty general queries with optional valid tags.
 */
export function sanitizeScenerySetResult(input: {
  sceneNames?: ReadonlyArray<string> | undefined;
  queries?:
    | ReadonlyArray<{
        text: string;
        timeOfDay?: string | undefined;
        season?: string | undefined;
      }>
    | undefined;
  locations?:
    | ReadonlyArray<{
        name: string;
        query: string;
        timeOfDay?: string | undefined;
        season?: string | undefined;
      }>
    | undefined;
}): {
  sceneNames: string[];
  queries: SceneryQuerySanitized[];
  locations?: SceneryLocationSanitized[] | undefined;
} {
  const seenLocationNames = new Set<string>();
  const locations: SceneryLocationSanitized[] = [];
  for (const raw of input.locations ?? []) {
    const name = sanitizeSceneName(raw.name);
    const query = raw.query.trim().replace(/\s+/g, " ");
    if (!name || !query) continue;
    const key = name.toLowerCase();
    if (seenLocationNames.has(key)) continue;
    seenLocationNames.add(key);
    locations.push({
      name,
      query,
      ...sanitizeOptionalTags(raw),
    });
    // Hard cap: never exceed 16 locations even if the model returns more.
    if (locations.length >= 16) break;
  }

  const seenNames = new Set<string>();
  const sceneNames: string[] = [];
  // Prefer authentic place names from locations when present.
  const nameSources =
    locations.length > 0 ? locations.map((l) => l.name) : (input.sceneNames ?? []);
  for (const raw of nameSources) {
    const name = sanitizeSceneName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    sceneNames.push(name);
    if (sceneNames.length >= 40) break;
  }

  const seenQueries = new Set<string>();
  const queries: SceneryQuerySanitized[] = [];

  for (const raw of input.queries ?? []) {
    const text = raw.text.trim().replace(/\s+/g, " ");
    if (!text) continue;
    const key = text.toLowerCase();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);

    queries.push({
      text,
      ...sanitizeOptionalTags(raw),
    });
    // Cap general top-up queries (prompt asks 4–6) to bound Unsplash volume.
    if (queries.length >= 6) break;
  }

  return {
    sceneNames,
    queries,
    ...(locations.length > 0 ? { locations } : {}),
  };
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

function unknownErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    return typeof message === "string" ? message : null;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageReferencesCliExecutable(message: string, cliName: string): boolean {
  const escapedCliName = escapeRegExp(cliName);
  return new RegExp(`(?:^|[\\s:/\\\\])${escapedCliName}(?:$|[\\s:/\\\\.]|\\.exe\\b)`).test(message);
}

function isCliUnavailableMessage(message: string, cliName: string): boolean {
  const lower = message.toLowerCase();
  const lowerCliName = cliName.toLowerCase();
  return (
    lower.includes(`command not found: ${lowerCliName}`) ||
    (lower.includes("spawn") && messageReferencesCliExecutable(lower, lowerCliName))
  );
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

  const message = unknownErrorMessage(error);
  if (message && isCliUnavailableMessage(message, cliName)) {
    return new TextGenerationError({
      operation,
      detail: `${cliLabel(cliName)} is required but not available on PATH.`,
      cause: error,
    });
  }

  if (error instanceof Error) {
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
