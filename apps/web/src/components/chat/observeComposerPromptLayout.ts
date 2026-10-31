/** Native text flow owns sizing; resize delivery only schedules bookkeeping. */
export function observeComposerPromptLayout(
  body: HTMLElement,
  onMultiline?: (multiline: boolean) => void,
): () => void {
  let frame = 0;
  let editor: HTMLElement | null = null;
  let lineHeight = 0;
  let contentHeight = 0;
  let padding = 0;
  let actionsWidth = 0;
  let appliedActionsWidth = -1;
  let multiline: boolean | undefined;
  let scrolling = false;
  const apply = () => {
    frame = 0;
    if (actionsWidth !== appliedActionsWidth) {
      appliedActionsWidth = actionsWidth;
      body.style.setProperty("--composer-actions-width", `${actionsWidth}px`);
    }
    const next = contentHeight > lineHeight * 1.5;
    if (next !== multiline) {
      multiline = next;
      onMultiline?.(next);
    }
    // At the editor's eight-line cap, keep actions below the scrolled text.
    // Only a capped editor needs a layout read, at most once per frame.
    const overflows =
      contentHeight >= lineHeight * 8 &&
      editor !== null &&
      editor.scrollHeight > lineHeight * 8 + padding;
    if (overflows !== scrolling) {
      scrolling = overflows;
      body.toggleAttribute("data-composer-scrolling", scrolling);
    }
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(apply);
  };
  const actions = body.querySelector<HTMLElement>('[data-chat-composer-actions="right"]');
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- CSS owns sizing; defer bookkeeping to a frame instead of flushing React from resize delivery.
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === editor) contentHeight = entry.contentRect.height;
      if (entry.target === actions) actionsWidth = entry.contentRect.width;
    }
    schedule();
  });
  const bindEditor = () => {
    const next = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    if (next === editor) {
      if (contentHeight >= lineHeight * 8) schedule();
      return;
    }
    if (editor) observer.unobserve(editor);
    editor = next;
    if (!editor) return;
    // Read typography only on mount or a rich/plain editor replacement.
    const style = getComputedStyle(editor);
    lineHeight = Number.parseFloat(style.lineHeight);
    padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    observer.observe(editor);
  };
  bindEditor();
  if (actions) observer.observe(actions);
  const mutations = new MutationObserver(bindEditor);
  mutations.observe(body, { childList: true, characterData: true, subtree: true });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    mutations.disconnect();
    body.style.removeProperty("--composer-actions-width");
    body.removeAttribute("data-composer-scrolling");
  };
}
