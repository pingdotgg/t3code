import { useCallback, useRef, useState } from "react";

// Activity detaches refs while keeping DOM; retain hidden elements to avoid re-measuring on reveal.
export function useElementState<T extends Element>(): readonly [
  T | null,
  (element: T | null) => void,
] {
  const [element, setElement] = useState<T | null>(null);
  const latestRef = useRef<T | null>(null);
  const setRef = useCallback((next: T | null) => {
    if (next !== null) {
      latestRef.current = next;
      setElement(next);
      return;
    }
    const previous = latestRef.current;
    if (previous === null) return;
    // A removed element is out of the document once the commit finishes.
    queueMicrotask(() => {
      if (latestRef.current !== previous || previous.isConnected) return;
      latestRef.current = null;
      setElement(null);
    });
  }, []);
  return [element, setRef] as const;
}
