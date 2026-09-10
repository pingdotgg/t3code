import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { chatMarkdownClipboardPayload } from "./markdown-clipboard";
import { renderMathHtml } from "./mathRendering";

const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
  vi.unstubAllGlobals();
});

function fixture() {
  const dom = new JSDOM("<p>Before <span data-markdown-math></span> after.</p>");
  windows.push(dom);
  const { document } = dom.window;
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", dom.window.Node);
  const math = document.querySelector("[data-markdown-math]")!;
  math.setAttribute("data-markdown-copy", String.raw`\(\frac{x}{y}\)`);
  math.innerHTML = renderMathHtml(String.raw`\(\frac{x}{y}\)`) ?? "";
  return { document, math, selection: dom.window.getSelection()! };
}

describe("copying rendered equations", () => {
  it("copies the original TeX when selection is inside a fraction", () => {
    const { document, math, selection } = fixture();
    const numerator = [...math.querySelectorAll(".mord")].find((node) => node.textContent === "x")!;
    const range = document.createRange();
    range.selectNodeContents(numerator);
    selection.addRange(range);
    expect(chatMarkdownClipboardPayload(selection)?.text).toBe(String.raw`\(\frac{x}{y}\)`);
  });

  it("preserves surrounding prose without duplicating accessible math", () => {
    const { document, selection } = fixture();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    selection.addRange(range);
    expect(chatMarkdownClipboardPayload(selection)?.text).toBe(
      String.raw`Before \(\frac{x}{y}\) after.`,
    );
  });

  it("does not copy a collapsed caret inside an equation", () => {
    const { document, math, selection } = fixture();
    const range = document.createRange();
    range.setStart(math, 0);
    selection.addRange(range);
    expect(chatMarkdownClipboardPayload(selection)).toBeNull();
  });
});
