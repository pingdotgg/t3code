// @vitest-environment jsdom

import { describe, expect, it } from "vite-plus/test";

import { chatMarkdownClipboardPayload } from "./markdown-clipboard";

function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("copying rendered math", () => {
  it("copies a formula's TeX whether the selection spans it or starts inside it", () => {
    document.body.innerHTML = `<div class="chat-markdown"><p>Area <span data-markdown-math="" data-markdown-copy="$\\pi r^2$"><span class="katex"><span class="katex-mathml">πr2</span><span class="katex-html" aria-hidden="true">πr2</span></span></span> grows.</p></div>`;
    const paragraph = document.querySelector("p")!;
    const glyphs = document.querySelector(".katex-mathml")!.firstChild!;

    expect(
      chatMarkdownClipboardPayload(select(paragraph.firstChild!, 0, paragraph.lastChild!, 7))?.text,
    ).toBe("Area $\\pi r^2$ grows.");
    expect(chatMarkdownClipboardPayload(select(glyphs, 0, glyphs, 1))?.text).toBe("$\\pi r^2$");
  });
});
