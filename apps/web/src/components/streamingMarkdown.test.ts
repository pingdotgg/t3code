import { describe, expect, it } from "vitest";

import { appendStreamingMarkdown, beginStreamingMarkdown } from "./streamingMarkdown";

describe("streaming Markdown segments", () => {
  it("keeps completed paragraphs stable while appending to the active paragraph", () => {
    const firstText = "Opening **statement**";
    const first = beginStreamingMarkdown(firstText);

    expect(first).toMatchObject({
      mode: "segments",
      completed: [],
      tailStart: 0,
      tailText: firstText,
    });

    const secondText = `${firstText}\n\nSecond paragraph`;
    const second = appendStreamingMarkdown(first, secondText);

    expect(second).toMatchObject({
      mode: "segments",
      completed: [{ start: 0, text: firstText }],
      tailStart: firstText.length + 2,
      tailText: "Second paragraph",
    });

    const third = appendStreamingMarkdown(second, `${secondText} continues`);
    expect(third.mode).toBe("segments");
    expect(third.completed[0]).toBe(second.completed[0]);
    expect(third.tailText).toBe("Second paragraph continues");
  });

  it("recognizes CRLF paragraph boundaries and retains their original offsets", () => {
    const firstText = "First paragraph";
    const state = beginStreamingMarkdown(`${firstText}\r\n \r\nSecond paragraph`);

    expect(state.mode).toBe("segments");
    expect(state.completed).toEqual([{ start: 0, text: firstText }]);
    expect(state.tailStart).toBe(`${firstText}\r\n \r\n`.length);
    expect(state.tailText).toBe("Second paragraph");
  });
  it("recognizes paragraph separators split across provider deltas", () => {
    const first = beginStreamingMarkdown("First paragraph\n  ");
    const next = appendStreamingMarkdown(first, "First paragraph\n  \nSecond paragraph");

    expect(next.mode).toBe("segments");
    expect(next.completed).toEqual([{ start: 0, text: "First paragraph" }]);
    expect(next.tailText).toBe("Second paragraph");
  });

  it.each([
    "# Heading\n\n",
    "- list item\n\n",
    "> blockquote\n\n",
    "```ts\nconst value = 1;\n```\n\n",
    "`src/file.ts`\n\n",
    "[link](https://example.com)\n\n",
    "[reference]\n\n[reference]: https://example.com\n\n",
    "See #42\n\n",
    "| cell | cell |\n| --- | --- |\n",
  ])("falls back to full-document parsing for context-sensitive syntax: %s", (suffix) => {
    const state = beginStreamingMarkdown(`Opening paragraph\n\n${suffix}`);

    expect(state.mode).toBe("full");
    expect(state.sourceText).toBe(`Opening paragraph\n\n${suffix}`);
  });

  it("falls back when a stream replaces rather than appends its prior text", () => {
    const previous = beginStreamingMarkdown("First paragraph\n\nSecond paragraph");
    const replacement = appendStreamingMarkdown(previous, "Replacement text");

    expect(replacement.mode).toBe("full");
    expect(replacement.sourceText).toBe("Replacement text");
  });
});
