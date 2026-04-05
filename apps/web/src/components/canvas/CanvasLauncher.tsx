/**
 * CanvasLauncher — Fuzzy search overlay for projects and threads.
 *
 * Activated by Mod+Space. Shows recent threads by default,
 * fuzzy-searches across all projects and threads when query is entered.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import { animated, useSpring } from "@react-spring/web";
import { useCanvasStore } from "../../canvasStore";
import { useStore } from "../../store";
import { type SidebarThreadSummary } from "../../types";
import { SPRING_PROFILES } from "../../lib/springProfiles";
import { cn } from "../../lib/utils";

interface SearchResult {
  type: "project" | "thread";
  projectId: ProjectId;
  threadId: ThreadId | null;
  projectName: string;
  threadTitle: string | null;
  score: number;
}

export const CanvasLauncher = memo(function CanvasLauncher() {
  const mode = useCanvasStore((s) => s.mode);
  const query = useCanvasStore((s) => s.launcherQuery);
  const selectedIndex = useCanvasStore((s) => s.launcherSelectedIndex);
  const setQuery = useCanvasStore((s) => s.setLauncherQuery);
  const setSelectedIndex = useCanvasStore((s) => s.setLauncherSelectedIndex);
  const closeLauncher = useCanvasStore((s) => s.closeLauncher);
  const jumpToThread = useCanvasStore((s) => s.jumpToThread);

  const projects = useStore((s) => s.projects);
  const sidebarThreadsById = useStore((s) => s.sidebarThreadsById);
  const threadIdsByProjectId = useStore((s) => s.threadIdsByProjectId);

  const inputRef = useRef<HTMLInputElement>(null);

  // Build search results
  const results: SearchResult[] = useMemo(() => {
    if (!query.trim()) {
      // Default: show recent threads across all projects
      const allThreads: (SidebarThreadSummary & { projectName: string })[] = [];
      for (const project of projects) {
        const threadIds = threadIdsByProjectId[project.id] ?? [];
        for (const id of threadIds) {
          const thread = sidebarThreadsById[id];
          if (thread && !thread.archivedAt) {
            allThreads.push({ ...thread, projectName: project.name });
          }
        }
      }
      // Sort by creation date (newest first)
      allThreads.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return allThreads.slice(0, 20).map((t) => ({
        type: "thread" as const,
        projectId: t.projectId,
        threadId: t.id,
        projectName: t.projectName,
        threadTitle: t.title,
        score: 1,
      }));
    }

    // Fuzzy search
    const lowerQuery = query.toLowerCase();
    const scored: SearchResult[] = [];

    for (const project of projects) {
      const projectScore = fuzzyScore(project.name, lowerQuery);
      if (projectScore > 0) {
        scored.push({
          type: "project",
          projectId: project.id,
          threadId: null,
          projectName: project.name,
          threadTitle: null,
          score: projectScore,
        });
      }

      const threadIds = threadIdsByProjectId[project.id] ?? [];
      for (const id of threadIds) {
        const thread = sidebarThreadsById[id];
        if (!thread || thread.archivedAt) continue;
        const titleScore = fuzzyScore(thread.title, lowerQuery);
        if (titleScore > 0) {
          scored.push({
            type: "thread",
            projectId: project.id,
            threadId: thread.id,
            projectName: project.name,
            threadTitle: thread.title,
            score: titleScore,
          });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 30);
  }, [query, projects, threadIdsByProjectId, sidebarThreadsById]);

  // Focus input on open
  useEffect(() => {
    if (mode === "launcher") {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [mode]);

  const handleSelect = useCallback(
    (result: SearchResult) => {
      if (result.type === "thread" && result.threadId) {
        jumpToThread(result.projectId, result.threadId);
      } else if (result.type === "project") {
        // Jump to first thread of the project
        const threadIds = threadIdsByProjectId[result.projectId] ?? [];
        const firstThread = threadIds[0] ? sidebarThreadsById[threadIds[0]] : null;
        if (firstThread) {
          jumpToThread(result.projectId, firstThread.id);
        }
      }
    },
    [jumpToThread, threadIdsByProjectId, sidebarThreadsById],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex(Math.min(selectedIndex + 1, results.length - 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex(Math.max(selectedIndex - 1, 0));
          break;
        case "Enter": {
          event.preventDefault();
          const selected = results[selectedIndex];
          if (selected) handleSelect(selected);
          break;
        }
        case "Escape":
          event.preventDefault();
          closeLauncher();
          break;
      }
    },
    [selectedIndex, results, handleSelect, closeLauncher, setSelectedIndex],
  );

  const springs = useSpring({
    opacity: mode === "launcher" ? 1 : 0,
    y: mode === "launcher" ? 0 : -20,
    config: SPRING_PROFILES.cardReveal,
  });

  if (mode !== "launcher") return null;

  return (
    <animated.div
      className="absolute inset-0 z-50 flex items-start justify-center bg-background/80 pt-[15vh] backdrop-blur-sm"
      style={{ opacity: springs.opacity }}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeLauncher();
      }}
    >
      <animated.div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        style={{ transform: springs.y.to((y) => `translateY(${y}px)`) }}
      >
        {/* Search input */}
        <div className="border-b border-border px-4 py-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search projects and threads..."
            className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto">
          {results.length === 0 && query.trim() && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No results found
            </div>
          )}

          {results.map((result, index) => (
            <button
              key={`${result.projectId}-${result.threadId ?? "project"}`}
              type="button"
              className={cn(
                "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors",
                index === selectedIndex ? "bg-accent" : "hover:bg-accent/50",
              )}
              onClick={() => handleSelect(result)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded text-xs">
                {result.type === "project" ? "P" : "T"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">
                  {result.type === "thread"
                    ? result.threadTitle || "New thread"
                    : result.projectName}
                </div>
                {result.type === "thread" && (
                  <div className="truncate text-xs text-muted-foreground">{result.projectName}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      </animated.div>
    </animated.div>
  );
});

/** Simple fuzzy matching score. Returns 0 for no match. */
function fuzzyScore(text: string, query: string): number {
  const lower = text.toLowerCase();
  if (lower === query) return 2; // exact match
  if (lower.includes(query)) return 1; // substring match

  // Character-by-character fuzzy
  let qi = 0;
  for (let ti = 0; ti < lower.length && qi < query.length; ti++) {
    if (lower[ti] === query[qi]) qi++;
  }
  return qi === query.length ? 0.5 : 0;
}
