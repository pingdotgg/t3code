import { useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { findRevealRef } from "./markdownFindContext";

// Long text can still fit its clamp in a wide column, so the fold engages only once
// the clamped element measures taller than the clamp.
export function useOverflowFold(long: boolean) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const clamped = long && !expanded;
  const foldRef = (element: HTMLElement | null) => {
    if (!element) return;
    const stopReveal = findRevealRef(() => setExpanded(true))(element);
    if (!clamped) return stopReveal;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight);
    measure();
    const stopObserving = observeResize(element, measure);
    return () => {
      stopReveal?.();
      stopObserving();
    };
  };
  return {
    foldRef,
    expanded,
    clamped,
    folded: clamped && overflows,
    toggleable: long && (expanded || overflows),
    toggle: () => setExpanded((value) => !value),
  };
}
