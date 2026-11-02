import { describe, expect, it } from "vite-plus/test";

import { markdownTaskListItems, setMarkdownTaskChecked } from "./markdownTaskList.ts";

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
