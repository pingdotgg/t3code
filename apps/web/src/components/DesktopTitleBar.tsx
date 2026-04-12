import type { ReactNode } from "react";

import { isWindowsElectron } from "~/env";
import { cn } from "~/lib/utils";

interface DesktopTitleBarProps {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  className?: string;
  reserveNativeWindowControlsOverlay?: boolean;
  tone?: "default" | "subtle";
}

export function DesktopTitleBar(props: DesktopTitleBarProps) {
  const reserveNativeWindowControlsOverlay =
    props.reserveNativeWindowControlsOverlay ?? isWindowsElectron;
  const tone = props.tone ?? "default";

  return (
    <div
      className={cn(
        "drag-region relative flex h-[52px] shrink-0 items-center border-b border-border/70 bg-background ps-5 pe-0 desktop-windows:h-[var(--desktop-titlebar-height)] desktop-windows:border-b-0 desktop-windows:bg-[var(--desktop-titlebar-surface)] desktop-windows:ps-4 desktop-windows:after:pointer-events-none desktop-windows:after:absolute desktop-windows:after:inset-x-0 desktop-windows:after:-bottom-px desktop-windows:after:border-b desktop-windows:after:border-border/70",
        props.className,
      )}
    >
      <div className="min-w-0 flex-1 pe-4 desktop-windows:pe-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-col desktop-windows:flex-row desktop-windows:items-center desktop-windows:gap-2">
            <div
              className={cn(
                "truncate",
                tone === "subtle"
                  ? "text-xs font-medium tracking-wide text-muted-foreground/70"
                  : "text-[12px] font-medium tracking-tight text-foreground/92",
              )}
            >
              {props.title}
            </div>
            {props.subtitle ? (
              <div
                className={cn(
                  "truncate desktop-windows:text-[11px]",
                  tone === "subtle"
                    ? "text-[10px] text-muted-foreground/50"
                    : "text-[10px] text-muted-foreground/85",
                )}
              >
                {props.subtitle}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="ms-auto flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {props.trailing ? (
          <div
            className={cn(
              "flex h-full items-center gap-1",
              reserveNativeWindowControlsOverlay ? "me-3 desktop-windows:me-2" : "pe-3",
            )}
          >
            {props.trailing}
          </div>
        ) : null}
        {reserveNativeWindowControlsOverlay ? (
          <div aria-hidden="true" className="pointer-events-none h-full w-[138px] shrink-0" />
        ) : null}
      </div>
    </div>
  );
}
