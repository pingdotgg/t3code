import { Schema } from "effect";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import { randomUUID } from "~/lib/utils";

export interface ComposerSnippet {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly keywords: readonly string[];
  readonly source: "built-in" | "saved";
  readonly updatedAt: string | null;
  readonly savedSnippetId: string | null;
  readonly deletable: boolean;
}

export const COMPOSER_SNIPPETS: readonly ComposerSnippet[] = [
  {
    id: "implement-feature",
    title: "Implement Feature",
    description: "Scope an implementation and ship it with the right tests.",
    keywords: ["build", "feature", "implementation", "ship"],
    body: `Implement this feature carefully.

Goal:
- describe the user-facing outcome

Constraints:
- keep the change scoped
- preserve existing behavior unless required
- add or update tests for the new behavior

Deliver:
- concise summary of what changed
- note any follow-up work`,
    source: "built-in",
    updatedAt: null,
    savedSnippetId: null,
    deletable: false,
  },
  {
    id: "debug-issue",
    title: "Debug Issue",
    description: "Investigate a bug, find the root cause, and propose the safest fix.",
    keywords: ["debug", "bug", "investigate", "root cause", "fix"],
    body: `Help me debug this issue.

What I expected:
- ...

What happened instead:
- ...

Please:
- identify the most likely root cause
- propose the smallest safe fix
- add or update regression coverage`,
    source: "built-in",
    updatedAt: null,
    savedSnippetId: null,
    deletable: false,
  },
  {
    id: "write-tests",
    title: "Write Tests",
    description: "Add focused coverage for the happy path, edge cases, and regressions.",
    keywords: ["tests", "coverage", "regression", "vitest"],
    body: `Add or update tests for this change.

Focus on:
- the happy path
- the important edge case
- the regression that would catch this bug again

Use the smallest test surface that proves the behavior.`,
    source: "built-in",
    updatedAt: null,
    savedSnippetId: null,
    deletable: false,
  },
  {
    id: "review-change",
    title: "Review Change",
    description: "Review a diff for bugs, regressions, missing tests, and simpler alternatives.",
    keywords: ["review", "diff", "regression", "bugs", "feedback"],
    body: `Review this change like a senior engineer.

Focus on:
- bugs and behavioral regressions
- missing tests
- risky edge cases
- simpler implementations if appropriate

List findings first, ordered by severity.`,
    source: "built-in",
    updatedAt: null,
    savedSnippetId: null,
    deletable: false,
  },
  {
    id: "refactor-cleanup",
    title: "Refactor Cleanup",
    description: "Simplify a code path while keeping behavior and performance intact.",
    keywords: ["refactor", "cleanup", "duplication", "maintainability"],
    body: `Refactor this area for clarity and maintainability.

Please:
- reduce duplication
- keep behavior unchanged
- preserve performance characteristics
- add or update tests if behavior is easy to regress`,
    source: "built-in",
    updatedAt: null,
    savedSnippetId: null,
    deletable: false,
  },
] as const;

export const SAVED_COMPOSER_SNIPPETS_STORAGE_KEY = "t3code:composer-snippets:v1";

export const SavedComposerSnippetRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  body: Schema.NonEmptyString,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type SavedComposerSnippetRecord = typeof SavedComposerSnippetRecord.Type;

export const SavedComposerSnippetList = Schema.Array(SavedComposerSnippetRecord);
export type SavedComposerSnippetList = typeof SavedComposerSnippetList.Type;

