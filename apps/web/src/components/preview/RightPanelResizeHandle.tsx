import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props {
  handlers: ResizableWidthHandlers;
  className?: string;
  edge?: "left" | "right";
  label?: string;
}

export function RightPanelResizeHandle({ handlers, className, edge = "left", label }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className={cn(
        "group absolute inset-y-0 z-20 w-2 cursor-col-resize select-none",
        edge === "left" ? "-left-1" : "-right-1",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}
