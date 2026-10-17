import { createContext } from "react";

// While find is active, folded content stays mounted (hidden) so its text can be
// matched. Nothing opens until the selected match lies inside it.
export const MarkdownFindContext = createContext(false);

/**
 * Find dispatches `beforematch` on hidden or clipped ancestors of the selected
 * match, like the browser's own find-in-page. `onReveal` must be stable.
 */
export function useFindRevealRef(onReveal: () => void) {
  // The compiler skips hookless functions; a new ref callback each render would re-add the listener.
  "use memo";
  return (element: HTMLElement | null) => {
    if (!element) return;
    element.addEventListener("beforematch", onReveal);
    return () => element.removeEventListener("beforematch", onReveal);
  };
}
