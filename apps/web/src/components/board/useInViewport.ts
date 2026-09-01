import { useEffect, useState, type RefObject } from "react";

/**
 * Reports whether an element has entered the viewport.
 *
 * The board uses this to decide which cards mount a live chat surface. Mounting
 * every card's timeline + composer for a large board is the one cost that grows
 * without bound, and viewport gating is the cheapest honest way to cap it: a
 * card you cannot see is not a card you are talking to.
 *
 */
export function useInViewport(
  ref: RefObject<Element | null>,
  options: { readonly rootMargin?: string } = {},
): boolean {
  const { rootMargin = "0px" } = options;
  const [inViewport, setInViewport] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // No observer (older runtimes, jsdom): fail open so the surface still
      // mounts rather than silently rendering an empty card forever.
      setInViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        setInViewport(entry.isIntersecting);
      },
      { rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, rootMargin]);

  return inViewport;
}
