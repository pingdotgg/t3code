import type { MarkdownNode } from "react-native-nitro-markdown";
import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownNodeTextDirection, resolveTextDirection } from "./textDirection";

const documentWith = (...children: MarkdownNode[]): MarkdownNode => ({
  type: "document",
  children,
});

describe("resolveTextDirection", () => {
  it("resolves Hebrew and Arabic text as right-to-left", () => {
    expect(resolveTextDirection("הודעה בעברית")).toBe("rtl");
    expect(resolveTextDirection("رسالة بالعربية")).toBe("rtl");
  });

  it("resolves English and other left-to-right scripts as left-to-right", () => {
    expect(resolveTextDirection("English message")).toBe("ltr");
    expect(resolveTextDirection("日本語のメッセージ")).toBe("ltr");
  });

  it("ignores neutral prefixes before the first letter", () => {
    expect(resolveTextDirection("👋 123... שלום")).toBe("rtl");
    expect(resolveTextDirection("(123) Hello")).toBe("ltr");
  });

  it("defaults neutral-only content to left-to-right", () => {
    expect(resolveTextDirection("👋 123...")).toBe("ltr");
  });

  it("uses parsed prose instead of code content", () => {
    expect(
      resolveMarkdownNodeTextDirection(
        documentWith(
          { type: "code_block", content: "npm test" },
          {
            type: "paragraph",
            children: [
              { type: "code_inline", content: "English inline code" },
              { type: "text", content: " שלום" },
            ],
          },
        ),
      ),
    ).toBe("rtl");

    expect(
      resolveMarkdownNodeTextDirection(
        documentWith({
          type: "paragraph",
          children: [
            { type: "code_inline", content: "שלום" },
            { type: "text", content: " English prose" },
          ],
        }),
      ),
    ).toBe("ltr");
  });

  it("ignores synthesized GitHub alert markers", () => {
    expect(
      resolveMarkdownNodeTextDirection(
        documentWith({
          type: "blockquote",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", content: "[!NOTE] הודעת התראה בעברית." }],
            },
          ],
        }),
      ),
    ).toBe("rtl");
  });
});
