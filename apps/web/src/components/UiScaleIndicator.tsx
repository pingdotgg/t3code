import { useRef } from "react";
import { useWindowZoom } from "../hooks/useWindowZoom";

export function UiScaleIndicator() {
  const { announcementToken, indicatorMessage, indicatorVisible } = useWindowZoom();
  const hasBeenVisibleRef = useRef(false);

  if (indicatorVisible) {
    hasBeenVisibleRef.current = true;
  }

  // Before first show: hide without animation.
  // After first show: animate in/out via keyframes.
  const animClass = !hasBeenVisibleRef.current
    ? "opacity-0"
    : indicatorVisible
      ? "animate-zoom-indicator-in"
      : "animate-zoom-indicator-out";

  return (
    <>
      <div className="sr-only" aria-live="polite" key={announcementToken}>
        {indicatorMessage}
      </div>
      <div
        aria-hidden="true"
        className={[
          "pointer-events-none fixed right-4 bottom-4 z-[60] rounded-full border border-border/80",
          "bg-popover/92 px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-lg/10",
          "sm:right-6 sm:bottom-6",
          animClass,
        ].join(" ")}
        data-testid="ui-scale-indicator"
      >
        {indicatorMessage}
      </div>
    </>
  );
}
