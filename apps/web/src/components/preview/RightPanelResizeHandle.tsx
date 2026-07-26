import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props {
  handlers: ResizableWidthHandlers;
  className?: string;
  /**
   * Current and allowed width in px. Optional so existing call sites keep
   * compiling, but pass them: reachable by keyboard while announcing nothing
   * is worse than not reachable at all.
   */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** Spoken name, so the handle is never announced as a bare separator. */
  label?: string;
}

/**
 * Hit target for resizing a right-anchored panel via its left edge.
 *
 * - Sits on top of the panel's border with a 4px overlap on each side so the
 *   user can grab a few pixels off the edge without aiming.
 * - Visual indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor.
 * - Focusable window splitter: arrow keys move it, Shift makes the step
 *   coarse, Home/End park it at either extreme. The line lights up on keyboard
 *   focus too — otherwise focus would sit on something invisible.
 */
export function RightPanelResizeHandle({
  handlers,
  className,
  width,
  minWidth,
  maxWidth,
  label,
}: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? "Resize panel"}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      className={cn(
        "group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none outline-hidden",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary group-active:bg-primary/60"
      />
    </div>
  );
}
