import type { PreviewStreamMouseButton } from "@t3tools/client-runtime/preview/server-browser-stream";

/** Mouse thumb buttons: `button === 3` is Back, `button === 4` is Forward. */
export const pressedButtonOf = (buttons: number): PreviewStreamMouseButton =>
  buttons & 1 ? "left" : buttons & 2 ? "right" : buttons & 4 ? "middle" : "none";

export const historyDeltaOf = (button: number): -1 | 1 | null =>
  button === 3 ? -1 : button === 4 ? 1 : null;
