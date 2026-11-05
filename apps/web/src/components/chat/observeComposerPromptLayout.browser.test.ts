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
