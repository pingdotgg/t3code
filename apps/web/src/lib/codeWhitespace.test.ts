// @vitest-environment jsdom
import {
  FileRenderer,
  DiffHunksRenderer,
  getSharedHighlighter,
  parseDiffFromFile,
} from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { observeCodeWhitespace, renderCodeWhitespace } from "./codeWhitespace";

const selectionUrl = new URL("./editor/selection.js", import.meta.resolve("@pierre/diffs"));
const { convertSelection, getSelectionAnchor } = (await import(
  /* @vite-ignore */ selectionUrl.href
)) as {
  convertSelection(range: Range): {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  getSelectionAnchor(line: Element, character: number): [Node, number];
};
const tokenizerUrl = new URL("./editor/tokenizer.js", import.meta.resolve("@pierre/diffs"));
const { renderLineTokens } = (await import(/* @vite-ignore */ tokenizerUrl.href)) as {
  renderLineTokens(tokens: [number, string, string][]): (HTMLElement | string)[];
};

async function renderFile(contents: string, name = "file.txt") {
  await getSharedHighlighter({ themes: ["pierre-dark"], langs: ["text", "typescript"] });
  const renderer = new FileRenderer({ theme: "pierre-dark", useTokenTransformer: true });
  const result = renderer.renderFile({ name, contents });
  if (!result) throw new Error("File was not rendered");
  const container = document.createElement("diffs-container");
  const root = container.shadowRoot ?? container.attachShadow({ mode: "open" });
  root.innerHTML = renderer.renderFullHTML(result);
  renderer.cleanUp();
  return container;
}

describe("code whitespace decorations", () => {
  it.each(["file.txt", "file.ts", "patched.txt"])(
    "preserves both Pierre caret mappings at every text boundary in %s, including after disabling",
    async (name) => {
      const text = "\t  hello world\t ";
      const container = await renderFile(text, name);
      const line = container.shadowRoot!.querySelector("[data-code] [data-line]")!;
      // Grammarless edits use Pierre's plain token instead of the initial highlighter wrapper.
      if (name === "patched.txt") line.replaceChildren(...renderLineTokens([[0, "", text]]));
      for (const enabled of [false, true, false, true]) {
        renderCodeWhitespace(container, enabled);
        expect(line.textContent).toBe(text);
        // DOM -> document: exercise every fragment and both sides of a fragment boundary.
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let preceding = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          for (let offset = 0; offset <= node.textContent!.length; offset += 1) {
            const range = document.createRange();
            range.setStart(node, offset);
            range.collapse(true);
            expect(convertSelection(range).start).toEqual({
              line: 0,
              character: preceding + offset,
            });
          }
          preceding += node.textContent!.length;
        }
        // Document -> DOM: measure independently with a native Range, not the inverse resolver.
        for (let character = 0; character <= text.length; character += 1) {
          const [node, offset] = getSelectionAnchor(line, character);
          const prefix = document.createRange();
          prefix.setStart(line, 0);
          prefix.setEnd(node, offset);
          expect(prefix.toString()).toBe(text.slice(0, character));
        }
      }
    },
  );

  it("preserves the original text through enabling, repeated renders and disabling", async () => {
    const container = await renderFile("\t  hello world\t \n");
    const root = container.shadowRoot!;
    const code = root.querySelector("[data-code]")!;
    const text = code.textContent;
    renderCodeWhitespace(container, false);
    expect(root.querySelectorAll("[data-whitespace]")).toHaveLength(0);
    renderCodeWhitespace(container, true);
    expect(code.textContent).toBe(text);
    expect(
      [...root.querySelectorAll('[data-whitespace="tab"]')].map((node) => node.textContent),
    ).toEqual(["\t", "\t"]);
    expect(
      [...root.querySelectorAll('[data-whitespace="space"]')].map((node) => node.textContent),
    ).toEqual(["  ", " ", " "]);
    const markup = code.innerHTML;
    renderCodeWhitespace(container, true);
    expect(code.innerHTML).toBe(markup);
    renderCodeWhitespace(container, false);
    expect(container.hasAttribute("data-show-whitespace")).toBe(false);
    expect(code.textContent).toBe(text);
  });

  it("decorates both diff sides without changing parsed lines or annotation text", async () => {
    await getSharedHighlighter({ themes: ["pierre-dark"], langs: ["text"] });
    const diff = parseDiffFromFile(
      { name: "file.txt", contents: "\told value\n" },
      { name: "file.txt", contents: "\tnew value  \n" },
    );
    const original = structuredClone(diff);
    const renderer = new DiffHunksRenderer({ theme: "pierre-dark", diffStyle: "split" });
    const result = renderer.renderDiff(diff);
    if (!result) throw new Error("Diff was not rendered");
    const container = document.createElement("diffs-container");
    const root = container.shadowRoot ?? container.attachShadow({ mode: "open" });
    root.innerHTML = renderer.renderFullHTML(result);
    const annotation = document.createElement("div");
    annotation.setAttribute("data-line-annotation", "");
    annotation.textContent = "Comment with spaces\tand a tab";
    root.append(annotation);
    const text = root.textContent;
    renderCodeWhitespace(container, true);
    expect(root.querySelector('[data-deletions] [data-whitespace="tab"]')).not.toBeNull();
    expect(root.querySelector('[data-additions] [data-whitespace="tab"]')).not.toBeNull();
    expect(annotation.querySelector("[data-whitespace]")).toBeNull();
    expect(root.textContent).toBe(text);
    expect(diff).toEqual(original);
    renderer.cleanUp();
  });

  it("decorates newly virtualized rows but does not duplicate existing decorations", async () => {
    const container = await renderFile("hello world\n");
    renderCodeWhitespace(container, true);
    const code = container.shadowRoot!.querySelector("[data-code]")!;
    const line = document.createElement("div");
    line.setAttribute("data-line", "2");
    line.textContent = "\tmore text";
    code.append(line);
    renderCodeWhitespace(container, true);
    expect(code.querySelectorAll('[data-whitespace="space"]')).toHaveLength(2);
    expect(line.textContent).toBe("\tmore text");
  });

  it.each([false, true])(
    "preserves a native text selection while adding markers (backward=%s)",
    async (backward) => {
      const rendered = await renderFile("\t  hello world\n");
      const container = document.createElement("div");
      container.innerHTML = rendered.shadowRoot!.innerHTML;
      document.body.append(container);
      const line = container.querySelector("[data-code] [data-line]")!;
      line.replaceChildren(...renderLineTokens([[0, "", "\t  hello world"]]));
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode()!;
      const selection = document.getSelection()!;
      const length = first.textContent!.length;
      selection.setBaseAndExtent(first, backward ? length : 0, first, backward ? 0 : length);
      const originalSelection = selection.toString();
      renderCodeWhitespace(container, true);
      expect(selection.toString()).toBe(originalSelection);
      expect(selection.toString()).toContain("\t");
      const range = selection.getRangeAt(0);
      expect(convertSelection(range)).toMatchObject({
        start: { line: 0, character: 0 },
        end: { line: 0, character: length },
      });
      selection.removeAllRanges();
      container.remove();
    },
  );

  it("refreshes patched and newly inserted editor rows without changing their text", async () => {
    const container = await renderFile("old text\n");
    const root = container.shadowRoot!;
    renderCodeWhitespace(container, true);
    const stop = observeCodeWhitespace(container);
    const line = root.querySelector("[data-code] [data-line]")!;
    line.textContent = "\tedited text  ";
    const added = document.createElement("div");
    added.setAttribute("data-line", "2");
    added.textContent = "\tnew row";
    line.parentElement!.append(added);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(line.textContent).toBe("\tedited text  ");
    expect(line.querySelectorAll('[data-whitespace="tab"]')).toHaveLength(1);
    expect(line.querySelectorAll('[data-whitespace="space"]')).toHaveLength(2);
    expect(added.textContent).toBe("\tnew row");
    expect(added.querySelectorAll('[data-whitespace="tab"]')).toHaveLength(1);
    const markup = line.innerHTML;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(line.innerHTML).toBe(markup);
    stop();
    line.textContent = "\tno longer observed";
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(line.querySelector("[data-whitespace]")).toBeNull();
  });
});
