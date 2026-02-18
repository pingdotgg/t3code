import { MonitorIcon, MoonIcon, SunIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { DEFAULT_MODEL } from "../model-logic";
import { derivePendingApprovals } from "../session-logic";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut } from "../keybindings";
import { type Project, type Thread } from "../types";
import { useNativeApi } from "../hooks/useNativeApi";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { toastManager } from "./ui/toast";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { createThread } from "../threadFactory";

const THEME_CYCLE = { system: "light", light: "dark", dark: "system" } as const;
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function inferProjectName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : "project";
}

interface ThreadStatusPill {
  label: "Working" | "Connecting" | "Completed" | "Awaiting response";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

function hasUnseenCompletion(thread: Thread): boolean {
  if (!thread.latestTurnCompletedAt) return false;
  const completedAt = Date.parse(thread.latestTurnCompletedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

function threadStatusPill(thread: Thread, hasPendingApprovals: boolean): ThreadStatusPill | null {
  if (hasPendingApprovals) {
    return {
      label: "Awaiting response",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

function terminalStatusIndicator(thread: Thread): TerminalStatusIndicator | null {
  if (thread.runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export default function Sidebar() {
  const { state, dispatch } = useStore();
  const api = useNativeApi();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const routeThreadId = typeof params.threadId === "string" ? params.threadId : null;
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(api),
    select: (config) => config.keybindings,
  });
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(
    gitRemoveWorktreeMutationOptions({ api, queryClient }),
  );
  const { theme, setTheme } = useTheme();
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const thread of state.threads) {
      map.set(thread.id, derivePendingApprovals(thread.events).length > 0);
    }
    return map;
  }, [state.threads]);

  const handleNewThread = useCallback(
    (
      projectId: string,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
      },
    ) => {
      const thread = createThread(projectId, {
        model: state.projects.find((project) => project.id === projectId)?.model ?? DEFAULT_MODEL,
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
      });
      dispatch({
        type: "ADD_THREAD",
        thread,
      });
      void navigate({
        to: "/$threadId",
        params: { threadId: thread.id },
      });
    },
    [dispatch, navigate, state.projects],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: string) => {
      const latestThread = state.threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted((a, b) => {
          const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return b.id.localeCompare(a.id);
        })[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [navigate, state.threads],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;

      setIsAddingProject(true);
      try {
        if (isElectron && api) {
          const result = await api.projects.add({ cwd });
          const project: Project = {
            id: result.project.id,
            name: result.project.name,
            cwd: result.project.cwd,
            model: DEFAULT_MODEL,
            expanded: true,
            scripts: result.project.scripts,
          };
          const existingById = state.projects.find((p) => p.id === project.id);
          const existingByCwd = state.projects.find((p) => p.cwd === project.cwd);
          if (!existingById && !existingByCwd) {
            dispatch({ type: "ADD_PROJECT", project });
          }
          const resolvedProjectId = existingByCwd?.id ?? project.id;

          if (result.created) {
            handleNewThread(resolvedProjectId);
          } else {
            focusMostRecentThreadForProject(resolvedProjectId);
          }
        } else {
          const existing = state.projects.find((project) => project.cwd === cwd);
          if (existing) {
            focusMostRecentThreadForProject(existing.id);
            return;
          }

          const name = inferProjectName(cwd);
          const project: Project = {
            id: crypto.randomUUID(),
            name,
            cwd,
            model: DEFAULT_MODEL,
            expanded: true,
            scripts: [],
          };
          dispatch({ type: "ADD_PROJECT", project });
          handleNewThread(project.id);
        }
      } finally {
        setIsAddingProject(false);
        setNewCwd("");
        setAddingProject(false);
      }
    },
    [
      api,
      dispatch,
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      state.projects,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const handlePickFolder = async () => {
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      if (!pickedPath) return;
      await addProjectFromPath(pickedPath);
    } finally {
      setIsPickingFolder(false);
    }
  };

  const handleThreadContextMenu = useCallback(
    async (threadId: string, position: { x: number; y: number }) => {
      if (!api) return;
      const clicked = await api.contextMenu.show([{ id: "delete", label: "Delete" }], position);
      if (clicked !== "delete") return;

      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) return;
      const threadProject = state.projects.find((project) => project.id === thread.projectId);
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(state.threads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      // Stop active session if running
      if (thread.session?.sessionId) {
        try {
          await api.providers.stopSession({
            sessionId: thread.session.sessionId,
          });
        } catch {
          // Session may already be stopped
        }
      }

      try {
        await api.terminal.close({
          threadId,
          deleteHistory: true,
        });
      } catch {
        // Terminal may already be closed
      }

      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = state.threads.find((entry) => entry.id !== threadId)?.id ?? null;
      dispatch({ type: "DELETE_THREAD", threadId });
      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [api, dispatch, navigate, removeWorktreeMutation, routeThreadId, state.projects, state.threads],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: string, position: { x: number; y: number }) => {
      if (!api) return;
      const clicked = await api.contextMenu.show([{ id: "delete", label: "Delete" }], position);
      if (clicked !== "delete") return;

      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = state.threads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before deleting it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [`Delete project "${project.name}"?`, "This action cannot be undone."].join("\n"),
      );
      if (!confirmed) return;

      if (isElectron) {
        try {
          await api.projects.remove({ id: projectId });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error deleting project.";
          console.error("Failed to remove project", { projectId, error });
          toastManager.add({
            type: "error",
            title: `Failed to delete "${project.name}"`,
            description: message,
          });
          return;
        }
      }

      dispatch({ type: "DELETE_PROJECT", projectId });
    },
    [api, dispatch, state.projects, state.threads],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const activeThread = state.threads.find((t) => t.id === state.activeThreadId);
      if (isChatNewLocalShortcut(event, keybindings)) {
        const projectId = activeThread?.projectId ?? state.projects[0]?.id;
        if (!projectId) return;
        event.preventDefault();
        handleNewThread(projectId);
        return;
      }

      if (!isChatNewShortcut(event, keybindings)) return;
      const projectId = activeThread?.projectId ?? state.projects[0]?.id;
      if (!projectId) return;
      event.preventDefault();
      handleNewThread(projectId, {
        branch: activeThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? null,
      });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [handleNewThread, keybindings, state.activeThreadId, state.projects, state.threads]);

  return (
    <aside className="sidebar flex h-full w-[260px] shrink-0 flex-col border-r border-border bg-card">
      {/* Branding */}
      <div
        className={`flex items-center gap-2.5 px-4 ${isElectron ? "drag-region h-[52px] pl-[76px]" : "py-4"}`}
      >
        <span className="flex-1 text-sm font-semibold tracking-tight text-foreground">
          T3 <span className="font-normal text-muted-foreground">Code</span>
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
            .toSorted((a, b) => {
              const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
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
                onContextMenu={(e) => {
                  e.preventDefault();
                  void handleProjectContextMenu(project.id, {
                    x: e.clientX,
                    y: e.clientY,
                  });
                }}
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
                    const isActive = routeThreadId === thread.id;
                    const threadStatus = threadStatusPill(
                      thread,
                      pendingApprovalByThreadId.get(thread.id) === true,
                    );
                    const terminalStatus = terminalStatusIndicator(thread);
                    return (
                      <button
                        key={thread.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150 ${
                          isActive
                            ? "bg-accent text-foreground"
                            : "text-muted-foreground hover:bg-secondary"
                        }`}
                        onClick={() => {
                          void navigate({
                            to: "/$threadId",
                            params: { threadId: thread.id },
                          });
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          void handleThreadContextMenu(thread.id, {
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                          {threadStatus && (
                            <span
                              className={`inline-flex items-center gap-1 text-[10px] ${threadStatus.colorClass}`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${threadStatus.dotClass} ${
                                  threadStatus.pulse ? "animate-pulse" : ""
                                }`}
                              />
                              <span className="hidden md:inline">{threadStatus.label}</span>
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
                        </div>
                        <div className="ml-2 flex shrink-0 items-center gap-1.5">
                          {terminalStatus && (
                            <span
                              role="img"
                              aria-label={terminalStatus.label}
                              title={terminalStatus.label}
                              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                            >
                              <TerminalIcon
                                className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`}
                              />
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground/40">
                            {formatRelativeTime(thread.createdAt)}
                          </span>
                        </div>
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
          {isElectron && api && (
            <button
              type="button"
              className="mb-2 flex w-full items-center justify-center rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handlePickFolder()}
              disabled={isPickingFolder || isAddingProject}
            >
              {isPickingFolder ? "Picking folder..." : "Browse for folder"}
            </button>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90"
              onClick={handleAddProject}
              disabled={isAddingProject}
            >
              {isAddingProject ? "Adding..." : "Add"}
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
