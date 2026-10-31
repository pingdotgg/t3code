import { useLayoutEffect, useRef, useState } from "react";

import type { AddToChatResult } from "~/components/files/FileBrowserPanel";
import { useComposerHandleContext } from "~/composerHandleContext";

// A late action belongs to one committed visit; A -> B -> A must retire the first visit.
export function useScopeLifetime(scopeKey: string): () => boolean {
  // A fresh visit object each time the scope changes, so A -> B -> A is a new visit.
  const [visit, setVisit] = useState(() => ({ scopeKey }));
  if (visit.scopeKey !== scopeKey) setVisit({ scopeKey });
  const liveRef = useRef<typeof visit | null>(null);
  // Set on commit, so a discarded render never retires live work.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The committed lifetime guards external actions after navigation or unmount.
  useLayoutEffect(() => {
    liveRef.current = visit;
    return () => {
      liveRef.current = null;
    };
  }, [visit]);
  return () => liveRef.current === visit;
}

// The composer ref is shared by the layout, so a late action must verify its original visit.
export function useScopedComposerInsert(isScopeCurrent: () => boolean) {
  const composerRef = useComposerHandleContext();
  return (text: string): AddToChatResult => {
    if (!isScopeCurrent()) return "dropped";
    const composer = composerRef?.current;
    if (!composer) return "no-composer";
    return composer.insertTextAtEnd(text, { ensureLeadingBoundary: true })
      ? "inserted"
      : "not-ready";
  };
}
