/** Whether the placeholder's suffix runs past its line, beside the actions' corner or the edge. */
function placeholderSuffixOverflows(placeholder: HTMLElement): boolean {
  const suffix = placeholder.querySelector<HTMLElement>("[data-composer-placeholder-suffix]");
  const content = suffix?.firstElementChild;
  if (!suffix || !content) return false;
  const text = document.createRange();
  text.setStart(placeholder, 0);
  text.setEndBefore(suffix);
  const lastLine = Array.from(text.getClientRects()).at(-1);
  if (!lastLine) return false;
  const corner = getComputedStyle(placeholder.parentElement ?? placeholder, "::before");
  const box = placeholder.getBoundingClientRect();
  const besideCorner = lastLine.top - box.top < (Number.parseFloat(corner.height) || 0);
  const lineEnd = box.right - (besideCorner ? Number.parseFloat(corner.width) || 0 : 0);
  return content.getBoundingClientRect().right > lineEnd + 0.5;
}

/** Native text flow owns sizing; resize delivery only schedules bookkeeping. */
export function observeComposerPromptLayout(
  body: HTMLElement,
  onMultiline?: (multiline: boolean) => void,
): () => void {
  let frame = 0;
  let editor: HTMLElement | null = null;
  // The shown placeholder wraps like the text it stands for, so it decides the layout while shown.
  let placeholder: HTMLElement | null = null;
  let lineHeight: number | null = null;
  let actionsWidth = 0;
  let actionsHeight = 0;
  let multiline = false;
  let overflowing = false;
  let suffixHidden = false;
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
      // After layout, so the style read is clean.
      lineHeight ??= Number.parseFloat(getComputedStyle(editor).lineHeight);
      const first = editor.firstElementChild;
      const last = editor.lastElementChild;
      const textHeight = placeholder
        ? placeholder.offsetHeight
        : first instanceof HTMLElement && last instanceof HTMLElement
          ? last.offsetTop + last.offsetHeight - first.offsetTop
          : editor.scrollHeight;
      multiline = textHeight > lineHeight * 1.5;
      overflowing = editor.scrollHeight > editor.clientHeight;
      // Visibility leaves layout alone, so hide the suffix before this frame paints.
      const hideSuffix = placeholder !== null && placeholderSuffixOverflows(placeholder);
      if (hideSuffix !== suffixHidden) {
        suffixHidden = hideSuffix;
        body.toggleAttribute("data-composer-suffix-hidden", suffixHidden);
      }
    }
    schedule();
  });
  const bindEditor = () => {
    const next = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    if (next === editor) return false;
    if (editor) observer.unobserve(editor);
    editor = next;
    if (!editor) return true;
    // Read typography once per mount or rich/plain editor replacement, at its first resize
    // delivery; reading it here, mid-mutation, forces a style recalc.
    lineHeight = null;
    observer.observe(editor);
    return true;
  };
  const bindPlaceholder = () => {
    const next = body.querySelector<HTMLElement>("[data-composer-placeholder] > *");
    if (next === placeholder) return;
    if (placeholder) observer.unobserve(placeholder);
    placeholder = next;
    if (!placeholder) {
      remeasure();
      return;
    }
    observer.observe(placeholder);
    // A placeholder replacing multiline text would otherwise paint beside the tall corner for a frame.
    if (multiline) {
      multiline = false;
      cancelAnimationFrame(frame);
      apply();
    }
  };
  bindEditor();
  bindPlaceholder();
  if (actions) observer.observe(actions);
  const mutations = new MutationObserver((records) => {
    bindPlaceholder();
    if (placeholder && records.some((record) => placeholder?.contains(record.target))) {
      observer.unobserve(placeholder);
      observer.observe(placeholder);
    }
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
    body.removeAttribute("data-composer-suffix-hidden");
  };
}
