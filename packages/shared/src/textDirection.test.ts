import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownProseDirection, resolveTextDirection } from "./textDirection.ts";

describe("resolveTextDirection", () => {
  it.each([
    ["العربية مع English terms", "rtl"],
    ["React Server Components האם להשתמש בהם בפרויקט החדש שלנו?", "rtl"],
    ["English text with one كلمة", "ltr"],
    ["one two three four עברית עברית עברית עברית", "ltr"],
    ["👋 123...", "ltr"],
    ["👋 123... שלום", "rtl"],
    ["הודעה בעברית", "rtl"],
    ["رسالة بالعربية", "rtl"],
    ["English message", "ltr"],
    ["日本語のメッセージ", "ltr"],
  ] as const)("resolves %s as %s", (text, direction) => {
    expect(resolveTextDirection(text)).toBe(direction);
  });

  it("bounds neutral-prefix inspection", () => {
    expect(resolveTextDirection(`${".".repeat(8_192)}العربية`)).toBe("ltr");
  });
});

describe("resolveMarkdownProseDirection", () => {
  it("ignores code and uses the surrounding prose", () => {
    expect(
      resolveMarkdownProseDirection({
        type: "document",
        children: [
          { type: "code_block", content: "npm test" },
          {
            type: "paragraph",
            children: [
              { type: "code_inline", content: "English inline code" },
              { type: "text", content: " שלום" },
            ],
          },
        ],
      }),
    ).toBe("rtl");

    expect(
      resolveMarkdownProseDirection({
        type: "paragraph",
        children: [
          { type: "code_inline", content: "שלום" },
          { type: "text", content: " English prose" },
        ],
      }),
    ).toBe("ltr");
  });

  it("ignores synthesized GitHub alert markers", () => {
    expect(
      resolveMarkdownProseDirection({
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", content: "[!NOTE] הודעת התראה בעברית." }],
          },
        ],
      }),
    ).toBe("rtl");
  });
});
