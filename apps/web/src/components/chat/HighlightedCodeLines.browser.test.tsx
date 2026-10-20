import { getSharedHighlighter } from "@pierre/diffs";
import { toHtml } from "hast-util-to-html";
import { expect, it } from "vite-plus/test";

import { render as renderUi } from "../../../test/render";
import { createIncrementalHighlightedDocument } from "../../lib/incrementalHighlighting";
import { HighlightedCodeLines } from "./HighlightedCodeLines";

// React writes inline styles through CSSOM, so normalize Shiki's style strings the same way.
function normalizedHtml(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  for (const element of host.querySelectorAll<HTMLElement>("*")) {
    const style = element.style.cssText;
    const attributes = [...element.attributes].toSorted((a, b) => a.name.localeCompare(b.name));
    for (const { name } of attributes) element.removeAttribute(name);
    for (const { name, value } of attributes) element.setAttribute(name, value);
    if (style) element.style.cssText = style;
  }
  return host.innerHTML;
}

it("streams Shiki HTML into the DOM, keeping finished lines mounted", async () => {
  const highlighter = await getSharedHighlighter({
    langs: ["typescript"],
    themes: ["pierre-dark", "pierre-light"],
    preferredHighlighter: "shiki-wasm",
  });
  const code =
    'const html = "<img src=x onerror=alert(1)>";\n\n/* multi\nline */\n\tconst x = 1;\n';
  for (const theme of ["pierre-dark", "pierre-light"] as const) {
    const highlight = createIncrementalHighlightedDocument(highlighter, "typescript", theme);
    await using screen = await renderUi(null);
    const { container } = screen;
    let firstLine: Element | null = null;
    for (let end = 0; end <= code.length; end++) {
      const tree = highlight(code.slice(0, end));
      await screen.rerender(<HighlightedCodeLines root={tree} />);
      expect(normalizedHtml(container.innerHTML)).toBe(normalizedHtml(toHtml(tree)));
      if (end > code.indexOf("\n")) {
        firstLine ??= container.querySelector("code > .line");
        expect(container.querySelector("code > .line")).toBe(firstLine);
      }
    }
    expect(container.querySelector("img")).toBeNull();
  }
});
