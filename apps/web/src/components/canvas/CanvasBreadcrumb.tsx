/**
 * CanvasBreadcrumb — Position indicator for the canvas header.
 *
 * Shows: [Project Name] > [Thread Title]  (3/12 threads)
 */
import { memo } from "react";
import { useCanvasStore } from "../../canvasStore";
import { useStore } from "../../store";
import { type SidebarThreadSummary } from "../../types";

export const CanvasBreadcrumb = memo(function CanvasBreadcrumb() {
  const focusedProjectId = useCanvasStore((s) => s.focusedProjectId);
  const focusedThreadId = useCanvasStore((s) => s.focusedThreadId);
  const focusedThreadIndex = useCanvasStore((s) => s.focusedThreadIndex);

  const project = useStore((s) => s.projects.find((p) => p.id === focusedProjectId));
  const threadSummary: SidebarThreadSummary | undefined = useStore((s) =>
    focusedThreadId ? s.sidebarThreadsById[focusedThreadId] : undefined,
  );
  const threadCount = useStore((s) =>
    focusedProjectId ? (s.threadIdsByProjectId[focusedProjectId]?.length ?? 0) : 0,
  );

  if (!project) return null;

  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{project.name}</span>
      {threadSummary && (
        <>
          <span className="text-muted-foreground/50">&rsaquo;</span>
          <span className="max-w-[200px] truncate">{threadSummary.title || "New thread"}</span>
        </>
      )}
      {threadCount > 0 && (
        <span className="ml-1 text-xs text-muted-foreground/70">
          ({focusedThreadIndex + 1}/{threadCount})
        </span>
      )}
    </div>
  );
});
