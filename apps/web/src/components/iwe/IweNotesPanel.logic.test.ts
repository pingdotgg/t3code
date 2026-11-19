import { describe, expect, it } from "vite-plus/test";

import {
  applyCompletion,
  backlinksOf,
  positionAt,
  resolveNoteLink,
  wantsLinkCompletion,
  wikiLinksToMarkdown,
} from "./IweNotesPanel.logic";

describe("IWE notes panel logic", () => {
  it("resolves links relative to the open note, with or without extensions", () => {
    expect(resolveNoteLink("projects/continuum", "../reading.md")).toBe("reading");
    expect(resolveNoteLink("projects/continuum", "roadmap")).toBe("projects/roadmap");
    expect(resolveNoteLink("projects/continuum", "/people/ada")).toBe("people/ada");
    expect(resolveNoteLink("index", "projects/continuum.md#decisions")).toBe("projects/continuum");
    expect(resolveNoteLink("index", "https://iwe.md")).toBeNull();
    expect(resolveNoteLink("index", "#top")).toBeNull();
  });

  it("follows wiki links from the workspace root", () => {
    const markdown = wikiLinksToMarkdown("See [[people/ada|Ada]] and [[reading]].");
    expect(markdown).toBe("See [Ada](/people/ada) and [reading](/reading).");
    expect(resolveNoteLink("projects/continuum", "/people/ada")).toBe("people/ada");
  });

  it("merges inclusion parents and references into one backlink list", () => {
    expect(
      backlinksOf({
        includedBy: [{ key: "index", title: "Garden" }],
        referencedBy: [
          { key: "a", title: "A" },
          { key: "index", title: "Garden" },
        ],
      }),
    ).toEqual([
      { key: "index", title: "Garden" },
      { key: "a", title: "A" },
    ]);
  });

  it("completes links inside an open label and replaces the typed part", () => {
    const text = "# Note\n\nRead [re";
    expect(wantsLinkCompletion(text, text.length)).toBe(true);
    expect(wantsLinkCompletion("done [x](y) after", 17)).toBe(false);
    expect(positionAt(text, text.length)).toEqual({ line: 2, character: 8 });
    expect(applyCompletion(text, text.length, 5, 8, "[Reading list](reading.md)")).toEqual({
      text: "# Note\n\nRead [Reading list](reading.md)",
      cursor: "# Note\n\nRead [Reading list](reading.md)".length,
    });
  });
});
