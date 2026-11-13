import { describe, expect, it } from "vite-plus/test";
import { markdownLinkChipReserves } from "./markdownDocument";

describe("markdownLinkChipReserves", () => {
  const em = 10;

  it("reserves an em per drawn character stuck to a link, and nothing for a link standing alone", () => {
    const markdown = [
      "Filed: [Bug: chip cut off](t3-thread://v1/a). Next is the review.",
      "See also ([another](<t3-thread://v1/b>)).",
      "Ask **[the skill](skill://review)**, or /review-code.",
      "[Alone](https://example.com/a) on its line",
      "[Beside](t3-thread://v1/c)[B](https://example.com/a-long-hidden-destination).",
      "[Paren](t3-thread://v1/p)[B](https://example.com/long(x)extra-long-destination).",
      '[Titled](t3-thread://v1/t)[B](https://example.com/b "a title")!!!',
      ">[Compact quote](t3-thread://v1/q)",
      "[https://example.com/a#section](https://example.com/a) labeled with its own URL",
    ].join("\n\n");
    const urls = [
      "t3-thread://v1/a",
      "t3-thread://v1/b",
      "t3-thread://v1/c",
      "t3-thread://v1/p",
      "t3-thread://v1/t",
      "t3-thread://v1/q",
      "skill://review",
      "/review-code",
      "https://example.com/a",
      "t3-thread://v1/missing",
      "",
    ];
    expect(markdownLinkChipReserves(markdown, urls, em)).toEqual(
      new Map([
        ["t3-thread://v1/a", 10],
        ["t3-thread://v1/b", 30],
        ["t3-thread://v1/c", 20],
        ["t3-thread://v1/p", 20],
        ["t3-thread://v1/t", 40],
        ["t3-thread://v1/q", 0],
        ["skill://review", 10],
        ["/review-code", 10],
        ["https://example.com/a", 0],
      ]),
    );
  });

  it("adds the list and quote indent around a link, by list type, at its deepest occurrence", () => {
    const markdown = [
      "- Top: [a](t3-thread://v1/a).",
      "  - Nested: [b](t3-thread://v1/b).",
      "",
      "> 1. Quoted: [c](t3-thread://v1/c).",
      "",
      "- Alone: [d](t3-thread://v1/d)",
      "",
      "Shallow [b](t3-thread://v1/b).",
      "",
      "`[e](t3-thread://v1/e).`",
      "",
      "> Reference: [r][ref].",
      "",
      "1. One",
      "   1. Two: [n](t3-thread://v1/n).",
      "",
      "- [ ] Task: [k](t3-thread://v1/k).",
      "",
      "[ref]: t3-thread://v1/r",
    ].join("\n");
    const urls = [
      "t3-thread://v1/a",
      "t3-thread://v1/b",
      "t3-thread://v1/c",
      "t3-thread://v1/d",
      "t3-thread://v1/e",
      "t3-thread://v1/r",
      "t3-thread://v1/n",
      "t3-thread://v1/k",
    ];
    expect(markdownLinkChipReserves(markdown, urls, em)).toEqual(
      new Map([
        ["t3-thread://v1/a", 10 + 12.5],
        ["t3-thread://v1/b", 10 + 24 + 12.5],
        ["t3-thread://v1/c", 10 + 30 + 14],
        ["t3-thread://v1/d", 0],
        ["t3-thread://v1/r", 10 + 14],
        ["t3-thread://v1/n", 10 + 24 + 6 + 30],
        ["t3-thread://v1/k", 10 + 30],
      ]),
    );
  });
});
