import { describe, expect, it } from "vite-plus/test";
import type { Snippet, SnippetId, SnippetMap } from "@t3tools/contracts";

import {
  buildSnippetRows,
  filterSnippetRows,
  newSnippetFromDraft,
  nextSnippetId,
  normalizeSnippetId,
  replaceSnippet,
  removeSnippet,
  snippetIdList,
  updateSnippetFromDraft,
  validateSnippetDraft,
} from "./SnippetsSettings.logic";

function makeSnippet(overrides: Partial<Snippet> = {}): Snippet {
  return {
    id: "explain-stack" as SnippetId,
    title: "Explain a stack trace",
    description: "Walk through the top frame and propose a fix.",
    body: "Walk through the stack trace top-down, then suggest a fix.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSnippetMap(entries: ReadonlyArray<Snippet>): SnippetMap {
  const out: Record<string, Snippet> = {};
  for (const entry of entries) {
    out[entry.id] = entry;
  }
  return out as SnippetMap;
}

describe("SnippetsSettings.logic", () => {
  describe("normalizeSnippetId", () => {
    it("lowercases, dashes, and trims", () => {
      expect(normalizeSnippetId("Explain Stack_Trace!")).toBe("explain-stack-trace");
    });

    it("falls back to 'snippet' on empty input", () => {
      expect(normalizeSnippetId("   ")).toBe("snippet");
      expect(normalizeSnippetId("!!!")).toBe("snippet");
    });

    it("truncates oversize slugs", () => {
      const long = "a".repeat(60);
      const result = normalizeSnippetId(long);
      expect(result.length).toBeLessThanOrEqual(40);
    });
  });

  describe("nextSnippetId", () => {
    it("returns the base id when not taken", () => {
      expect(nextSnippetId("Explain Stack", [])).toBe("explain-stack");
    });

    it("adds numeric suffixes on collision", () => {
      expect(nextSnippetId("Explain Stack", ["explain-stack", "explain-stack-2"])).toBe(
        "explain-stack-3",
      );
    });

    it("uses timestamp fallback after exhausting suffixes", () => {
      const taken = Array.from({ length: 200 }, (_value, index) =>
        index === 0 ? "explain-stack" : `explain-stack-${index + 1}`,
      );
      const result = nextSnippetId("Explain Stack", taken);
      expect(result).toMatch(/^explain-stack-/);
    });
  });

  describe("validateSnippetDraft", () => {
    it("returns no errors for a valid draft", () => {
      const errors = validateSnippetDraft({
        id: "explain-stack",
        title: "Explain a stack trace",
        description: "Walk through top frame",
        body: "Walk through the stack trace top-down, then suggest a fix.",
      });
      expect(errors).toEqual([]);
    });

    it("rejects empty title", () => {
      const errors = validateSnippetDraft({ id: "ok", title: "  ", body: "body" });
      expect(errors.some((error) => error.field === "title")).toBe(true);
    });

    it("rejects empty body", () => {
      const errors = validateSnippetDraft({ id: "ok", title: "Title", body: "" });
      expect(errors.some((error) => error.field === "body")).toBe(true);
    });

    it("rejects invalid id pattern", () => {
      const errors = validateSnippetDraft({ id: "Bad Id", title: "Title", body: "body" });
      expect(errors.some((error) => error.field === "id")).toBe(true);
    });

    it("rejects oversize body", () => {
      const errors = validateSnippetDraft({
        id: "ok",
        title: "Title",
        body: "x".repeat(9_000),
      });
      expect(errors.some((error) => error.field === "body")).toBe(true);
    });
  });

  describe("newSnippetFromDraft", () => {
    it("omits description when blank", () => {
      const result = newSnippetFromDraft({
        id: "explain-stack",
        title: "Explain",
        description: "",
        body: "body",
      });
      expect(result.description).toBeUndefined();
    });

    it("includes description when present", () => {
      const result = newSnippetFromDraft({
        id: "explain-stack",
        title: "Explain",
        description: "Walk through",
        body: "body",
      });
      expect(result.description).toBe("Walk through");
    });
  });

  describe("updateSnippetFromDraft", () => {
    it("applies id changes, preserves createdAt, and refreshes updatedAt", () => {
      const current = makeSnippet({ createdAt: "2025-01-01T00:00:00.000Z" });
      const updated = updateSnippetFromDraft(
        current,
        { id: "renamed-trigger", title: "New title", description: "", body: "new body" },
        "2026-06-01T00:00:00.000Z",
      );
      expect(updated.id).toBe("renamed-trigger");
      expect(updated.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(updated.updatedAt).toBe("2026-06-01T00:00:00.000Z");
      expect(updated.title).toBe("New title");
      expect(updated.body).toBe("new body");
      expect(updated.description).toBeUndefined();
    });
  });

  describe("removeSnippet", () => {
    it("removes the matching id", () => {
      const map = makeSnippetMap([
        makeSnippet(),
        makeSnippet({ id: "code-review" as SnippetId, title: "Review" }),
      ]);
      const next = removeSnippet(map, "explain-stack");
      expect(Object.keys(next)).toEqual(["code-review"]);
    });

    it("is a no-op for unknown ids", () => {
      const map = makeSnippetMap([makeSnippet()]);
      const next = removeSnippet(map, "does-not-exist");
      expect(Object.keys(next)).toEqual(["explain-stack"]);
    });
  });

  describe("replaceSnippet", () => {
    it("removes the previous map key when a snippet trigger changes", () => {
      const map = makeSnippetMap([makeSnippet()]);
      const renamed = makeSnippet({ id: "renamed-trigger" as SnippetId });
      const next = replaceSnippet(map, "explain-stack", renamed);

      expect(Object.keys(next)).toEqual(["renamed-trigger"]);
      expect(next[renamed.id]).toBe(renamed);
    });
  });

  describe("buildSnippetRows + filterSnippetRows", () => {
    const map = makeSnippetMap([
      makeSnippet({
        id: "explain-stack" as SnippetId,
        title: "Explain stack",
        body: "Walk through stack trace.",
      }),
      makeSnippet({
        id: "code-review" as SnippetId,
        title: "Code review",
        body: "Review the code.",
      }),
      makeSnippet({
        id: "pr-description" as SnippetId,
        title: "PR description",
        description: "Drafts a pull request body",
        body: "Pull request body template.",
      }),
    ]);

    it("builds sorted rows by title", () => {
      const rows = buildSnippetRows(map);
      expect(rows.map((row) => row.snippet.id)).toEqual([
        "code-review",
        "explain-stack",
        "pr-description",
      ]);
    });

    it("filters by id, title, description, and body", () => {
      expect(filterSnippetRows(buildSnippetRows(map), "code").map((r) => r.snippet.id)).toEqual([
        "code-review",
      ]);
      expect(
        filterSnippetRows(buildSnippetRows(map), "Pull request").map((r) => r.snippet.id),
      ).toEqual(["pr-description"]);
      expect(filterSnippetRows(buildSnippetRows(map), "stack").map((r) => r.snippet.id)).toEqual([
        "explain-stack",
      ]);
    });

    it("returns all rows when query is empty", () => {
      expect(filterSnippetRows(buildSnippetRows(map), "")).toHaveLength(3);
    });
  });

  describe("snippetIdList", () => {
    it("returns the map's keys as SnippetIds", () => {
      const map = makeSnippetMap([makeSnippet(), makeSnippet({ id: "review" as SnippetId })]);
      expect(snippetIdList(map).sort()).toEqual(["explain-stack", "review"].sort());
    });
  });
});