function truncateSnippetText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeSnippetWhitespace(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function normalizeComposerSnippetBody(value: string): string {
  return normalizeSnippetWhitespace(value);
}

export function summarizeComposerSnippetTitle(value: string): string {
  const normalized = normalizeSnippetWhitespace(value);
  if (!normalized) {
    return "Untitled snippet";
  }
  const firstNonEmptyLine = normalized
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return truncateSnippetText(firstNonEmptyLine ?? "Untitled snippet", 48);
}

export function summarizeComposerSnippetDescription(value: string): string {
  const normalized = normalizeSnippetWhitespace(value);
  if (!normalized) {
    return "Reusable saved snippet";
  }
  return truncateSnippetText(normalized.replace(/\s+/g, " "), 120);
}

export function buildComposerSnippetLibrary(
  savedSnippets: ReadonlyArray<SavedComposerSnippetRecord>,
): ComposerSnippet[] {
  const savedEntries = savedSnippets
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    )
    .map(
      (snippet) =>
        ({
          id: `saved:${snippet.id}`,
          title: summarizeComposerSnippetTitle(snippet.body),
          description: summarizeComposerSnippetDescription(snippet.body),
          body: snippet.body,
          keywords: [],
          source: "saved",
          updatedAt: snippet.updatedAt,
          savedSnippetId: snippet.id,
          deletable: true,
        }) satisfies ComposerSnippet,
    );

  return [...savedEntries, ...COMPOSER_SNIPPETS];
}

export function upsertSavedComposerSnippet(
  savedSnippets: ReadonlyArray<SavedComposerSnippetRecord>,
  value: string,
  nowIso = new Date().toISOString(),
): {
  snippets: SavedComposerSnippetRecord[];
  snippet: SavedComposerSnippetRecord;
  deduped: boolean;
} {
  const normalizedBody = normalizeComposerSnippetBody(value);
  const existing = savedSnippets.find((snippet) => snippet.body === normalizedBody);
  if (existing) {
    const updated = {
      ...existing,
      updatedAt: nowIso,
    } satisfies SavedComposerSnippetRecord;
    return {
      snippets: savedSnippets.map((snippet) => (snippet.id === existing.id ? updated : snippet)),
      snippet: updated,
      deduped: true,
    };
  }

  const created = {
    id: randomUUID(),
    body: normalizedBody,
    createdAt: nowIso,
    updatedAt: nowIso,
  } satisfies SavedComposerSnippetRecord;

  return {
    snippets: [created, ...savedSnippets],
    snippet: created,
    deduped: false,
  };
}

export function deleteSavedComposerSnippet(
  savedSnippets: ReadonlyArray<SavedComposerSnippetRecord>,
  snippetId: string,
): SavedComposerSnippetRecord[] {
  return savedSnippets.filter((snippet) => snippet.id !== snippetId);
}

function scoreComposerSnippet(snippet: ComposerSnippet, query: string): number | null {
  const title = snippet.title.toLowerCase();
  const description = snippet.description.toLowerCase();
  const keywords = snippet.keywords.join(" ").toLowerCase();
  const body = snippet.body.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: title,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 8,
      fuzzyBase: 100,
    }),
    scoreQueryMatch({
      value: keywords,
      query,
      exactBase: 10,
      prefixBase: 12,
      boundaryBase: 14,
      includesBase: 18,
      fuzzyBase: 120,
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 28,
    }),
    scoreQueryMatch({
      value: body,
      query,
      exactBase: 40,
      prefixBase: 42,
      boundaryBase: 44,
      includesBase: 48,
    }),
  ].filter((score): score is number => score !== null);

  if (scores.length === 0) {
    return null;
  }

  return Math.min(...scores);
}

export function searchComposerSnippets(
  snippets: ReadonlyArray<ComposerSnippet>,
  query: string,
): ComposerSnippet[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return [...snippets];
  }

  const ranked: Array<{
    item: ComposerSnippet;
    score: number;
    tieBreaker: string;
  }> = [];

  for (const snippet of snippets) {
    const score = scoreComposerSnippet(snippet, normalizedQuery);
    if (score === null) {
      continue;
    }

    insertRankedSearchResult(
      ranked,
      {
        item: snippet,
        score,
        tieBreaker: `${snippet.title}\u0000${snippet.id}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }

  return ranked.map((entry) => entry.item);
}
