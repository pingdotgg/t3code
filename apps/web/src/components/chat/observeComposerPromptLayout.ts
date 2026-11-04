/** Native text flow owns sizing; resize delivery only schedules bookkeeping. */
export function observeComposerPromptLayout(
  body: HTMLElement,
  onMultiline?: (multiline: boolean) => void,
): () => void {
  let frame = 0;
  let editor: HTMLElement | null = null;
  let lineHeight = 0;
  let actionsWidth = 0;
  let actionsHeight = 0;
  let multiline = false;
  let overflowing = false;
  let appliedActionsWidth = -1;
  let appliedActionsHeight = -1;
  let appliedOverflowing = false;
  let appliedMultiline: boolean | undefined;
  const remeasure = () => {
    if (!editor) return;
    // Request a fresh entry even when an edit leaves the height unchanged.
    observer.unobserve(editor);
    observer.observe(editor);
  };
  const apply = () => {
    frame = 0;
    let changed = false;
    if (actionsWidth !== appliedActionsWidth) {
      appliedActionsWidth = actionsWidth;
      body.style.setProperty("--composer-actions-width", `${actionsWidth}px`);
      changed = true;
    }
    if (actionsHeight !== appliedActionsHeight) {
      appliedActionsHeight = actionsHeight;
      body.style.setProperty("--composer-actions-height", `${actionsHeight}px`);
      changed = true;
    }
    if (overflowing !== appliedOverflowing) {
      appliedOverflowing = overflowing;
      body.toggleAttribute("data-composer-overflow", overflowing);
      changed = true;
    }
    if (multiline !== appliedMultiline) {
      appliedMultiline = multiline;
      body.toggleAttribute("data-composer-multiline", multiline);
      onMultiline?.(multiline);
      changed = true;
    }
    if (changed) remeasure();
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(apply);
  };
  const actions = body.querySelector<HTMLElement>('[data-chat-composer-actions="right"]');
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- CSS owns sizing; defer bookkeeping to a frame instead of flushing React from resize delivery.
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target !== actions) continue;
      actionsWidth = entry.contentRect.width;
      actionsHeight = entry.contentRect.height;
    }
    if (editor) {
      const first = editor.firstElementChild;
      const last = editor.lastElementChild;
      const textHeight =
        first instanceof HTMLElement && last instanceof HTMLElement
          ? last.offsetTop + last.offsetHeight - first.offsetTop
          : editor.scrollHeight;
      multiline = textHeight > lineHeight * 1.5;
      overflowing = editor.scrollHeight > editor.clientHeight;
    }
    schedule();
  });
  const bindEditor = () => {
    const next = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    if (next === editor) return false;
    if (editor) observer.unobserve(editor);
    editor = next;
    if (!editor) return true;
    // Read typography only on mount or a rich/plain editor replacement.
    lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight);
    observer.observe(editor);
    return true;
  };
  bindEditor();
  if (actions) observer.observe(actions);
  const mutations = new MutationObserver((records) => {
    if (bindEditor()) return;
    if (records.some((record) => editor?.contains(record.target))) remeasure();
  });
  mutations.observe(body, { childList: true, characterData: true, subtree: true });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    mutations.disconnect();
    body.style.removeProperty("--composer-actions-width");
    body.style.removeProperty("--composer-actions-height");
    body.removeAttribute("data-composer-overflow");
    body.removeAttribute("data-composer-multiline");
  };
}
