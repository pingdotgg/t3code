import { useWindowZoom } from "../hooks/useWindowZoom";

export function UiScaleIndicator() {
  const { announcementToken, indicatorMessage, indicatorVisible } = useWindowZoom();

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
          "backdrop-blur-sm transition-[opacity,transform] duration-150 ease-out sm:right-6 sm:bottom-6",
          indicatorVisible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        ].join(" ")}
        data-testid="ui-scale-indicator"
      >
        {indicatorMessage}
      </div>
    </>
  );
}
