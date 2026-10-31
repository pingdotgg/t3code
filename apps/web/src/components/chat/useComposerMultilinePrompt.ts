import { useState } from "react";
import { observeResize } from "../../lib/observeResize";

// The gap between the prompt and its inline actions (gap-1.5).
const INLINE_ACTIONS_GAP_PX = 6;

function measureComposerMultilinePrompt(body: HTMLElement): boolean | null {
  const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!editor || editor.clientWidth === 0) return null;

  const bodyStyle = getComputedStyle(body);
  const fullWidth =
    body.clientWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  const actions = body.querySelector<HTMLElement>('[data-chat-composer-actions="right"]');
  const actionsWidth = actions ? actions.getBoundingClientRect().width + INLINE_ACTIONS_GAP_PX : 0;
  // The width the prompt gets while it shares its row with the actions. Both
  // layouts judge against this same width, so dropping the actions under the
  // prompt can never make the prompt fit again and flip back.
  const inlineWidth = fullWidth - actionsWidth;
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  // Measure each paragraph's inline content, not the paragraph boxes: those
  // span the editor, which is full width once the actions drop below.
  const range = document.createRange();
  let width = 0;
  let height = 0;
  for (const block of editor.children.length > 0 ? Array.from(editor.children) : [editor]) {
    range.selectNodeContents(block);
    const bounds = range.getBoundingClientRect();
    width = Math.max(width, bounds.width);
    height += bounds.height;
  }

  // Measure content, not the editor's minimum height. Inline chips are taller
  // than text, so only a second line box counts as more than one line.
  return height > lineHeight * 1.5 || width > inlineWidth + 1;
}

/** Whether the prompt wraps, and the ref callback that measures it on the composer body. */
export function useComposerMultilinePrompt(): readonly [
  boolean,
  (body: HTMLElement | null) => (() => void) | undefined,
] {
  const [isMultiline, setIsMultiline] = useState(false);
  const observeBody = (body: HTMLElement | null) => {
    if (!body) return;
    // Measuring reads layout, so one measurement per frame runs after all of the frame's DOM
    // writes instead of forcing a layout after each mutation.
    let frame: number | null = null;
    const measure = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const next = measureComposerMultilinePrompt(body);
        if (next !== null) setIsMultiline(next);
      });
    };
    measure();
    const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    const actions = body.querySelector<HTMLElement>('[data-chat-composer-actions="right"]');
    const stopObserving = observeResize(
      [body, ...(editor ? [editor] : []), ...(actions ? [actions] : [])],
      measure,
    );
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, { childList: true, characterData: true, subtree: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      stopObserving();
      mutationObserver.disconnect();
    };
  };
  return [isMultiline, observeBody] as const;
}
