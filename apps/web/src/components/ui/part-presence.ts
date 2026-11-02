import { createContext, use, useLayoutEffect, useState } from "react";

type RegisterPart<Part extends string> = (part: Part) => () => void;

/**
 * Lets a container style itself by which parts are mounted inside it, as a
 * data attribute instead of a `:has()` over its subtree. Chromium rechecks a
 * `:has()` container on DOM changes below it, and one that styles descendants
 * restyles them all.
 */
export function createPartPresence<Part extends string>() {
  const PartPresenceContext = createContext<RegisterPart<Part> | null>(null);

  /** In the container: the mounted parts, and the context value for its children. */
  function useParts() {
    const [parts, setParts] = useState<readonly Part[]>([]);
    const [register] = useState(() => (part: Part) => {
      setParts((current) => [...current, part]);
      return () =>
        setParts((current) => {
          const index = current.indexOf(part);
          return index === -1 ? current : current.toSpliced(index, 1);
        });
    });
    return [parts, register] as const;
  }

  /** In a part: report it to the nearest container while mounted. Null reports nothing. */
  function usePart(part: Part | null) {
    const register = use(PartPresenceContext);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register a mounted child part with its container and unregister it on removal before paint.
    useLayoutEffect(() => (part === null ? undefined : register?.(part)), [register, part]);
  }

  return { PartPresenceContext, useParts, usePart };
}
