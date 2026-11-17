import { MessagesSquareIcon } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useThreadContextDragGhost } from "./threadContextDrag";

/**
 * The sidebar row lifted under the pointer while a thread is dragged out of
 * the list, toward a composer or into the layout (pen jVRc4). Pass the row
 * itself. The chrome scope gives the row and its surface the sidebar's
 * tokens, so light, black chrome lifts a dark card like the sidebar's.
 */
export function ThreadContextDragGhost({ children }: { children?: ReactNode }) {
  const ghost = useThreadContextDragGhost();
  if (ghost === null || (children === undefined && (ghost.width ?? 0) > 0)) return null;
  return createPortal(
    <div
      aria-hidden="true"
      data-chrome-scope=""
      className="pointer-events-none fixed left-0 top-0 z-[100] rounded-control surface-popover [&_*]:pointer-events-none!"
      style={{
        width: ghost.width || undefined,
        transform: `translate(${ghost.x - 24}px, ${ghost.y - 14}px) rotate(-2deg)`,
      }}
    >
      <ul role="presentation">
        {children ?? (
          <li className="flex max-w-72 items-center gap-2 px-3 py-2 text-body">
            <MessagesSquareIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{ghost.title ?? "Thread"}</span>
          </li>
        )}
      </ul>
      {ghost.count > 1 ? (
        <span className="absolute -top-2 -right-2 rounded-badge bg-strong-foreground px-1.5 text-meta text-background tabular-nums shadow-drag-label">
          +{ghost.count - 1}
        </span>
      ) : null}
    </div>,
    document.body,
  );
}
