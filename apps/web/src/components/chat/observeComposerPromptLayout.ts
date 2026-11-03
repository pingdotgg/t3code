/** Native text flow owns sizing; resize delivery only schedules bookkeeping. */
export function observeComposerPromptLayout(
  body: HTMLElement,
  onMultiline?: (multiline: boolean) => void,
): () => void {
  let frame = 0;
  let editor: HTMLElement | null = null;
  let probe: HTMLElement | null = null;
  let contentHeight: number | undefined;
  let inlineContentHeight: number | undefined;
  let editorDirty = true;
  let probeDirty = true;
  let lineHeight = 0;
  let actionsWidth = 0;
  let appliedActionsWidth = -1;
  let multiline: boolean | undefined;
  const clearProbe = () => {
    if (probe?.hasChildNodes()) probe.replaceChildren();
    inlineContentHeight = undefined;
    probeDirty = true;
  };
  const apply = () => {
    frame = 0;
    if (actionsWidth !== appliedActionsWidth) {
      appliedActionsWidth = actionsWidth;
      body.style.setProperty("--composer-actions-width", `${actionsWidth}px`);
      editorDirty = true;
    }
    if (!editor || !probe) return;
    if (editorDirty) {
      editorDirty = false;
      contentHeight = undefined;
      clearProbe();
      // Request a fresh entry even when an edit leaves the height unchanged.
      // Never clone a big paste using the previous single-line measurement.
      observer.unobserve(editor);
      observer.observe(editor);
      return;
    }
    if (contentHeight === undefined) return;
    let next = contentHeight > lineHeight * 1.5;
    if (multiline && !next) {
      // Only a full-width single line needs the reserved-width probe to use
      // the same wrap boundary in both directions. Long prompts never clone.
      if (probeDirty) {
        probeDirty = false;
        inlineContentHeight = undefined;
        probe.replaceChildren(...Array.from(editor.childNodes, (node) => node.cloneNode(true)));
        for (const node of probe.querySelectorAll("[id]")) node.removeAttribute("id");
        observer.unobserve(probe);
        observer.observe(probe);
        return;
      }
      if (inlineContentHeight === undefined) return;
      next = inlineContentHeight > lineHeight * 1.5;
    } else {
      clearProbe();
    }
    if (next !== multiline) {
      multiline = next;
      body.toggleAttribute("data-composer-multiline", next);
      onMultiline?.(next);
      editorDirty = true;
      schedule();
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
      if (entry.target === probe) inlineContentHeight = entry.contentRect.height;
      if (entry.target === actions) actionsWidth = entry.contentRect.width;
    }
    schedule();
  });
  const bindEditor = () => {
    const next = body.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    if (next === editor) {
      return false;
    }
    if (editor) observer.unobserve(editor);
    if (probe) observer.unobserve(probe);
    probe?.remove();
    probe = null;
    editor = next;
    editorDirty = true;
    contentHeight = undefined;
    inlineContentHeight = undefined;
    probeDirty = true;
    if (!editor) return true;
    // Read typography only on mount or a rich/plain editor replacement.
    const style = getComputedStyle(editor);
    lineHeight = Number.parseFloat(style.lineHeight);
    probe = editor.cloneNode(false) as HTMLElement;
    for (const attribute of Array.from(probe.attributes)) {
      if (attribute.name !== "class") probe.removeAttribute(attribute.name);
    }
    probe.classList.add("composer-wrap-probe");
    probe.inert = true;
    probe.setAttribute("aria-hidden", "true");
    editor.after(probe);
    observer.observe(editor);
    observer.observe(probe);
    return true;
  };
  bindEditor();
  if (actions) observer.observe(actions);
  const mutations = new MutationObserver((records) => {
    if (bindEditor() || records.some((record) => editor?.contains(record.target))) {
      editorDirty = true;
      schedule();
    }
  });
  mutations.observe(body, { childList: true, characterData: true, subtree: true });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    mutations.disconnect();
    probe?.remove();
    body.style.removeProperty("--composer-actions-width");
    body.removeAttribute("data-composer-multiline");
  };
}
