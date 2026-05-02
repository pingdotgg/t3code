import { describe, expect, it } from "vitest";

import {
  COMPOSER_SNIPPETS,
  buildComposerSnippetLibrary,
  deleteSavedComposerSnippet,
  normalizeComposerSnippetBody,
  searchComposerSnippets,
  upsertSavedComposerSnippet,
} from "./composerSnippets";

describe("searchComposerSnippets", () => {
  it("returns the full snippet list for an empty query", () => {
    expect(searchComposerSnippets(COMPOSER_SNIPPETS, "").map((snippet) => snippet.id)).toEqual(
      COMPOSER_SNIPPETS.map((snippet) => snippet.id),
    );
  });

  it("prefers exact title matches ahead of broader body matches", () => {
    const results = searchComposerSnippets(COMPOSER_SNIPPETS, "debug").map((snippet) => snippet.id);
    expect(results[0]).toBe("debug-issue");
    expect(results).toContain("review-change");
  });

  it("supports keyword matches", () => {
    const results = searchComposerSnippets(COMPOSER_SNIPPETS, "regression").map(
      (snippet) => snippet.id,
    );
    expect(results.slice(0, 3)).toEqual(["review-change", "write-tests", "debug-issue"]);
  });

  it("supports fuzzy matches", () => {
    const results = searchComposerSnippets(COMPOSER_SNIPPETS, "rfc").map((snippet) => snippet.id);
    expect(results[0]).toBe("refactor-cleanup");
    expect(results).toContain("review-change");
  });
});

describe("saved composer snippets", () => {
  it("normalizes snippet bodies before saving", () => {
    expect(normalizeComposerSnippetBody("\n  Hello world\r\n\r\n")).toBe("Hello world");
  });

  it("adds saved snippets ahead of built-in snippets in the library", () => {
    const saved = [
      {
        id: "saved-1",
        body: "My saved snippet",
        createdAt: "2026-04-16T10:00:00.000Z",
        updatedAt: "2026-04-16T10:00:00.000Z",
      },
    ];

    const library = buildComposerSnippetLibrary(saved);
    expect(library[0]).toMatchObject({
      id: "saved:saved-1",
      source: "saved",
      savedSnippetId: "saved-1",
      deletable: true,
    });
    expect(library.at(-1)?.id).toBe(COMPOSER_SNIPPETS.at(-1)?.id);
  });

  it("dedupes by normalized body when saving the same snippet twice", () => {
    const first = upsertSavedComposerSnippet([], "My saved snippet", "2026-04-16T10:00:00.000Z");
    const second = upsertSavedComposerSnippet(
      first.snippets,
      "  My saved snippet  ",
      "2026-04-16T10:05:00.000Z",
    );

    expect(second.deduped).toBe(true);
    expect(second.snippets).toHaveLength(1);
    expect(second.snippets[0]?.updatedAt).toBe("2026-04-16T10:05:00.000Z");
  });

  it("deletes saved snippets by id", () => {
    const first = upsertSavedComposerSnippet([], "My saved snippet", "2026-04-16T10:00:00.000Z");
    expect(deleteSavedComposerSnippet(first.snippets, first.snippet.id)).toEqual([]);
  });
});
