import { useCallback, useState } from "react";

/** A draft grows the editor up to this many lines before it scrolls. */
const COMPOSER_EDITOR_MAX_LINES = 8;

/**
 * Sizes the composer editor to its draft: one line when empty, growing line by
 * line up to a cap, then scrolling. `maxHeight` lowers the cap on short
 * screens. `overflows` means the draft no longer fits, which is when the
 * composer offers full-screen editing.
 */
export function useComposerEditorHeight(lineHeight: number, maxHeight = Infinity) {
  const [contentHeight, setContentHeight] = useState(0);
  const cap = Math.max(lineHeight, Math.min(lineHeight * COMPOSER_EDITOR_MAX_LINES, maxHeight));
  const onContentSizeChange = useCallback(
    (size: { readonly height: number }) => setContentHeight(size.height),
    [],
  );
  return {
    height: Math.min(cap, Math.max(lineHeight, contentHeight)),
    overflows: contentHeight > cap + 1,
    onContentSizeChange,
  };
}
