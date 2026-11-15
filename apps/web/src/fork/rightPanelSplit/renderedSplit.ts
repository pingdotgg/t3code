import { useLayoutEffect } from "react";
import { create } from "zustand";

/** Threads whose panel shows two panes now; a stored split can be hidden on a narrow panel. */
const useRenderedSplitStore = create<{ readonly threadKeys: ReadonlySet<string> }>(() => ({
  threadKeys: new Set(),
}));

export function useSplitRendered(threadKey: string | null): boolean {
  return useRenderedSplitStore((state) => threadKey !== null && state.threadKeys.has(threadKey));
}

function setRendered(threadKey: string, rendered: boolean) {
  useRenderedSplitStore.setState((state) => {
    if (state.threadKeys.has(threadKey) === rendered) return state;
    const next = new Set(state.threadKeys);
    if (rendered) next.add(threadKey);
    else next.delete(threadKey);
    return { threadKeys: next };
  });
}

export function useReportSplitRendered(threadKey: string, rendered: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells ChatView's mini player, which renders outside the panel, that a second pane is on screen
  useLayoutEffect(() => {
    if (!rendered) return;
    setRendered(threadKey, true);
    return () => setRendered(threadKey, false);
  }, [threadKey, rendered]);
}
