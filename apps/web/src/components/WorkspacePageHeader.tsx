import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

/** Shared workspace top-bar geometry. */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  surfaceSubheader = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
  readonly surfaceSubheader?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-3",
        surfaceSubheader
          ? "h-10 min-h-10 border-b border-border/60 bg-background px-3 sm:px-5"
          : "h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left,padding-right] [[data-panel-animations=true]_&]:motion-safe:[transition-duration:var(--panel-animation-duration)] [[data-panel-animations=true]_&]:motion-safe:ease-out sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
        electron && !surfaceSubheader && "drag-region",
        reserveNativeControls &&
          !surfaceSubheader &&
          "wco:pr-[var(--workspace-native-controls-inset)]",
        !surfaceSubheader && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
}
