import { describe, expect, it } from "vite-plus/test";

import {
  markdownTaskListItems,
  markdownTaskMarkerOffset,
  setMarkdownTaskChecked,
} from "./markdownTaskList.ts";

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});

describe("markdownTaskListItems", () => {
  it("numbers checkboxes in document order and skips look-alikes in code", () => {
    const markdown = [
      "## Test plan",
      "- [ ] `pnpm lint` passes",
      "  - [x] Nested **step**",
      "- Not a task",
      "```md",
      "- [ ] Inside a fence",
      "```",
      "> 1. [X] Quoted [link](https://example.com)",
    ].join("\n");

    const items = markdownTaskListItems(markdown);

    expect(items.map((item) => item.text)).toEqual([
      "pnpm lint passes",
      "Nested step",
      "Quoted link",
    ]);
    expect(items.map((item) => markdown.slice(item.markerOffset!, item.markerOffset! + 3))).toEqual(
      ["[ ]", "[x]", "[X]"],
    );
  });
});

describe("markdownTaskMarkerOffset", () => {
  it("finds the tapped item by its text, cut at any line break, and refuses to guess", () => {
    const markdown = [
      "- [ ] Tests",
      "```ts",
      "code",
      "```",
      "- [ ] Tests pass on Android",
      "- [ ] Wrapped",
      "  item",
      "- [ ] Hard  ",
      "  break",
      "- [ ] N/A",
      "- [ ] N/A",
      "- [ ] 🚀",
    ].join("\n");
    const marker = (text: string) => markdown.indexOf(`[ ] ${text}`);

    // After the code block the native count restarts, so only the text identifies the item.
    expect(markdownTaskMarkerOffset(markdown, "Tests pass on Android")).toBe(
      marker("Tests pass on Android"),
    );
    expect(markdownTaskMarkerOffset(markdown, "Tests")).toBe(marker("Tests\n"));
    expect(markdownTaskMarkerOffset(markdown, "Wrapped")).toBe(marker("Wrapped"));
    expect(markdownTaskMarkerOffset(markdown, "Wrapped item")).toBe(marker("Wrapped"));
    expect(markdownTaskMarkerOffset(markdown, "Hard")).toBe(marker("Hard"));
    expect(markdownTaskMarkerOffset(markdown, "N/A")).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, "🚀")).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, "")).toBeNull();
  });
});
