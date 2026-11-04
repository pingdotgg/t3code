import { useSyncExternalStore } from "react";

const subscribeToViewport = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const readViewportWidth = () => window.innerWidth;
const readViewportHeight = () => window.innerHeight;

/** The window's CSS viewport, re-read on every resize. */
export function useViewportSize() {
  const width = useSyncExternalStore(subscribeToViewport, readViewportWidth);
  const height = useSyncExternalStore(subscribeToViewport, readViewportHeight);
  return { width, height };
}
