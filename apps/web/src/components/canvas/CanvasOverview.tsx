/**
 * CanvasOverview — Bird's-eye overview of all projects and threads.
 *
 * Shows all project rows with miniature thread cards.
 * Supports HJKL/arrow navigation and click-to-focus.
 */
import { memo, useCallback, useMemo } from "react";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { animated, useSpring } from "@react-spring/web";
import { useCanvasStore } from "../../canvasStore";
import { useStore } from "../../store";
import { type SidebarThreadSummary, type Project } from "../../types";
import { SPRING_PROFILES } from "../../lib/springProfiles";
import { cn } from "../../lib/utils";

interface OverviewProjectRow {
  project: Project;
  threads: SidebarThreadSummary[];
}

export const CanvasOverview = memo(function CanvasOverview() {
  const mode = useCanvasStore((s) => s.mode);
  const overviewCursorProject = useCanvasStore((s) => s.overviewCursorProject);
  const overviewCursorThread = useCanvasStore((s) => s.overviewCursorThread);

  const projects = useStore((s) => s.projects);
  const sidebarThreadsById = useStore((s) => s.sidebarThreadsById);
  const threadIdsByProjectId = useStore((s) => s.threadIdsByProjectId);

  const rows: OverviewProjectRow[] = useMemo(() => {
    return projects.map((project) => {
      const threadIds = threadIdsByProjectId[project.id] ?? [];
      const threads = threadIds
        .map((id) => sidebarThreadsById[id])
        .filter((t): t is SidebarThreadSummary => t != null && t.archivedAt == null);
      return { project, threads };
    });
  }, [projects, threadIdsByProjectId, sidebarThreadsById]);

  const jumpToThread = useCanvasStore((s) => s.jumpToThread);

  const handleCardClick = useCallback(
    (projectId: ProjectId, threadId: ThreadId) => {
      jumpToThread(projectId, threadId);
    },
    [jumpToThread],
  );

  const springs = useSpring({
    opacity: mode === "overview" ? 1 : 0,
    scale: mode === "overview" ? 1 : 0.95,
    config: SPRING_PROFILES.overview,
  });

  if (mode !== "overview") return null;

  return (
    <animated.div
      className="absolute inset-0 z-50 overflow-auto bg-background/95 backdrop-blur-sm"
      style={{
        opacity: springs.opacity,
        transform: springs.scale.to((s) => `scale(${s})`),
      }}
    >
      <div className="mx-auto max-w-7xl p-6">
        <h2 className="mb-6 text-lg font-semibold text-foreground">Overview</h2>

        <div className="flex flex-col gap-4">
          {rows.map((row, projectIndex) => (
            <div key={row.project.id} className="flex flex-col gap-2">
              {/* Project label */}
              <h3 className="text-sm font-medium text-muted-foreground">{row.project.name}</h3>

              {/* Thread cards */}
              <div className="flex gap-2 overflow-x-auto pb-2">
                {row.threads.length === 0 && (
                  <div className="flex h-20 w-40 items-center justify-center rounded-md border border-dashed border-border/50 text-xs text-muted-foreground">
                    No threads
                  </div>
                )}
                {row.threads.map((thread, threadIndex) => {
                  const isCursor =
                    projectIndex === overviewCursorProject && threadIndex === overviewCursorThread;

                  return (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => handleCardClick(row.project.id, thread.id)}
                      className={cn(
                        "flex h-20 w-40 shrink-0 flex-col gap-1 rounded-md border bg-card p-2 text-left transition-all",
                        isCursor
                          ? "border-primary ring-2 ring-primary/30"
                          : "border-border hover:border-border/80",
                      )}
                    >
                      <span className="truncate text-xs font-medium text-foreground">
                        {thread.title || "New thread"}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {thread.session?.status === "running" ? "Working" : "Idle"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </animated.div>
  );
});
