import type { DesktopWindowAction, DesktopWindowState } from "@t3tools/contracts";
import { Maximize2Icon, Minimize2Icon, MinusIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import {
  DESKTOP_WINDOW_TOP_BAR_HEIGHT_PX,
  DESKTOP_WINDOW_TOP_BAR_MARGIN_TOP_PX,
  DESKTOP_WINDOW_TOP_BAR_MARGIN_X_PX,
  nextDesktopWindowTopBarVisibility,
  resolveDesktopWindowTopBarZoomFactor,
  shouldOverlayDesktopWindowTopBar,
  shouldUseDesktopWindowTopBar,
} from "~/components/DesktopWindowTopBar.logic";
import { Button } from "~/components/ui/button";
import { useDesktopWindowState } from "~/hooks/useDesktopWindowState";
import { cn } from "~/lib/utils";

function DesktopWindowTopBar() {
  const windowState = useDesktopWindowState();
  const [isHovered, setIsHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const syncVisibility = useEffectEvent((nextState: DesktopWindowState | null) => {
    if (!shouldUseDesktopWindowTopBar(nextState)) {
      setIsHovered(false);
      setIsVisible(false);
      return;
    }

    setIsHovered(false);
    setIsVisible(nextState?.isFullScreen !== true);
  });

  const updateVisibility = useEffectEvent((pointerY: number | null) => {
    setIsVisible((wasVisible) =>
      nextDesktopWindowTopBarVisibility({
        windowState,
        pointerY,
        isHovered,
        wasVisible,
      }),
    );
  });

  const performWindowAction = useEffectEvent(async (action: DesktopWindowAction) => {
    const bridge = window.desktopBridge;
    if (!bridge) {
      return;
    }

    await bridge.performWindowAction(action);
    if (action === "minimize" || action === "close" || action === "exit-full-screen") {
      setIsHovered(false);
      setIsVisible(false);
    }
  });

  useEffect(() => {
    syncVisibility(windowState);
  }, [windowState]);

  useEffect(() => {
    if (!shouldOverlayDesktopWindowTopBar(windowState)) {
      return;
    }

    const handlePointerMove = (event: MouseEvent) => {
      updateVisibility(event.clientY);
    };
    const handlePointerLeave = () => {
      setIsHovered(false);
      setIsVisible(false);
    };

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseleave", handlePointerLeave);

    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseleave", handlePointerLeave);
    };
  }, [windowState]);

  if (!windowState || !shouldUseDesktopWindowTopBar(windowState)) {
    return null;
  }

  const activeWindowState = windowState;
  const isMacWindow = activeWindowState.platform === "darwin";
  const isOverlay = shouldOverlayDesktopWindowTopBar(activeWindowState);
  const zoomFactor = resolveDesktopWindowTopBarZoomFactor(activeWindowState);
  const inverseZoomFactor = 1 / zoomFactor;
  const frameHeightPx =
    (DESKTOP_WINDOW_TOP_BAR_HEIGHT_PX + (isOverlay ? DESKTOP_WINDOW_TOP_BAR_MARGIN_TOP_PX : 0)) /
    zoomFactor;
  const frameWidth = isOverlay
    ? `calc(${100 * zoomFactor}% - ${2 * DESKTOP_WINDOW_TOP_BAR_MARGIN_X_PX}px)`
    : `${100 * zoomFactor}%`;
  const secondaryAction: {
    action: DesktopWindowAction;
    label: string;
    icon: typeof Maximize2Icon;
  } = activeWindowState.isFullScreen
    ? {
        action: "exit-full-screen",
        label: "Exit full screen",
        icon: Minimize2Icon,
      }
    : activeWindowState.isMaximized
      ? {
          action: "toggle-maximize",
          label: "Restore window",
          icon: Minimize2Icon,
        }
      : {
          action: "toggle-maximize",
          label: "Maximize window",
          icon: Maximize2Icon,
        };

  const SecondaryActionIcon = secondaryAction.icon;
  const windowActions: ReadonlyArray<{
    action: DesktopWindowAction;
    icon: typeof Maximize2Icon;
    label: string;
  }> = isMacWindow
    ? [
        {
          action: "close",
          icon: XIcon,
          label: "Close window",
        },
        {
          action: "minimize",
          icon: MinusIcon,
          label: "Minimize window",
        },
        {
          action: secondaryAction.action,
          icon: SecondaryActionIcon,
          label: secondaryAction.label,
        },
      ]
    : [
        {
          action: "minimize",
          icon: MinusIcon,
          label: "Minimize window",
        },
        {
          action: secondaryAction.action,
          icon: SecondaryActionIcon,
          label: secondaryAction.label,
        },
        {
          action: "close",
          icon: XIcon,
          label: "Close window",
        },
      ];

  const content = (
    <div className="relative w-full shrink-0" style={{ height: `${frameHeightPx}px` }}>
      <div
        className={cn(
          "drag-region absolute left-0 top-0 flex items-center border-border/80 bg-background/92 backdrop-blur-md",
          isMacWindow ? "justify-start" : "justify-end",
          isOverlay
            ? "pointer-events-auto mx-2 mt-2 rounded-xl border px-2 shadow-lg"
            : "border-b px-3 shadow-[0_1px_0_rgba(255,255,255,0.04)]",
        )}
        onDoubleClick={() => {
          if (!activeWindowState.isFullScreen) {
            void performWindowAction("toggle-maximize");
          }
        }}
        onMouseEnter={() => {
          if (isOverlay) {
            setIsHovered(true);
            setIsVisible(true);
          }
        }}
        onMouseLeave={() => {
          if (isOverlay) {
            setIsHovered(false);
            setIsVisible(false);
          }
        }}
        onFocusCapture={() => {
          if (isOverlay) {
            setIsHovered(true);
            setIsVisible(true);
          }
        }}
        onBlurCapture={(event) => {
          if (!isOverlay) {
            return;
          }

          const relatedTarget = event.relatedTarget;
          if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
            setIsHovered(false);
            setIsVisible(false);
          }
        }}
        style={{
          height: `${DESKTOP_WINDOW_TOP_BAR_HEIGHT_PX}px`,
          transform: `scale(${inverseZoomFactor})`,
          transformOrigin: "top left",
          width: frameWidth,
        }}
      >
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-24 text-sm font-medium text-foreground/80">
          <span className="truncate">{APP_DISPLAY_NAME}</span>
        </div>

        <div className="relative z-10 flex items-center gap-1">
          {windowActions.map((windowAction) => {
            const ActionIcon = windowAction.icon;
            return (
              <Button
                key={`${windowAction.action}-${windowAction.label}`}
                aria-label={windowAction.label}
                size="icon-xs"
                variant="ghost"
                onClick={() => {
                  void performWindowAction(windowAction.action);
                }}
              >
                <ActionIcon />
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );

  if (!isOverlay) {
    return content;
  }

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-[90] transition-all duration-150",
        isVisible ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0",
      )}
    >
      {content}
    </div>
  );
}

export { DesktopWindowTopBar };
