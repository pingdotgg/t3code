import { useCallback, useState } from "react";

export function useComposerFocusState() {
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [isComposerScrollCollapsed, setIsComposerScrollCollapsed] = useState(false);

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
