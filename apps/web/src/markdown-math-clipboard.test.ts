// @vitest-environment jsdom

import katex from "katex";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  chatMarkdownClipboardPayload,
  serializeRenderedMarkdownFragment,
} from "./markdown-clipboard";

function renderedMath(source: string, displayMode = false): string {
  return katex.renderToString(source, { displayMode });
}

function containerWithHtml(html: string): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

function selectionFor(range: Range): Selection {
  const selection = window.getSelection();
  if (!selection) throw new Error("Missing DOM selection");
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("math Markdown clipboard", () => {
  it("copies inline equations once with their TeX source and surrounding formatting", () => {
    const source = String.raw`C_L = \frac{L}{\tfrac12\rho V^2 S}`;
    const container = containerWithHtml(
      `<p>Lift uses <strong>${renderedMath(source)}</strong>.</p>`,
    );

    expect(serializeRenderedMarkdownFragment(container)).toBe(`Lift uses **$${source}$**.`);
  });

  it("copies display equations as separate Markdown blocks", () => {
    const source = String.raw`\frac{P}{W} = \frac{\kappa_c}{\mathrm{FM}}\sqrt{\frac{\mathrm{DL}}{2\rho}}`;
    const container = containerWithHtml(
      `<p>Hover power:</p>${renderedMath(source, true)}<p>Check the units.</p>`,
    );

    expect(serializeRenderedMarkdownFragment(container)).toBe(
      `Hover power:\n\n$$\n${source}\n$$\n\nCheck the units.`,
    );
  });

  it("keeps equations when a selection also contains a code block", () => {
    const container = containerWithHtml(
      `<p>${renderedMath("x^2")}</p><pre><code>run()</code></pre>`,
    );

    expect(serializeRenderedMarkdownFragment(container)).toBe("$x^2$\n\n```\nrun()\n```");
  });

  it("preserves TeX in the plain clipboard flavor while keeping rich-paste MathML", () => {
    const source = String.raw`E = W\sum_i \left(\frac{P}{W}\right)_i t_i`;
    const container = containerWithHtml(`<p>Energy: ${renderedMath(source)}.</p>`);
    document.body.appendChild(container);
    const range = document.createRange();
    range.selectNodeContents(container);

    const payload = chatMarkdownClipboardPayload(selectionFor(range));

    expect(payload?.text).toBe(`Energy: $${source}$.`);
    const rich = containerWithHtml(payload?.html ?? "");
    expect(rich.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      source,
    );
    expect(rich.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("copies only selected symbols when a range ends inside an equation", () => {
    const container = containerWithHtml(`<p>Value: ${renderedMath("x+y")}.</p>`);
    document.body.appendChild(container);
    const start = container.querySelector("p")?.firstChild;
    const symbol = container.querySelector(".katex-html .mord")?.firstChild;
    if (!start || !symbol) throw new Error("Missing rendered equation text");
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(symbol, 1);

    expect(chatMarkdownClipboardPayload(selectionFor(range))?.text).toBe("Value: x");
  });

  it("copies selected visual text when a range starts inside an equation", () => {
    const container = containerWithHtml(`<p>Value: ${renderedMath("x+y")}.</p>`);
    document.body.appendChild(container);
    const symbols = container.querySelectorAll(".katex-html .mord");
    const symbol = symbols[symbols.length - 1]?.firstChild;
    const end = container.querySelector("p")?.lastChild;
    if (!symbol || !end) throw new Error("Missing rendered equation text");
    const range = document.createRange();
    range.setStart(symbol, 0);
    range.setEnd(end, 1);

    expect(chatMarkdownClipboardPayload(selectionFor(range))?.text).toBe("y.");
  });

  it("uses ordinary serialization when a math wrapper has no annotation or visual subtree", () => {
    const container = containerWithHtml('<span class="katex"><em>selected</em></span>');

    expect(serializeRenderedMarkdownFragment(container)).toBe("*selected*");
  });
});
