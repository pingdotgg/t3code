// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  captureAssistantTextSelection,
  resolveAssistantCitationRange,
} from "../../lib/assistantTextSelection";
import { chatMarkdownClipboardPayload, serializeTableElementToCsv } from "../../markdown-clipboard";

// React caches a lazy import's outcome, so each test needs its own KaTeX chunk.
async function loadMarkdownMath(chunk: () => Promise<unknown>) {
  vi.resetModules();
  vi.doMock("./KatexMath", chunk);
  return (await import("./MarkdownMath")).MarkdownMath;
}

describe("MarkdownMath", () => {
  afterEach(() => {
    vi.doUnmock("./KatexMath");
    vi.unstubAllGlobals();
  });

  it("shows the TeX and leaves its neighbors alone when the KaTeX chunk fails to load", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const MarkdownMath = await loadMarkdownMath(async () => {
      // A stale deploy or a dropped connection.
      throw new Error("Failed to fetch dynamically imported module");
    });
    const caught = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <>
            <p>Before the formula.</p>
            <p>
              Inline <MarkdownMath tex="E=mc^2" display={false} /> in prose.
            </p>
            <MarkdownMath tex={"a^2+b^2\n=c^2"} display />
            <pre>
              <code>const kept = true;</code>
            </pre>
          </>,
        );
      });
      expect(container.querySelector("p")?.textContent).toBe("Before the formula.");
      expect(container.querySelector("pre:not([data-markdown-copy])")?.textContent).toBe(
        "const kept = true;",
      );
      expect(
        [...container.querySelectorAll("[data-markdown-copy]")].map((node) => [
          node.tagName,
          node.textContent,
          node.getAttribute("data-markdown-copy"),
        ]),
      ).toEqual([
        ["CODE", "E=mc^2", "\\(E=mc^2\\)"],
        ["PRE", "a^2+b^2\n=c^2", "\\[\na^2+b^2\n=c^2\n\\]\n\n"],
      ]);
    } finally {
      await act(async () => root.unmount());
      caught.mockRestore();
    }
  });

  it("quotes, copies, and exports a formula the same while KaTeX loads as once it is typeset", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const katex = await vi.importActual("./KatexMath");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const MarkdownMath = await loadMarkdownMath(async () => {
      await gate;
      return katex;
    });
    // jsdom has no styles for the MathML elements KaTeX emits.
    const computeStyle = window.getComputedStyle.bind(window);
    const styles = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudo) =>
        element.namespaceURI === "http://www.w3.org/1998/Math/MathML"
          ? ({ userSelect: "" } as CSSStyleDeclaration)
          : computeStyle(element, pseudo),
      );
    const container = document.createElement("div");
    container.dataset.assistantCitationSource = "assistant";
    const root = createRoot(container);
    try {
      act(() => {
        root.render(
          <>
            <p>
              Energy <MarkdownMath tex="E=mc^2" display={false} /> here.
            </p>
            <MarkdownMath tex={"a^2+b^2\n=c^2"} display />
            <table>
              <tbody>
                <tr>
                  <td>
                    Cell <MarkdownMath tex="x_1" display={false} />
                  </td>
                </tr>
              </tbody>
            </table>
          </>,
        );
      });
      const paragraph = container.querySelector("p")!;
      const [before, after] = [paragraph.firstChild as Text, paragraph.lastChild as Text];
      const formulaOf = () => paragraph.children[0]!;
      const select = (pick: (range: Range) => void) => {
        const range = document.createRange();
        pick(range);
        return {
          isCollapsed: range.collapsed,
          rangeCount: 1,
          getRangeAt: () => range,
        } as unknown as Selection;
      };
      const snapshot = () => ({
        quote: captureAssistantTextSelection(
          container,
          select((range) => range.selectNodeContents(paragraph)),
        )?.selector,
        formulaQuote: captureAssistantTextSelection(
          container,
          select((range) => range.selectNodeContents(formulaOf())),
        )?.selector,
        copy: chatMarkdownClipboardPayload(select((range) => range.selectNodeContents(container))),
        // A drag over part of the formula's text.
        partialCopy: chatMarkdownClipboardPayload(
          select((range) => {
            const glyph = document.createTreeWalker(formulaOf(), NodeFilter.SHOW_TEXT).nextNode()!;
            range.setStart(glyph, 0);
            range.setEnd(glyph, 1);
          }),
        ),
        csv: serializeTableElementToCsv(container.querySelector("table")!),
      });

      // While loading, the TeX source stands in.
      expect(container.querySelector(".katex")).toBeNull();
      const pending = snapshot();
      expect(pending.quote?.text).toBe("Energy \\(E=mc^2\\) here.");
      expect(pending.formulaQuote?.text).toBe("\\(E=mc^2\\)");
      expect(pending.partialCopy).toEqual({
        text: "\\(E=mc^2\\)",
        html: '<meta charset="utf-8"><code>\\(E=mc^2\\)</code>',
      });
      expect(pending.csv).toBe("Cell \\(x_1\\)");
      expect(pending.copy?.text).toBe(
        "Energy \\(E=mc^2\\) here.\n\n\\[\na^2+b^2\n=c^2\n\\]\n\n| Cell \\(x_1\\) |\n| --- |",
      );

      await act(async () => release());
      expect(container.querySelectorAll(".katex")).toHaveLength(3);

      // The quote saved while loading matches the typeset formula.
      expect(snapshot()).toEqual(pending);
      const found = resolveAssistantCitationRange(container, pending.quote!);
      expect([found?.startContainer, found?.startOffset]).toEqual([before, 0]);
      expect([found?.endContainer, found?.endOffset]).toEqual([after, after.length]);
      const formula = resolveAssistantCitationRange(container, pending.formulaQuote!);
      const whole = document.createRange();
      whole.selectNode(formulaOf());
      expect(formula?.compareBoundaryPoints(Range.START_TO_START, whole)).toBe(0);
      expect(formula?.compareBoundaryPoints(Range.END_TO_END, whole)).toBe(0);
    } finally {
      await act(async () => root.unmount());
      styles.mockRestore();
    }
  });
});
