import { useState } from "react";

import { CLEAR_SPOKEN_AFTER_MS } from "../lib/announce";

/**
 * A polite live region written straight to the DOM, so speaking never
 * re-renders. `attach` is the region element's ref callback; writes while no
 * region is attached are dropped.
 */
export function createLiveRegion() {
  let region: HTMLElement | null = null;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelClear = () => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    clearTimer = null;
  };

  const clear = () => {
    cancelClear();
    if (region !== null) region.textContent = "";
  };

  const announce = (text: string) => {
    if (region === null) return;
    cancelClear();
    // Screen readers ignore a write that leaves the text unchanged, so a repeat
    // gets a trailing non-breaking space to count as new.
    region.textContent = region.textContent === text ? `${text}\u00A0` : text;
    clearTimer = setTimeout(clear, CLEAR_SPOKEN_AFTER_MS);
  };

  const attach = (node: HTMLElement | null) => {
    region = node;
  };

  return { attach, announce, clear };
}

export function useLiveRegion() {
  const [liveRegion] = useState(createLiveRegion);
  return { regionRef: liveRegion.attach, announce: liveRegion.announce, clear: liveRegion.clear };
}
