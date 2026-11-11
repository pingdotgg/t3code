import { createContext } from "react";

// Keep folded text mounted for find; reveal only the selected match.
export const MarkdownFindContext = createContext(false);

/** Create during render with stable `onReveal`; find dispatches `beforematch` to ancestors. */
export function findRevealRef(onReveal: () => void) {
  return (element: HTMLElement | null) => {
    if (!element) return;
    element.addEventListener("beforematch", onReveal);
    return () => element.removeEventListener("beforematch", onReveal);
  };
}
