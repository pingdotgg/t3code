import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  getActiveThemeBackdrop,
  mountThemeBackdropCanvas,
  subscribeThemeBackdrop,
} from "../themeBackdrop";

export function ThemeBackdropHost() {
  const backdrop = useSyncExternalStore(subscribeThemeBackdrop, getActiveThemeBackdrop, () => null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts and tears down the WebGL2 animation loop bound to the backdrop canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !backdrop) return;
    return mountThemeBackdropCanvas(canvas, backdrop);
  }, [backdrop]);

  if (!backdrop) return null;

  return (
    <canvas
      ref={canvasRef}
      data-theme-backdrop-canvas=""
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 h-dvh w-screen"
    />
  );
}
