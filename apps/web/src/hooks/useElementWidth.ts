import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

export function useElementWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!element) return;

    const update = (nextWidth: number) => {
      setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    // Flush in the observer's pre-paint slot: the preview panel absorbs row
    // changes (the app sidebar animating its width), and a width that landed a
    // frame late would wobble the chat column beside it.
    const observer = new ResizeObserver(([entry]) => {
      if (entry) flushSync(() => update(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, width] as const;
}
