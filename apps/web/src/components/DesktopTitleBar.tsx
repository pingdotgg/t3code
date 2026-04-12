import type { ReactNode } from "react";

import { isWindowsElectron } from "~/env";
import { cn } from "~/lib/utils";

interface DesktopTitleBarProps {
  title: string;
  subtitle?: string;
  contextLabel?: string;
  contextValue?: string;
  showContextChip?: boolean;
  trailing?: ReactNode;
  className?: string;
  titleViewportPaddingClassName?: string;
  titleAlignment?: "center" | "left";
  reserveNativeWindowControlsOverlay?: boolean;
  tone?: "default" | "subtle";
}

export function DesktopTitleBar(props: DesktopTitleBarProps) {
  const showContextChip = props.showContextChip ?? true;
  const contextLabel = props.contextLabel ?? "Workspace";
  const contextValue = props.contextValue;
  const titleAlignment = props.titleAlignment ?? "center";
  const reserveNativeWindowControlsOverlay =
    props.reserveNativeWindowControlsOverlay ?? isWindowsElectron;
  const tone = props.tone ?? "default";

  return (
    <div
      className={cn(
        "drag-region relative flex h-[52px] shrink-0 items-center border-b border-border/70 bg-background ps-5 pe-0 desktop-windows:h-[var(--desktop-titlebar-height)] desktop-windows:border-b-0 desktop-windows:bg-white desktop-windows:ps-4 desktop-windows:after:pointer-events-none desktop-windows:after:absolute desktop-windows:after:inset-x-0 desktop-windows:after:-bottom-px desktop-windows:after:border-b desktop-windows:after:border-border/70 dark:desktop-windows:bg-[#0e1218]",
        props.className,
      )}
    >
      {showContextChip ? (
        <div className="min-w-0 max-w-[40%] truncate">
          <div className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-card/70 px-2 py-1 text-[11px] leading-none">
            <span className="inline-flex size-4 items-center justify-center rounded-sm bg-foreground text-[9px] font-semibold text-background">
              T3
            </span>
            <span className="truncate font-medium tracking-tight text-foreground/85">
              {contextLabel}
            </span>
            {contextValue ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.14em] uppercase text-muted-foreground">
                {contextValue}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {titleAlignment === "center" ? (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 flex min-w-0 items-center justify-center px-[8.5rem]",
            props.titleViewportPaddingClassName,
          )}
        >
          <div className="min-w-0 text-center">
            <div
              className={cn(
                "truncate",
                tone === "subtle"
                  ? "text-xs font-medium tracking-wide text-muted-foreground/70"
                  : "text-[12px] font-medium text-foreground/90",
              )}
            >
              {props.title}
            </div>
            {props.subtitle ? (
              <div
                className={cn(
                  "truncate",
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
      ) : (
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
      )}

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
