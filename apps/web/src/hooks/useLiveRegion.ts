import { useEffect, useRef } from "react";

// NVDA reads a polite region's leftover text again when focus returns from a
// dialog, so an announcement is cleared once it has had time to be spoken.
// Clearing doesn't cut off speech that already started.
const CLEAR_AFTER_MS = 7_000;

/** A polite live region written straight to the DOM, so speaking never re-renders. */
export function useLiveRegion() {
  const regionRef = useRef<HTMLDivElement>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClear = () => {
    if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = null;
  };

  const clear = () => {
    cancelClear();
    if (regionRef.current !== null) regionRef.current.textContent = "";
  };

  const announce = (text: string) => {
    const region = regionRef.current;
    if (region === null) return;
    cancelClear();
    // Screen readers ignore a write that leaves the text unchanged, so a repeat
    // gets a trailing non-breaking space to count as new.
    region.textContent = region.textContent === text ? `${text} ` : text;
    clearTimerRef.current = setTimeout(clear, CLEAR_AFTER_MS);
  };

  useEffect(
    () => () => {
      if (clearTimerRef.current !== null) clearTimeout(clearTimerRef.current);
    },
    [],
  );

  return { regionRef, announce, clear };
}
