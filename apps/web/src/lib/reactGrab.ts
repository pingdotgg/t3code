/**
 * Settings bridge for the React Grab overlay
 * (https://github.com/aidenybai/react-grab).
 *
 * Hover any part of T3 Code's own UI, press React Grab's activation key, and
 * the element's component stack and source locations land on the clipboard —
 * context to paste into an agent working on this repo. A tool for people
 * developing T3 Code, not for people using it.
 *
 * This module ships in every build, so it deliberately never imports
 * `react-grab` (a devDependency): the overlay is loaded by
 * `reactGrabDevEntry.ts`, which only `vite dev` pulls in, and this file just
 * talks to the instance and hide-style that entry publishes on `window`. In a
 * production build neither exists and every call here is a no-op.
 *
 * The desktop preview picker also uses React Grab, but only its overlay-free
 * `react-grab/primitives` entry, inside the Electron preload that runs in the
 * *inspected* page (`apps/desktop/src/preview/PickPreload.ts`). That surface
 * grabs elements out of the user's app; this one grabs them out of T3 Code.
 */

// Type-only: brings `react-grab`'s global `Window` augmentation
// (`__REACT_GRAB__`, `__REACT_GRAB_DISABLED__`) into scope. Erased at build
// time — annotating `api` below is what keeps this import from being "unused".
import type { ReactGrabAPI } from "react-grab";

declare global {
  interface Window {
    /** Installed by `reactGrabDevEntry.ts`; absent everywhere else. */
    __t3ReactGrabSetOverlayVisible?: (visible: boolean) => void;
  }
}

/**
 * Apply the `reactGrabEnabled` setting to the overlay. Safe to call repeatedly,
 * and a no-op wherever the overlay was never loaded (any non-dev build).
 */
export function setReactGrabEnabled(enabled: boolean): void {
  const api: ReactGrabAPI | undefined = window.__REACT_GRAB__;
  if (!api) return;
  // Re-reading the overlay's own state keeps repeated setting emissions from
  // churning its listeners.
  if (api.isEnabled() !== enabled) api.setEnabled(enabled);
  // react-grab's own "disabled" state only collapses its toolbar to a small
  // persistent dot — by design, so it can be clicked back on without leaving
  // the page. That's not what a "Developer tools" switch should leave behind.
  // `reactGrabDevEntry.ts` installed a `[data-react-grab] { display: none }`
  // stylesheet up front; this just toggles whether it's active. A live CSS
  // rule (rather than finding-and-hiding today's host element) keeps working
  // even if react-grab tears down and recreates its host later.
  window.__t3ReactGrabSetOverlayVisible?.(enabled);
}
