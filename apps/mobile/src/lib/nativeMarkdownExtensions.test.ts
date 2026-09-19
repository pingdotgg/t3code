import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import {
  markdownAlertKind,
  nativeMarkdownWithExtensions,
} from "@t3tools/mobile-markdown-text/markdown";

const text = (content: string): MarkdownNode => ({ type: "text", content });
const paragraph = (...children: MarkdownNode[]): MarkdownNode => ({ type: "paragraph", children });
const document = (...children: MarkdownNode[]): MarkdownNode => ({ type: "document", children });

describe("GitHub alerts", () => {
  it("lifts a marker line into the alert kind and drops it from the quote", () => {
    const [alert] = nativeMarkdownWithExtensions(
      document({
        type: "blockquote",
        beg: 4,
        children: [
          paragraph(text("[!WARNING]"), { type: "soft_break" }, text("Mind the gap.")),
          paragraph(text("Second paragraph.")),
        ],
      }),
    ).children!;

    expect(markdownAlertKind(alert!)).toBe("warning");
    expect(alert).toMatchObject({
      type: "blockquote",
      beg: 4,
      children: [paragraph(text("Mind the gap.")), paragraph(text("Second paragraph."))],
    });
  });

  it("accepts a hard break after the marker and a marker-only first paragraph", () => {
    const [hard, alone] = nativeMarkdownWithExtensions(
      document(
        {
          type: "blockquote",
          children: [paragraph(text("[!tip]"), { type: "line_break" }, text("Lower case too."))],
        },
        {
          type: "blockquote",
          children: [paragraph(text("[!CAUTION]")), paragraph(text("Body."))],
        },
      ),
    ).children!;

    expect(markdownAlertKind(hard!)).toBe("tip");
    expect(hard!.children).toEqual([paragraph(text("Lower case too."))]);
    expect(markdownAlertKind(alone!)).toBe("caution");
    expect(alone!.children).toEqual([paragraph(text("Body."))]);
  });

  it("leaves a quote alone when something shares the marker's line, GitHub's rule", () => {
    const quote: MarkdownNode = {
      type: "blockquote",
      children: [paragraph(text("[!NOTE] aside"))],
    };
    const [unchanged] = nativeMarkdownWithExtensions(document(quote)).children!;
    expect(markdownAlertKind(unchanged!)).toBeUndefined();
    expect(unchanged).toEqual(quote);
  });

  it("finds alerts nested inside list items", () => {
    const [list] = nativeMarkdownWithExtensions(
      document({
        type: "list",
        children: [
          {
            type: "list_item",
            children: [
              {
                type: "blockquote",
                children: [paragraph(text("[!IMPORTANT]"), { type: "soft_break" }, text("Nested"))],
              },
            ],
          },
        ],
      }),
    ).children!;
    expect(markdownAlertKind(list!.children![0]!.children![0]!)).toBe("important");
  });
});
