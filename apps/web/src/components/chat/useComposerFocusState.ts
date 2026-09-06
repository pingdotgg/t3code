import { useCallback, useState } from "react";

export function useComposerFocusState(isMobileViewport: boolean) {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(false);

  const restoreAfterTimelineReachedEnd = useCallback(() => {
    setIsComposerScrollCollapsed(false);
    // Restore the expanded layout after a timeline control takes focus too.
    // This state holds the layout open without moving DOM focus to the editor.
    if (!isMobileViewport) {
      setIsComposerFocused(true);
    }
  }, [isMobileViewport]);

  return {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
  };
}
