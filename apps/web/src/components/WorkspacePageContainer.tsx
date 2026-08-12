import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

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

/** Shared top-bar geometry for standalone workspace pages. */
export function WorkspacePageHeader({
  electron = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & { readonly electron?: boolean }) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 px-5 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-6",
        electron &&
          "drag-region wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
        className,
      )}
      {...props}
    />
  );
}
