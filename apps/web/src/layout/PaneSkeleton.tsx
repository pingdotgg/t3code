import type { CSSProperties, ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * Placeholder lines shaped like what a pane holds, for layout pictures
 * that never render live content: the Settings > Layout editor's canvas and
 * the Settings > Appearance mode cards.
 */
export type LayoutPaneSkeletonShape = "chat" | "terminal" | "diff" | "lines";

export function LayoutPaneSkeleton({ shape }: { shape: LayoutPaneSkeletonShape }) {
  if (shape === "chat") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5 pt-2">
        <div className="ms-auto h-4 w-1/2 rounded-md bg-foreground/8" />
        <div className="mt-2 h-1 w-3/5 rounded-full bg-foreground/14" />
        <div className="h-1 w-1/2 rounded-full bg-foreground/11" />
        <div className="h-1 w-[56%] rounded-full bg-foreground/11" />
        <div className="mt-auto flex h-4.5 items-center justify-end rounded-item border border-foreground/8 bg-foreground/4 pe-1">
          <div className="size-2 rounded-full bg-foreground/60" />
        </div>
      </div>
    );
  }
  if (shape === "terminal") {
    return (
      <div className="flex flex-col gap-1.5 p-2.5 pt-2">
        <div className="h-1 w-1/2 rounded-full bg-foreground/19" />
        <div className="h-1 w-1/3 rounded-full bg-success/55" />
        <div className="h-1 w-2/5 rounded-full bg-foreground/11" />
        <div className="h-2 w-1.5 rounded-xs bg-foreground/25" />
      </div>
    );
  }
  if (shape === "diff") {
    return (
      <div className="flex flex-col gap-1.5 p-2 pt-1.5">
        <div className="h-1 w-1/2 rounded-full bg-foreground/14" />
        <div className="h-1 w-3/5 rounded-full bg-foreground/14" />
        <div className="mt-1 h-1.5 rounded-sm bg-success/15" />
        <div className="h-1.5 rounded-sm bg-destructive/15" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 p-2 pt-1.5">
      <div className="h-1 w-1/2 rounded-full bg-foreground/14" />
      <div className="h-1 w-3/5 rounded-full bg-foreground/14" />
      <div className="h-1 w-2/5 rounded-full bg-foreground/11" />
      <div className="h-1 w-1/2 rounded-full bg-foreground/11" />
    </div>
  );
}

const NOTCH_CORNER_STYLE: CSSProperties = {
  background:
    "radial-gradient(circle 6px at 100% 100%, transparent 5.5px, var(--app-chrome-background) 6px)",
};

/**
 * A mini pane's tab in a notch cut into the pane's top-left corner, in the
 * window chrome color like the app's pane notch (pen tmkl7). Render it at
 * the pane's top-left; the pane's top and left edges round into it.
 */
export function PaneNotchTab({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      data-chrome-scope=""
      className={cn(
        "relative flex min-w-0 items-center rounded-br-sm bg-(--app-chrome-background)",
        className,
      )}
      style={style}
    >
      {children}
      <span aria-hidden className="absolute top-0 left-full size-1.5" style={NOTCH_CORNER_STYLE} />
      <span aria-hidden className="absolute top-full left-0 size-1.5" style={NOTCH_CORNER_STYLE} />
    </span>
  );
}
