import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { describe, expect, it } from "vite-plus/test";

import { markdownNodeDirection, markdownTextDirection } from "./markdownTextDirection";

describe("markdownTextDirection", () => {
  it("reads the first letter, ignoring markers and punctuation before it", () => {
    expect(markdownTextDirection("مرحبا بالعالم")).toBe("rtl");
    expect(markdownTextDirection("  — «مرحبا»")).toBe("rtl");
    expect(markdownTextDirection("שלום עולם")).toBe("rtl");
    expect(markdownTextDirection("Hello world")).toBeUndefined();
    expect(markdownTextDirection("1. Hello, مرحبا")).toBeUndefined();
    expect(markdownTextDirection("42 — 3.14")).toBeUndefined();
    expect(markdownTextDirection("")).toBeUndefined();
  });
});

describe("markdownNodeDirection", () => {
  const node = (type: string, children: MarkdownNode[]): MarkdownNode =>
    ({ type, children }) as MarkdownNode;
  const text = (content: string): MarkdownNode => ({ type: "text", content }) as MarkdownNode;

  it("descends to the first child that actually reads as text", () => {
    expect(
      markdownNodeDirection(node("list_item", [node("paragraph", [text("  "), text("مرحبا")])])),
    ).toBe("rtl");
    expect(markdownNodeDirection(node("list_item", [node("paragraph", [text("item")])]))).toBe(
      undefined,
    );
    expect(markdownNodeDirection(node("list_item", []))).toBeUndefined();
  });
});
