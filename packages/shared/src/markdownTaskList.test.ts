import { describe, expect, it } from "vite-plus/test";

import { markdownTaskMarkerOffset, setMarkdownTaskChecked } from "./markdownTaskList.ts";

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

describe("markdownTaskMarkerOffset", () => {
  const markdown = [
    "## Test plan",
    "- [ ] `vp lint` passes",
    "  - [x] Nested **step**",
    "```md",
    "- [ ] Inside a fence",
    "```",
    "> 1. [X] Quoted [link](https://example.com)",
    "- [ ] Wrapped",
    "  onto two lines",
  ].join("\n");
  const marker = (offset: number | null) =>
    offset === null ? null : markdown.slice(offset, offset + 3);

  it("finds the nth checkbox in document order, skipping look-alikes in code", () => {
    expect(marker(markdownTaskMarkerOffset(markdown, 0, "vp lint passes"))).toBe("[ ]");
    expect(marker(markdownTaskMarkerOffset(markdown, 1, "Nested step"))).toBe("[x]");
    expect(marker(markdownTaskMarkerOffset(markdown, 2, "Quoted link"))).toBe("[X]");
    // Android sends the item's text up to its first line break, iOS the whole paragraph.
    expect(markdownTaskMarkerOffset(markdown, 3, "Wrapped")).toBe(markdown.lastIndexOf("[ ]"));
    expect(markdownTaskMarkerOffset(markdown, 3, "Wrapped onto two lines")).toBe(
      markdown.lastIndexOf("[ ]"),
    );
  });

  it("refuses a checkbox the renderer counted differently", () => {
    expect(markdownTaskMarkerOffset(markdown, 1, "vp lint passes")).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, 4, "")).toBeNull();
  });
});
