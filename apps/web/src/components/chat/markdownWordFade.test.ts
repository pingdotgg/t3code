import { describe, expect, it } from "vite-plus/test";

import { rehypeWordFade } from "./markdownWordFade";

const text = (value: string) => ({ type: "text", value });
const element = (
  tagName: string,
  children: object[],
  properties: Record<string, unknown> = {},
) => ({
  type: "element",
  tagName,
  properties,
  children,
});

describe("rehypeWordFade", () => {
  it("wraps prose words, keeps whitespace, and leaves code, links and math whole", () => {
    const code = element("code", [text("a b")]);
    const link = element("a", [text("c d")]);
    const math = element("span", [text("x y")], { className: ["katex"] });
    const paragraph = element("p", [text("one  two\n"), code, text(" three"), link, math]);
    rehypeWordFade()({ type: "root", children: [paragraph] });

    expect(paragraph.children).toEqual([
      element("span", [text("one")], { dataWordFade: "" }),
      text("  "),
      element("span", [text("two")], { dataWordFade: "" }),
      text("\n"),
      code,
      text(" "),
      element("span", [text("three")], { dataWordFade: "" }),
      link,
      math,
    ]);
    expect(code.children).toEqual([text("a b")]);
    expect(link.children).toEqual([text("c d")]);
    expect(math.children).toEqual([text("x y")]);
  });
});
