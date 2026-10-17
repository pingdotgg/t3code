import { useEffect } from "react";
import { create } from "zustand";

interface WindowTitleContext {
  readonly projectTitle: string | null;
  readonly threadTitle: string | null;
}

/** The open thread's context, which the root layout's DocumentTitleSync renders. */
export const useWindowTitleStore = create<WindowTitleContext>()(() => ({
  projectTitle: null,
  threadTitle: null,
}));

/** Puts a thread in the window title while the calling view is mounted. */
export function useWindowTitleThread(projectTitle: string | null, threadTitle: string | null) {
  useEffect(() => {
    useWindowTitleStore.setState({ projectTitle, threadTitle });
    return () => useWindowTitleStore.setState({ projectTitle: null, threadTitle: null });
  }, [projectTitle, threadTitle]);
}
