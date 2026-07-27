import { useEffect, useState } from "react";

import { prefersReducedMotion } from "../theme/motion.ts";

/**
 * Tracks `prefers-reduced-motion`, which Windows 11 drives from
 * Settings ▸ Accessibility ▸ Visual effects ▸ Animation effects.
 *
 * Subscribed rather than read once: macOS `Motion` reads the preference on
 * every access, so a change there applies from the next state change onward.
 * A one-shot read here would keep animating until the app was relaunched.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") {
      return;
    }
    const query = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    setReduced(query.matches);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
