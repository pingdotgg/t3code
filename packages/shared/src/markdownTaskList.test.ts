import { describe, expect, it } from "vite-plus/test";

import { markdownTaskMarkerOffset } from "./markdownTaskList.ts";
import { setMarkdownTaskChecked } from "./markdownTaskEdits.ts";

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
    expect(marker(markdownTaskMarkerOffset(markdown, 2, "Quoted link", false))).toBe("[X]");
    // Android cuts the text at a line break, a soft one too with hard line breaks; iOS doesn't.
    for (const text of ["Wrapped", "Wrapped onto two lines"]) {
      expect(markdownTaskMarkerOffset(markdown, 3, text, true)).toBe(markdown.lastIndexOf("[ ]"));
    }
  });

  it("tells identical labels apart by document index, across code blocks", () => {
    const separated = "- [ ] Same\n\n```txt\nx\n```\n\n- [ ] Same";
    expect([0, 1].map((index) => markdownTaskMarkerOffset(separated, index, "Same", true))).toEqual(
      [2, 28],
    );
    const same = "- [ ] Same\n- [ ] Same\n\n```\nx\n```\n\n- [x] Same\n";
    expect(markdownTaskMarkerOffset(same, 0, "Same", true)).toBe(2);
    expect(markdownTaskMarkerOffset(same, 1, "Same", true)).toBe(13);
    expect(markdownTaskMarkerOffset(same, 2, "Same", false)).toBe(same.lastIndexOf("[x]"));
  });

  it("refuses a tap whose index, state or text does not match", () => {
    expect(markdownTaskMarkerOffset(markdown, 1, "vp lint passes", true)).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, 0, "vp lint passes", false)).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, 0, "Wrapped onto", true)).toBeNull();
    expect(markdownTaskMarkerOffset(markdown, 4, "", true)).toBeNull();

    const similar = "- [ ] Similar\n\n```text\nseparator\n```\n\n- [ ] Similar<br>different\n";
    for (const label of ["Similar [docs](https://github.com/pingdotgg/t3code)", "Similar $x$"]) {
      const attachment = similar.replace("Similar<br>different", label);
      expect(markdownTaskMarkerOffset(attachment, 1, "Similar \uFFFC", true)).toBeNull();
    }
  });
});
