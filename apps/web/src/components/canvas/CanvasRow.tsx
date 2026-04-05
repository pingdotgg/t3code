/**
 * CanvasRow — A horizontal strip of thread columns for a single project.
 *
 * Uses TanStack Virtual for horizontal virtualization.
 * Threads are ordered newest (left, index 0) → oldest (right).
 */
import { memo, useCallback, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { type SidebarThreadSummary } from "../../types";
import { CanvasColumn, type ColumnRole } from "./CanvasColumn";
import { COLUMN_GAP, PREVIEW_COLUMN_WIDTH } from "../../lib/springProfiles";

export interface CanvasRowProps {
  projectId: ProjectId;
  projectName: string;
  threads: SidebarThreadSummary[];
  focusedThreadIndex: number;
  isFocusedRow: boolean;
  activeColumnWidth: number;
  viewportWidth: number;
  threadLastVisitedAtById: Record<string, string>;
  hasMore: boolean;
  onSelectThread: (projectId: ProjectId, threadId: ThreadId) => void;
}

export const CanvasRow = memo(function CanvasRow({
  projectId: _projectId,
  projectName,
  threads,
  focusedThreadIndex,
  isFocusedRow,
  activeColumnWidth,
  viewportWidth,
  threadLastVisitedAtById,
  hasMore,
  onSelectThread,
}: CanvasRowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Total items: threads + sentinel (if hasMore)
  const itemCount = threads.length + (hasMore ? 1 : 0);

  const estimateSize = useCallback(
    (index: number) => {
      if (isFocusedRow && index === focusedThreadIndex) {
        return activeColumnWidth + COLUMN_GAP;
      }
      return PREVIEW_COLUMN_WIDTH + COLUMN_GAP;
    },
    [isFocusedRow, focusedThreadIndex, activeColumnWidth],
  );

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    horizontal: true,
    overscan: 2,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="relative h-full w-full">
      {/* Sticky project label */}
      <div className="pointer-events-none absolute left-3 top-3 z-10">
        <span className="rounded bg-card/90 px-2 py-1 text-xs font-semibold text-muted-foreground shadow-sm backdrop-blur-sm">
          {projectName}
        </span>
      </div>

      {/* Horizontal scroll container */}
      <div
        ref={scrollRef}
        className="h-full w-full overflow-x-hidden overflow-y-hidden"
        style={{ width: viewportWidth }}
      >
        <div className="relative flex h-full" style={{ width: virtualizer.getTotalSize() }}>
          {virtualItems.map((virtualItem) => {
            const index = virtualItem.index;
            const isSentinel = index >= threads.length;
            const thread = isSentinel ? null : (threads[index] ?? null);

            let role: ColumnRole;
            if (isSentinel) {
              role = "sentinel";
            } else if (isFocusedRow && index === focusedThreadIndex) {
              role = "active";
            } else {
              role = "preview";
            }

            return (
              <div
                key={isSentinel ? "sentinel" : (thread?.id ?? index)}
                className="absolute left-0 top-0 h-full"
                style={{
                  width: virtualItem.size,
                  transform: `translateX(${virtualItem.start}px)`,
                }}
              >
                <CanvasColumn
                  thread={thread}
                  role={role}
                  activeColumnWidth={activeColumnWidth}
                  lastVisitedAt={thread ? threadLastVisitedAtById[thread.id] : undefined}
                  isFocused={isFocusedRow && index === focusedThreadIndex}
                  onSelectThread={onSelectThread}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
