import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

export type WorkspacePageWidth = "readable" | "wide" | "expanded";

const WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  readable: "max-w-4xl",
  wide: "max-w-5xl",
  expanded: "max-w-6xl",
};

/** Shared full-page frame for workspace routes beneath their top bar. */
export function WorkspacePageContainer({
  width = "readable",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readonly width?: WorkspacePageWidth }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-5 pt-6 pb-12 sm:px-6",
        WIDTH_CLASS[width],
        className,
      )}
      {...props}
    />
  );
}

/** Shared top-bar geometry for every full-width workspace surface. */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
        electron && "drag-region",
        reserveNativeControls && "wco:pr-[var(--workspace-native-controls-inset)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
}

/** Keeps an icon glyph on the content edge while its larger hit target extends outward. */
export function WorkspacePageHeaderEdgeControl({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("-me-[7px] flex shrink-0", className)} {...props} />;
}
