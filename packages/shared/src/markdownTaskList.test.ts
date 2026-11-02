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

  it("reads items through nesting, quotes and inline markup, and skips look-alikes in code", () => {
    const markdown = [
      "- [ ] `pnpm lint` passes",
      "  - [x] Nested **step**",
      "```md",
      "- [ ] Inside a fence",
      "```",
      "> 1. [X] Quoted [link](https://example.com)",
    ].join("\n");

    expect(markdownTaskMarkerOffset(markdown, "pnpm lint passes")).toBe(2);
    expect(markdownTaskMarkerOffset(markdown, "Nested step")).toBe(markdown.indexOf("[x]"));
    expect(markdownTaskMarkerOffset(markdown, "Quoted link")).toBe(markdown.indexOf("[X]"));
    expect(markdownTaskMarkerOffset(markdown, "Inside a fence")).toBeNull();
  });

  it("matches against the markdown the renderer was given, then maps back to the source", () => {
    const source = "- [ ] Deploy<br>to staging\n- [ ] Revert 3f8515b3f7 on release";
    const rendered =
      "- [ ] Deploy  \nto staging\n- [ ] Revert [3f8515b](https://example.com/c/3f8515b3f7) on release";

    // Android cuts at the hard break the renderer made of `<br>`.
    expect(markdownTaskMarkerOffset(source, "Deploy", rendered)).toBe(2);
    expect(markdownTaskMarkerOffset(source, "Revert 3f8515b on release", rendered)).toBe(
      source.indexOf("[ ] Revert"),
    );
    expect(markdownTaskMarkerOffset(source, "Deploy", "- [ ] Deploy")).toBeNull();

    // HTML rewrites can drop one item and add another, keeping the count but shifting positions.
    const shifted =
      "- [ ] <details><summary>Run</summary></details>\n- [ ] second\n\n<img src=a.png>\n- [ ] hidden";
    const shiftedRendered = "- [ ] second\n\n![](a.png)\n\n- [ ] hidden";
    expect(markdownTaskMarkerOffset(shifted, "hidden", shiftedRendered)).toBeNull();
    const nested = shifted.replace("second", "Run lint and tests").replace("hidden", "Run tests");
    const nestedRendered = "- [ ] Run lint and tests\n\n![](a.png)\n\n- [ ] Run tests";
    expect(markdownTaskMarkerOffset(nested, "Run tests", nestedRendered)).toBeNull();
  });
});
