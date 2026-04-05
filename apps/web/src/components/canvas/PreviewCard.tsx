/**
 * PreviewCard — Compact thread preview for non-focused canvas columns.
 *
 * Shows thread title, status indicator, last message preview, and timestamp.
 * Reuses SidebarThreadSummary data from the main Zustand store.
 */
import { memo, useCallback } from "react";
import { type ThreadId, type ProjectId } from "@t3tools/contracts";
import { type SidebarThreadSummary } from "../../types";
import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import { cn } from "../../lib/utils";

export interface PreviewCardProps {
  thread: SidebarThreadSummary;
  lastVisitedAt: string | undefined;
  isFocused: boolean;
  onSelect: (projectId: ProjectId, threadId: ThreadId) => void;
}

export const PreviewCard = memo(function PreviewCard({
  thread,
  lastVisitedAt,
  isFocused,
  onSelect,
}: PreviewCardProps) {
  const statusPill = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });

  const handleClick = useCallback(() => {
    onSelect(thread.projectId, thread.id);
  }, [onSelect, thread.projectId, thread.id]);

  const relativeTime = getRelativeTime(thread.createdAt);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex h-full w-[280px] shrink-0 cursor-pointer flex-col gap-2 overflow-hidden rounded-lg border bg-card p-3 text-left transition-colors",
        "contain-content",
        isFocused
          ? "border-primary/50 ring-1 ring-primary/30"
          : "border-border hover:border-border/80",
      )}
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: "280px 100%",
      }}
    >
      {/* Header: title + status */}
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {thread.title || "New thread"}
        </h3>
        {statusPill && <StatusDot pill={statusPill} />}
      </div>

      {/* Timestamp */}
      <span className="text-xs text-muted-foreground">{relativeTime}</span>

      {/* Branch indicator */}
      {thread.branch && (
        <span className="truncate text-xs text-muted-foreground/70">
          <span className="font-mono">{thread.branch}</span>
        </span>
      )}
    </button>
  );
});

function StatusDot({ pill }: { pill: ThreadStatusPill }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        className={cn(
          "inline-block size-2 rounded-full",
          pill.dotClass,
          pill.pulse && "animate-pulse",
        )}
      />
      <span className={cn("text-[10px] font-medium", pill.colorClass)}>{pill.label}</span>
    </span>
  );
}

function getRelativeTime(isoDate: string): string {
  const ms = Date.now() - Date.parse(isoDate);
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}
