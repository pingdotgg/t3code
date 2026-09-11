import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

import { clampPaneRatio, type SplitDirection } from "~/chatPanes.logic";
import { cn } from "~/lib/utils";

interface ChatPaneResizeHandleProps {
  direction: SplitDirection;
  /** The split container: the ratio is the pointer's position along it. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  onRatioChange: (ratio: number) => void;
  onRatioCommit: (ratio: number) => void;
}

/**
 * A gutter between two panes. The live ratio is written straight to the
 * container's CSS variable while dragging and committed to the store on
 * release, so a drag never re-renders two chat views per frame.
 */
export function ChatPaneResizeHandle({
  direction,
  containerRef,
  onRatioChange,
  onRatioCommit,
}: ChatPaneResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; target: HTMLElement; ratio: number } | null>(null);
  const onRatioCommitRef = useRef(onRatioCommit);
  useEffect(() => {
    onRatioCommitRef.current = onRatioCommit;
  });
  const horizontal = direction === "horizontal";

  const release = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      if (drag.target.hasPointerCapture(drag.pointerId)) {
        drag.target.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Already released.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    return drag.ratio;
  }, []);

  const commit = useCallback(() => {
    const ratio = release();
    if (ratio !== undefined) onRatioCommitRef.current(ratio);
  }, [release]);

  useEffect(() => {
    window.addEventListener("blur", commit);
    return () => {
      window.removeEventListener("blur", commit);
      commit();
    };
  }, [commit]);

  const ratioFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return clampPaneRatio(
      horizontal
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height,
    );
  };

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      data-chat-pane-resize-handle
      className={cn(
        "group relative z-20 shrink-0 select-none",
        horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragRef.current) return;
        event.preventDefault();
        const target = event.currentTarget;
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          return;
        }
        document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
        dragRef.current = {
          pointerId: event.pointerId,
          target,
          ratio: ratioFromPointer(event) ?? 0.5,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const ratio = ratioFromPointer(event);
        if (ratio === null) return;
        drag.ratio = ratio;
        onRatioChange(ratio);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) commit();
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) commit();
      }}
    >
      <span
        aria-hidden
        className={cn(
          "absolute bg-border transition-colors duration-150 group-hover:bg-primary/60 group-active:bg-primary",
          horizontal
            ? "inset-y-0 -left-1 w-2 [background-clip:content-box] px-[3.5px]"
            : "inset-x-0 -top-1 h-2 [background-clip:content-box] py-[3.5px]",
        )}
      />
    </div>
  );
}
