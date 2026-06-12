import { describe, expect, it } from "vite-plus/test";
import type { Snippet, SnippetId } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSavedSnippetItems } from "./composerSavedSnippetSearch";

function makeSnippetItem(overrides: Partial<Snippet> = {}) {
  const snippet: Snippet = {
    id: "explain-stack" as SnippetId,
    title: "Explain a stack trace",
    description: "Walk through the top frame and propose a fix.",
    body: "Walk through the stack trace top-down, then suggest a fix.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  return {
    id: `saved-snippet:${snippet.id}`,
    type: "saved-snippet" as const,
    snippet,
    label: `/${snippet.id}`,
    description: snippet.description ?? snippet.title,
  } satisfies Extract<ComposerCommandItem, { type: "saved-snippet" }>;
}

describe("searchSavedSnippetItems", () => {
  it("returns the input order when the query is empty", () => {
    const items = [
      makeSnippetItem({ id: "explain-stack" as SnippetId }),
      makeSnippetItem({ id: "code-review" as SnippetId, title: "Code review" }),
    ];
    expect(searchSavedSnippetItems(items, "")).toEqual(items);
  });

  it("strips a leading slash from the query", () => {
    const items = [
      makeSnippetItem({ id: "explain-stack" as SnippetId, title: "Explain stack" }),
      makeSnippetItem({ id: "code-review" as SnippetId, title: "Code review" }),
    ];
    expect(searchSavedSnippetItems(items, "/explain").map((item) => item.snippet.id)).toEqual([
      "explain-stack",
    ]);
  });

  it("ranks trigger-prefix matches ahead of body substring matches", () => {
    const items = [
      makeSnippetItem({
        id: "pr-description" as SnippetId,
        title: "PR description",
        description: "Drafts a pull request body",
        body: "Pull request body template.",
      }),
      makeSnippetItem({
        id: "explain-stack" as SnippetId,
        title: "Explain a stack trace",
        description: "Walk through the top frame and propose a fix.",
        body: "Walk through the stack trace top-down, then suggest a fix.",
      }),
    ];
    expect(searchSavedSnippetItems(items, "stack").map((item) => item.snippet.id)).toEqual([
      "explain-stack",
    ]);
  });

  it("matches against the title even when the trigger doesn't match", () => {
    const items = [
      makeSnippetItem({ id: "explain-stack" as SnippetId, title: "Walk through stack trace" }),
    ];
    expect(searchSavedSnippetItems(items, "walk").map((item) => item.snippet.id)).toEqual([
      "explain-stack",
    ]);
  });

  it("returns no items when nothing matches", () => {
    const items = [makeSnippetItem({ id: "explain-stack" as SnippetId })];
    expect(searchSavedSnippetItems(items, "zzz-no-match")).toEqual([]);
  });
});
