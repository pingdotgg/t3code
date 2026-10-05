import { observeSelectionActions } from "./selectionActions";

/** Reuse selection gesture timing so dragging and multi-clicks copy only the final range. */
export function observeCopyOnHighlight(
  viewport: HTMLElement,
  copy: (text: string) => Promise<unknown>,
) {
  const document = viewport.ownerDocument;
  let lastCopied: { range: Range; text: string } | null = null;
  const actions = observeSelectionActions({
    element: viewport,
    onDismiss: (reason) => {
      if (reason === "interaction") lastCopied = null;
    },
    onSelection: () => {
      const selection = document.defaultView?.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
      const range = selection.getRangeAt(0);
      if (!viewport.contains(range.startContainer) || !viewport.contains(range.endContainer))
        return;
      const isEditable = (node: Node) =>
        (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(
          'input, textarea, [contenteditable]:not([contenteditable="false"])',
        );
      if (isEditable(range.startContainer) || isEditable(range.endContainer)) return;
      const text = selection.toString();
      if (!text.trim()) return;
      if (
        lastCopied?.text === text &&
        lastCopied.range.startContainer === range.startContainer &&
        lastCopied.range.startOffset === range.startOffset &&
        lastCopied.range.endContainer === range.endContainer &&
        lastCopied.range.endOffset === range.endOffset
      )
        return;
      // Preserve highlights even when the plain-HTTP clipboard fallback selects a textarea.
      const savedRange = range.cloneRange();
      lastCopied = { range: savedRange, text };
      const result = copy(text);
      if (selection.toString() !== text && savedRange.commonAncestorContainer.isConnected) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
      // Automatic copying should not interrupt reading when clipboard access is denied.
      void result.catch(() => undefined);
    },
  });
  document.addEventListener("selectionchange", actions.selectionChanged);
  return () => {
    document.removeEventListener("selectionchange", actions.selectionChanged);
    actions.dispose();
  };
}
