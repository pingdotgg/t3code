import { createContext } from "react";

// While find is active, folded content stays mounted (hidden) so its text can be
// matched. Nothing opens until the selected match lies inside it.
export const MarkdownFindContext = createContext(false);

/**
 * Find dispatches `beforematch` on hidden or clipped ancestors of the selected
 * match, like the browser's own find-in-page. Callers create the ref during render
 * from a stable `onReveal`, so the compiler caches it and React attaches it once.
 */
export function findRevealRef(onReveal: () => void) {
  return (element: HTMLElement | null) => {
    if (!element) return;
    element.addEventListener("beforematch", onReveal);
    return () => element.removeEventListener("beforematch", onReveal);
  };
}
