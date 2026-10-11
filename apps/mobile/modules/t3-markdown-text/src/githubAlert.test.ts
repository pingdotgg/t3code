import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { githubAlert } from "./githubAlert";

const quote = (...children: MarkdownNode[]): MarkdownNode => ({
  type: "blockquote",
  children: [{ type: "paragraph", children }],
});

describe("GitHub alerts in native Markdown", () => {
  it.each(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])(
    "recognizes %s and retains formatted content",
    (marker) => {
      const bold: MarkdownNode = { type: "bold", children: [{ type: "text", content: "Details" }] };
      const node = quote({ type: "text", content: `[!${marker}]` }, { type: "soft_break" }, bold);
      const original = structuredClone(node);
      const alert = githubAlert(node);
      expect(alert?.title.toUpperCase()).toBe(marker);
      expect(alert?.children[0]?.children).toEqual([bold]);
      expect(node).toEqual(original);
    },
  );
  it("handles text nodes containing the line break and following text", () => {
    expect(
      githubAlert(quote({ type: "text", content: "[!WARNING]\nKeep this text." }))?.children[0]
        ?.children?.[0]?.content,
    ).toBe("Keep this text.");
  });
  it("leaves inline markers, code, and ordinary quotes alone", () => {
    expect(githubAlert(quote({ type: "text", content: "[!WARNING] inline" }))).toBeNull();
    expect(
      githubAlert(
        quote(
          { type: "text", content: "[!WARNING]" },
          { type: "bold", children: [{ type: "text", content: "inline" }] },
        ),
      ),
    ).toBeNull();
    expect(githubAlert({ type: "code_block", content: "> [!WARNING]" })).toBeNull();
    expect(githubAlert(quote({ type: "text", content: "Just a quote" }))).toBeNull();
  });
});
