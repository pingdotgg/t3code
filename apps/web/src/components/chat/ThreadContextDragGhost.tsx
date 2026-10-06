import { MessagesSquareIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { useThreadContextDragGhost } from "./threadContextDrag";

/** Follows the pointer while a sidebar thread is dragged toward a composer. */
export function ThreadContextDragGhost() {
  const ghost = useThreadContextDragGhost();
  if (ghost === null) return null;
  return createPortal(
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 z-[100] flex max-w-72 items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg"
      style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }}
    >
      <MessagesSquareIcon className="size-4 shrink-0 text-secondary-label" />
      <span className="truncate">{ghost.title}</span>
      {ghost.count > 1 ? (
        <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs text-secondary-label">
          +{ghost.count - 1}
        </span>
      ) : null}
    </div>,
    document.body,
  );
}
