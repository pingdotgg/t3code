/**
 * CanvasShell — Main canvas container for Niri-style spatial navigation.
 *
 * Replaces the sidebar layout when canvas mode is enabled.
 * Manages:
 *   - Spring-animated 2D viewport (translate3d + scale)
 *   - Vertical virtualization of project rows
 *   - Horizontal virtualization of thread columns per row
 *   - Overview and Launcher overlays
 *   - Keyboard and mouse/trackpad navigation
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { animated, useSpring } from "@react-spring/web";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ProjectId, type ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useCanvasStore, setCanvasDataAccessors } from "../../canvasStore";
import { useStore } from "../../store";
import { useUiStateStore } from "../../uiStateStore";
import { SPRING_PROFILES, COLUMN_GAP, PREVIEW_COLUMN_WIDTH } from "../../lib/springProfiles";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import { type SidebarThreadSummary } from "../../types";
import { CanvasRow } from "./CanvasRow";
import { CanvasOverview } from "./CanvasOverview";
import { CanvasLauncher } from "./CanvasLauncher";
import { CanvasBreadcrumb } from "./CanvasBreadcrumb";
import { useCanvasNavigation } from "../../hooks/useCanvasNavigation";

interface CanvasShellProps {
  keybindings: ResolvedKeybindingsConfig;
}

export function CanvasShell({ keybindings }: CanvasShellProps) {
  const viewportRef = useRef<HTMLDivElement>(null);

  // ── Store subscriptions ──────────────────────────────────────────

  const projects = useStore((s) => s.projects);
  const sidebarThreadsById = useStore((s) => s.sidebarThreadsById);
  const threadIdsByProjectId = useStore((s) => s.threadIdsByProjectId);
  const threadLastVisitedAtById = useUiStateStore((s) => s.threadLastVisitedAtById);

  const focusedProjectIndex = useCanvasStore((s) => s.focusedProjectIndex);
  const focusedThreadIndex = useCanvasStore((s) => s.focusedThreadIndex);
  const columnWidthPreset = useCanvasStore((s) => s.columnWidthPreset);
  const projectThreadCursors = useCanvasStore((s) => s.projectThreadCursors);

  // ── Computed layout ──────────────────────────────────────────────

  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720;
  const activeColumnWidth = Math.floor(viewportWidth * columnWidthPreset);

  // ── Thread data accessor ─────────────────────────────────────────

  const getThreadsForProject = useCallback(
    (projectId: ProjectId | null): SidebarThreadSummary[] => {
      if (!projectId) return [];
      const threadIds = threadIdsByProjectId[projectId] ?? [];
      const threads = threadIds
        .map((id) => sidebarThreadsById[id])
        .filter((t): t is SidebarThreadSummary => t != null && t.archivedAt == null);
      return sortThreadsForSidebar(threads, "updated_at");
    },
    [threadIdsByProjectId, sidebarThreadsById],
  );

  const getProjects = useCallback(() => projects, [projects]);

  // Register data accessors for the canvas store
  useEffect(() => {
    setCanvasDataAccessors(getProjects, getThreadsForProject);
  }, [getProjects, getThreadsForProject]);

  // Sync focus IDs when data changes
  useEffect(() => {
    useCanvasStore.getState().syncFocus();
  }, [projects, threadIdsByProjectId, sidebarThreadsById]);

  // ── Spring animation ─────────────────────────────────────────────

  // Compute target position based on focused indices
  const targetX = useMemo(() => {
    // Before the focused thread, all columns are preview width
    let x = 0;
    for (let i = 0; i < focusedThreadIndex; i++) {
      x += PREVIEW_COLUMN_WIDTH + COLUMN_GAP;
    }
    return -x;
  }, [focusedThreadIndex]);

  const targetY = useMemo(() => {
    return -(focusedProjectIndex * viewportHeight);
  }, [focusedProjectIndex, viewportHeight]);

  const [springs, api] = useSpring(() => ({
    x: targetX,
    y: targetY,
    scale: 1,
    config: SPRING_PROFILES.horizontalNav,
  }));

  // Animate to new position when focus changes
  useEffect(() => {
    api.start({
      x: targetX,
      config: SPRING_PROFILES.horizontalNav,
    });
  }, [targetX, api]);

  useEffect(() => {
    api.start({
      y: targetY,
      config: SPRING_PROFILES.verticalNav,
    });
  }, [targetY, api]);

  // ── Vertical virtualizer (project rows) ──────────────────────────

  const rowVirtualizer = useVirtualizer({
    count: projects.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => viewportHeight,
    overscan: 1,
  });

  // ── Thread selection handler ──────────────────────────────────────

  const handleSelectThread = useCallback((projectId: ProjectId, threadId: ThreadId) => {
    useCanvasStore.getState().jumpToThread(projectId, threadId);
  }, []);

  // ── Keyboard navigation ──────────────────────────────────────────

  useCanvasNavigation({ keybindings });

  // ── Render ────────────────────────────────────────────────────────

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-background">
      {/* Breadcrumb header */}
      <div className="absolute left-0 right-0 top-0 z-30 flex h-12 items-center border-b border-border bg-card/95 px-4 backdrop-blur-sm">
        <CanvasBreadcrumb />
      </div>

      {/* Canvas viewport */}
      <div ref={viewportRef} className="h-full w-full overflow-hidden pt-12">
        <animated.div
          className="relative h-full"
          style={{
            transform: springs.x.to((x) => `translate3d(${x}px, 0, 0)`),
          }}
        >
          {/* Render project rows */}
          <div className="relative" style={{ height: rowVirtualizer.getTotalSize() }}>
            {virtualRows.map((virtualRow) => {
              const project = projects[virtualRow.index];
              if (!project) return null;

              const threads = getThreadsForProject(project.id);
              const isFocusedRow = virtualRow.index === focusedProjectIndex;
              const cursor = projectThreadCursors[project.id];

              return (
                <div
                  key={project.id}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <CanvasRow
                    projectId={project.id}
                    projectName={project.name}
                    threads={threads}
                    focusedThreadIndex={isFocusedRow ? focusedThreadIndex : -1}
                    isFocusedRow={isFocusedRow}
                    activeColumnWidth={activeColumnWidth}
                    viewportWidth={viewportWidth}
                    threadLastVisitedAtById={threadLastVisitedAtById}
                    hasMore={cursor?.hasMore ?? false}
                    onSelectThread={handleSelectThread}
                  />
                </div>
              );
            })}
          </div>
        </animated.div>
      </div>

      {/* Overlays */}
      <CanvasOverview />
      <CanvasLauncher />
    </div>
  );
}
