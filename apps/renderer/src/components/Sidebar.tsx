import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { DEFAULT_MODEL } from "../model-logic";
import { readNativeApi } from "../session-logic";
import { useStore } from "../store";
import type { Project } from "../types";

const THEME_CYCLE = { system: "light", light: "dark", dark: "system" } as const;


function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function threadStatusLabel(
  status: "connecting" | "ready" | "running" | "error" | "closed" | undefined,
): "Working" | "Connecting" | null {
  if (status === "running") return "Working";
  if (status === "connecting") return "Connecting";
  return null;
}

export default function Sidebar() {
  const { state, dispatch } = useStore();
  const api = useMemo(() => readNativeApi(), []);
  const { theme, setTheme } = useTheme();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);

  const handleAddProject = () => {
    const cwd = newCwd.trim();
    if (!cwd) return;
    const name = cwd.split("/").filter(Boolean).pop() ?? "project";
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      cwd,
      model: DEFAULT_MODEL,
      expanded: true,
    };
    dispatch({ type: "ADD_PROJECT", project });
    setNewCwd("");
    setAddingProject(false);
  };

  const handleNewThread = useCallback(
    (projectId: string) => {
      dispatch({
        type: "ADD_THREAD",
        thread: {
          id: crypto.randomUUID(),
          projectId,
          title: "New thread",
          model:
            state.projects.find((p) => p.id === projectId)?.model ??
            DEFAULT_MODEL,
          session: null,
          messages: [],
          events: [],
          error: null,
          createdAt: new Date().toISOString(),
        },
      });
    },
    [dispatch, state.projects],
  );

  const handlePickFolder = async () => {
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      if (!pickedPath) return;
      setNewCwd(pickedPath);
    } finally {
      setIsPickingFolder(false);
    }
  };

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const isNewThreadShortcut =
        event.metaKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === "o";
      if (!isNewThreadShortcut) return;

      const target = event.target;
      if (target instanceof HTMLElement) {
        const tagName = target.tagName;
        if (
          target.isContentEditable ||
          tagName === "INPUT" ||
          tagName === "TEXTAREA" ||
          tagName === "SELECT"
        ) {
          return;
        }
      }

      const activeThread = state.threads.find(
        (t) => t.id === state.activeThreadId,
      );
      const projectId = activeThread?.projectId ?? state.projects[0]?.id;
      if (!projectId) return;

      event.preventDefault();
      handleNewThread(projectId);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [handleNewThread, state.activeThreadId, state.projects, state.threads]);

  return (
    <aside className="sidebar flex h-full w-[260px] shrink-0 flex-col border-r border-border bg-card">
      {/* Drag region / traffic light space */}
      <div className="drag-region h-[52px] shrink-0" />
      {/* Branding */}
      <div className="flex items-center gap-2 px-4 pb-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
          CT
        </div>
        <span className="flex-1 text-sm font-semibold tracking-tight text-foreground">
          CodeThing
        </span>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-muted-foreground"
          onClick={() => setTheme(THEME_CYCLE[theme])}
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme}`}
        >
          {theme === "system" ? (
            <MonitorIcon className="size-3.5" />
          ) : theme === "light" ? (
            <SunIcon className="size-3.5" />
          ) : (
            <MoonIcon className="size-3.5" />
          )}
        </button>
      </div>

      {/* New thread (global) */}
      <div className="px-3 pb-3">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent"
          onClick={() => {
            if (state.projects.length === 0) {
              setAddingProject(true);
              return;
            }
            const firstProject = state.projects[0];
            if (firstProject) handleNewThread(firstProject.id);
          }}
        >
          <span className="text-foreground">+</span>
          New thread
        </button>
      </div>

      {/* Project list */}
      <nav className="flex-1 overflow-y-auto px-2">
        {state.projects.map((project) => {
          const threads = state.threads
            .filter((t) => t.projectId === project.id)
            .sort((a, b) => {
              const byDate =
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime();
              if (byDate !== 0) return byDate;
              return b.id.localeCompare(a.id);
            });
          return (
            <div key={project.id} className="mb-1">
              {/* Project header */}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent"
                onClick={() => dispatch({ type: "TOGGLE_PROJECT", projectId: project.id })}
              >
                <span className="text-[10px] text-muted-foreground/70">
                  {project.expanded ? "▼" : "▶"}
                </span>
                <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                  {project.name}
                </span>
                <span className="text-[10px] text-muted-foreground/60">{threads.length}</span>
              </button>

              {/* Threads */}
              {project.expanded && (
                <div className="ml-2 border-l border-border/80 pl-2">
                  {threads.map((thread) => {
                    const isActive = state.activeThreadId === thread.id;
                    const threadStatus = threadStatusLabel(
                      thread.session?.status,
                    );
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
                          isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-secondary"
                        }`}
                        onClick={() =>
                          dispatch({
                            type: "SET_ACTIVE_THREAD",
                            threadId: thread.id,
                          })
                        }
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          {threadStatus && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-sky-600 dark:text-sky-300/80">
                              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500 dark:bg-sky-300/80" />
                              <span className="hidden xl:inline">
                                {threadStatus}
                              </span>
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-xs">
                            {thread.title}
                          </span>
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground/40">
                          {formatRelativeTime(thread.createdAt)}
                        </span>
                      </button>
                    );
                  })}

                  {/* New thread within project */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground/60 transition-colors duration-150 hover:text-muted-foreground/80"
                    onClick={() => handleNewThread(project.id)}
                  >
                    <span>+</span> New thread
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {state.projects.length === 0 && !addingProject && (
          <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
            No projects yet.
            <br />
            Add one to get started.
          </div>
        )}
      </nav>

      {/* Add project form */}
      {addingProject ? (
        <div className="border-t border-border p-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Add project
          </p>
          <input
            className="mb-2 w-full rounded-md border border-border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-ring focus:outline-none"
            placeholder="/path/to/project"
            value={newCwd}
            onChange={(e) => setNewCwd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddProject();
              if (e.key === "Escape") setAddingProject(false);
            }}
          />
          {api && (
            <button
              type="button"
              className="mb-2 flex w-full items-center justify-center rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handlePickFolder()}
              disabled={isPickingFolder}
            >
              {isPickingFolder ? "Picking folder..." : "Browse for folder"}
            </button>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
              onClick={handleAddProject}
            >
              Add
            </button>
            <button
              type="button"
              className="flex-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground/80 transition-colors duration-150 hover:bg-secondary"
              onClick={() => setAddingProject(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="border-t border-border p-3">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground/70 transition-colors duration-150 hover:border-ring hover:text-muted-foreground"
            onClick={() => setAddingProject(true)}
          >
            + Add project
          </button>
        </div>
      )}
    </aside>
  );
}
