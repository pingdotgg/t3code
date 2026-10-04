import { useCallback, useLayoutEffect, useRef, useState } from "react";

import type { AddToChatResult } from "~/components/files/FileBrowserPanel";
import { useComposerHandleContext } from "~/composerHandleContext";

/**
 * Tells async work started in one visit to a scope whether the panel is still
 * on that visit. The returned check is stable for the visit, so work keeps the
 * check from the visit it started in. It turns false once the panel moves to
 * another scope (another thread, or the same thread id in another environment)
 * or unmounts, and stays false if the panel later returns to the same scope.
 */
export function useScopeLifetime(scopeKey: string): () => boolean {
  // A fresh visit object each time the scope changes, so A -> B -> A is a new visit.
  const [visit, setVisit] = useState(() => ({ scopeKey }));
  if (visit.scopeKey !== scopeKey) setVisit({ scopeKey });
  const liveRef = useRef<typeof visit | null>(null);
  // Set on commit, so a discarded render never retires live work.
  useLayoutEffect(() => {
    liveRef.current = visit;
    return () => {
      liveRef.current = null;
    };
  }, [visit]);
  return useCallback(() => liveRef.current === visit, [visit]);
}

/**
 * Inserts text at the end of the layout's chat composer while `isScopeCurrent`
 * holds. The composer ref is shared by the whole chat layout, so an action that
 * settles after navigation is dropped instead of reaching the newer thread.
 */
export function useScopedComposerInsert(isScopeCurrent: () => boolean) {
  const composerRef = useComposerHandleContext();
  return useCallback(
    (text: string): AddToChatResult => {
      if (!isScopeCurrent()) return "dropped";
      const composer = composerRef?.current;
      if (!composer) return "no-composer";
      return composer.insertTextAtEnd(text, { ensureLeadingBoundary: true })
        ? "inserted"
        : "not-ready";
    },
    [composerRef, isScopeCurrent],
  );
}
