import { describe, expect, it } from "vite-plus/test";

import { rehypeChipPunctuation } from "./markdownChipPunctuation";

const text = (value: string) => ({ type: "text", value });
const element = (tagName: string, children: object[]) => ({
  type: "element",
  tagName,
  properties: {} as Record<string, unknown>,
  children,
});

function paired(block: ReturnType<typeof element>) {
  rehypeChipPunctuation()({ type: "root", children: [block] });
  return block.children;
}

describe("rehypeChipPunctuation", () => {
  it("pairs a link with the punctuation that follows it", () => {
    const link = element("a", [text("a.ts")]);
    expect(paired(element("p", [text("See "), link, text("... next")]))).toEqual([
      text("See "),
      expect.objectContaining({ tagName: "span", children: [link, text("...")] }),
      text(" next"),
    ]);
  });

  it("leaves code blocks alone", () => {
    const children = [element("code", [text("a.ts")]), text(".")];
    expect(paired(element("pre", [...children]))).toEqual(children);
  });
});
