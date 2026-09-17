import { useCallback, useState } from "react";

export function useComposerFocusState() {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(false);

  // Reaching the end of the timeline lifts a scroll collapse without moving
  // DOM focus to the editor.
  const restoreAfterTimelineReachedEnd = useCallback(() => {
    setIsComposerScrollCollapsed(false);
  }, []);

  return {
    isComposerFocused,
    setIsComposerFocused,
    isComposerScrollCollapsed,
    setIsComposerScrollCollapsed,
    restoreAfterTimelineReachedEnd,
  };
}
