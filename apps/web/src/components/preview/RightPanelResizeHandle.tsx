import type { ComponentProps } from "react";
import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props extends Pick<
  ComponentProps<"div">,
  "tabIndex" | "onKeyDown" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax"
> {
  handlers: ResizableWidthHandlers;
  className?: string;
  label?: string;
  /** The panel edge the handle sits on. */
  edge?: "left" | "right";
}

export function RightPanelResizeHandle({
  handlers,
  className,
  label,
  edge = "left",
  ...separatorProps
}: Props) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      {...separatorProps}
      className={cn(
        "group absolute inset-y-0 z-40 w-1 cursor-col-resize touch-none select-none any-pointer-coarse:w-4",
        edge === "left"
          ? "left-0 any-pointer-coarse:-left-2"
          : "right-0 any-pointer-coarse:-right-2",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-px bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60",
          edge === "left"
            ? "left-0 -translate-x-1/2 any-pointer-coarse:left-2"
            : "right-0 translate-x-1/2 any-pointer-coarse:right-2",
        )}
      />
    </div>
  );
}
