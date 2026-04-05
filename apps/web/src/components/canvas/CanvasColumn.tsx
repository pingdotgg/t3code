/**
 * CanvasColumn — A single thread column in the canvas.
 *
 * Renders either:
 *   - ActiveColumn: full ChatContent for the focused thread
 *   - PreviewColumn: compact PreviewCard for adjacent threads
 *   - SentinelColumn: loading trigger at the right edge
 */
import { memo } from "react";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { type SidebarThreadSummary } from "../../types";
import { ChatContent } from "../ChatContent";
import { PreviewCard } from "./PreviewCard";
import { COLUMN_GAP, PREVIEW_COLUMN_WIDTH } from "../../lib/springProfiles";

export type ColumnRole = "active" | "preview" | "sentinel";

export interface CanvasColumnProps {
  thread: SidebarThreadSummary | null;
  role: ColumnRole;
  activeColumnWidth: number;
  lastVisitedAt: string | undefined;
  isFocused: boolean;
  onSelectThread: (projectId: ProjectId, threadId: ThreadId) => void;
}

export const CanvasColumn = memo(function CanvasColumn({
  thread,
  role,
  activeColumnWidth,
  lastVisitedAt,
  isFocused,
  onSelectThread,
}: CanvasColumnProps) {
  const width = role === "active" ? activeColumnWidth : PREVIEW_COLUMN_WIDTH;

  return (
    <div
      className="relative shrink-0 overflow-hidden"
      style={{
        width,
        marginRight: COLUMN_GAP,
      }}
    >
      {role === "active" && thread && (
        <div className="h-full w-full">
          <ChatContent threadId={thread.id} />
        </div>
      )}

      {role === "preview" && thread && (
        <PreviewCard
          thread={thread}
          lastVisitedAt={lastVisitedAt}
          isFocused={isFocused}
          onSelect={onSelectThread}
        />
      )}

      {role === "sentinel" && (
        <div className="flex h-full w-[280px] items-center justify-center rounded-lg border border-dashed border-border/50">
          <span className="text-sm text-muted-foreground">Loading more...</span>
        </div>
      )}
    </div>
  );
});
