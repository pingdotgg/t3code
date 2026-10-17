import { useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "../../lib/observeResize";

export function measureComposerMultilinePrompt(body: HTMLElement): boolean | null {
  const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  if (!editor || editor.clientWidth === 0) return null;
  // A draft that already scrolls vertically is multiline. Avoid measuring every glyph in a
  // long prompt through a Range just to reach the same result on the next keystroke.
  if (editor.scrollHeight > editor.clientHeight + 1) return true;

  const bodyStyle = getComputedStyle(body);
  const expandedWidth =
    body.clientWidth -
    Number.parseFloat(bodyStyle.paddingLeft) -
    Number.parseFloat(bodyStyle.paddingRight);
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
  const range = document.createRange();
  range.selectNodeContents(editor);
  const bounds = range.getBoundingClientRect();

  // Measure content, not the editor's minimum height. While resting, the
  // prompt is unwrapped: compare its width with the expanded row so that
  // moving the actions inline cannot make collapse and expansion oscillate.
  return bounds.height > lineHeight + 1 || bounds.width > expandedWidth + 1;
}

export function useComposerMultilinePrompt(body: HTMLElement | null): boolean {
  const [isMultiline, setIsMultiline] = useState(false);
  const measuredRef = useRef(false);

  useLayoutEffect(() => {
    if (!body) return;
    const update = (next: boolean) => {
      if (next === measuredRef.current) return;
      measuredRef.current = next;
      setIsMultiline(next);
    };
    const measure = () => {
      const next = measureComposerMultilinePrompt(body);
      if (next !== null) update(next);
    };
    measure();
    const editor = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    const stopObserving = observeResize(editor ? [body, editor] : body, measure);
    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(body, { childList: true, characterData: true, subtree: true });
    return () => {
      stopObserving();
      mutationObserver.disconnect();
    };
  }, [body]);

  return isMultiline;
}
