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

  it("finds the tapped checkbox, skipping look-alikes in code", () => {
    expect(marker(markdownTaskMarkerOffset(markdown, 0, "vp lint passes", true))).toBe("[ ]");
    expect(marker(markdownTaskMarkerOffset(markdown, 1, "Nested step", false))).toBe("[x]");
    // Native numbering restarts after code blocks and blockquotes.
    expect(marker(markdownTaskMarkerOffset(markdown, 0, "Quoted link", false))).toBe("[X]");
    // Android cuts the text at a line break, a soft one too with hard line breaks; iOS doesn't.
    for (const text of ["Wrapped", "Wrapped onto two lines"]) {
      expect(markdownTaskMarkerOffset(markdown, 0, text, true)).toBe(markdown.lastIndexOf("[ ]"));
    }
  });

  it("tells identical labels apart by count within one list and by state", () => {
    const same = "- [ ] Same\n- [ ] Same\n\n```\nx\n```\n\n- [x] Same\n";
    expect(markdownTaskMarkerOffset(same, 0, "Same", true)).toBe(2);
    expect(markdownTaskMarkerOffset(same, 1, "Same", true)).toBe(13);
    expect(markdownTaskMarkerOffset(same, 0, "Same", false)).toBe(same.lastIndexOf("[x]"));
  });

  it("refuses a checkbox it can't trace to exactly one task", () => {
    expect(markdownTaskMarkerOffset(markdown, 1, "vp lint passes", true)).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, 0, "vp lint passes", false)).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, 0, "Wrapped onto", true)).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, 4, "", true)).toBeNull();

    const similar = "- [ ] Similar\n\n```text\nseparator\n```\n\n- [ ] Similar<br>different\n";
    // iOS keeps hard breaks in the text, so it names the second task.
    expect(markdownTaskMarkerOffset(similar, 0, "Similar different", true)).toBe(
      similar.lastIndexOf("[ ]"),
    );
    // Android cuts it to "Similar", which both tasks could be.
    expect(markdownTaskMarkerOffset(similar, 0, "Similar", true)).toBeNull();

    for (const label of ["Similar [docs](https://github.com/pingdotgg/t3code)", "Similar $x$"]) {
      const attachment = similar.replace("Similar<br>different", label);
      expect(markdownTaskMarkerOffset(attachment, 0, "Similar \uFFFC", true)).toBeNull();
    }
  });
});
