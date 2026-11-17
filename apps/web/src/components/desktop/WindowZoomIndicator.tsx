import { useEffect, useState } from "react";

/** Read Electron's actual zoom, which also covers menu commands and Ctrl+0. */
export function WindowZoomIndicator() {
  const [percentage, setPercentage] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the native window resize listener and the transient indicator's dismissal timer for this mount.
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    let previous = bridge.getWindowZoomFactor();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      const factor = bridge.getWindowZoomFactor();
      if (factor === previous) return;
      previous = factor;
      setPercentage(Math.round(factor * 100));
      clearTimeout(timeout);
      timeout = setTimeout(() => setPercentage(null), 2000);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(timeout);
    };
  }, []);

  if (percentage === null) return null;
  return (
    <div
      role="status"
      aria-label="Application zoom"
      className="pointer-events-none fixed top-12 right-4 z-50 rounded-lg border border-border bg-popover px-4 py-2 text-sm font-medium text-popover-foreground shadow-md tabular-nums"
    >
      {percentage}%
    </div>
  );
}
