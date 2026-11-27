import "~/index.css";

import { expect, it, vi } from "vite-plus/test";

import { observeComposerPromptLayout } from "./observeComposerPromptLayout";

function mountComposerBody() {
  const body = document.createElement("div");
  body.style.cssText = "width: 200px; font: 12px/20px sans-serif";
  const editor = document.createElement("div");
  editor.dataset.testid = "composer-editor";
  editor.style.cssText = "max-height: 60px; overflow-y: auto";
  const paragraph = document.createElement("p");
  paragraph.style.margin = "0";
  paragraph.textContent = "short";
  editor.append(paragraph);
  body.append(editor);
  document.body.append(body);
  const onMultiline = vi.fn();
  const stop = observeComposerPromptLayout(body, onMultiline);
  return {
    body,
    paragraph,
    onMultiline,
    [Symbol.dispose]() {
      stop();
      body.remove();
    },
  };
}

it("keeps a scrolling prompt in overflow mode until it fits again", async () => {
  using composer = mountComposerBody();
  const { body, paragraph, onMultiline } = composer;
  await vi.waitFor(() => expect(onMultiline).toHaveBeenLastCalledWith(false));

  paragraph.textContent = "a long prompt that wraps ".repeat(2);
  await vi.waitFor(() => expect(onMultiline).toHaveBeenLastCalledWith(true));
  expect(body.hasAttribute("data-composer-overflow")).toBe(false);

  paragraph.textContent = "a long prompt that wraps ".repeat(6);
  await vi.waitFor(() => expect(body.hasAttribute("data-composer-overflow")).toBe(true));

  paragraph.textContent = "short";
  await vi.waitFor(() => expect(onMultiline).toHaveBeenLastCalledWith(false));
  expect(body.hasAttribute("data-composer-overflow")).toBe(false);
});

it("wraps multiline text around top-right actions, runs full width below them, and keeps RTL clear", async () => {
  const body = document.createElement("div");
  body.className = "composer-prompt-body";
  body.style.cssText = "width: 440px; font: 14px/20px sans-serif";

  const wrap = document.createElement("div");
  wrap.dataset.composerEmpty = "false";

  const editor = document.createElement("div");
  editor.className = "composer-text";
  editor.dataset.testid = "composer-editor";
  editor.style.cssText = "max-height: 120px; overflow-y: auto";

  const paragraph = document.createElement("p");
  paragraph.style.margin = "0";
  paragraph.textContent =
    "The first two lines stay clear of the top-right actions corner while every line below the actions row expands across the full width of the composer body cleanly.";
  editor.append(paragraph);
  wrap.append(editor);

  const actions = document.createElement("div");
  actions.dataset.chatComposerActions = "right";
  actions.style.cssText = "width: 100px; height: 32px";

  body.append(wrap, actions);
  document.body.append(body);

  const stop = observeComposerPromptLayout(body);
  try {
    await vi.waitFor(() => expect(body.hasAttribute("data-composer-multiline")).toBe(true));
    await vi.waitFor(() =>
      expect(Number.parseFloat(getComputedStyle(editor, "::before").height)).toBeGreaterThanOrEqual(
        32,
      ),
    );
    expect(getComputedStyle(editor, "::before").display).not.toBe("none");
    expect(Number.parseFloat(getComputedStyle(editor).paddingRight)).toBeLessThan(20);

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const lineWidths = Array.from(range.getClientRects()).map((rect) => rect.width);
    expect(lineWidths.length).toBeGreaterThanOrEqual(3);
    expect(lineWidths[2]!).toBeGreaterThan(lineWidths[0]! + 40);

    // RTL content inside an LTR composer body still floats the corner clearance on the right.
    editor.setAttribute("dir", "rtl");
    expect(getComputedStyle(editor, "::before").float).toBe("right");

    // Overflowing prompts apply the corner mask so scrolled text never runs under the actions.
    paragraph.textContent = "A long scrolling prompt line ".repeat(25);
    await vi.waitFor(() => expect(body.hasAttribute("data-composer-overflow")).toBe(true));
    expect(getComputedStyle(editor).maskImage).toContain("linear-gradient");
  } finally {
    stop();
    body.remove();
  }
});
