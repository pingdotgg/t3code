import { ChevronRightIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL } from "../branding";
import { DEFAULT_MODEL } from "../model-logic";
import {
  asProjectId,
  asThreadId,
  newCommandId,
  newProjectId,
  newThreadId,
} from "../lib/orchestrationIds";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut } from "../keybindings";
import { type Thread } from "../types";
import { useNativeApi } from "../hooks/useNativeApi";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { toastManager } from "./ui/toast";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "./ui/sidebar";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";

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

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-3 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function Sidebar() {
  const { state, dispatch } = useStore();
  const api = useNativeApi();
  const navigate = useNavigate();
  const { settings: appSettings } = useAppSettings();
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
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const pendingApprovalByThreadId = useMemo(() => new Map<string, boolean>(), []);

  const handleNewThread = useCallback(
    (
      projectId: string,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
      },
    ): Promise<void> => {
      if (!api) return Promise.resolve();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const model =
        state.projects.find((project) => project.id === projectId)?.model ?? DEFAULT_MODEL;
      return (async () => {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: asProjectId(projectId),
          title: "New thread",
          model,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          createdAt,
        });

        // Ensure route guards can see the new thread before navigating.
        try {
          const snapshot = await api.orchestration.getSnapshot();
          dispatch({ type: "SYNC_SERVER_READ_MODEL", readModel: snapshot });
        } catch {
          // Event stream can still hydrate the thread shortly after dispatch.
        }

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [api, dispatch, navigate, state.projects],
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
        if (!api) return;
        const existing = state.projects.find((project) => project.cwd === cwd);
        if (existing) {
          focusMostRecentThreadForProject(existing.id);
          return;
        }

        const projectId = newProjectId();
        const createdAt = new Date().toISOString();
        const title = cwd.split(/[/\\]/).filter(Boolean).at(-1) ?? cwd;
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL,
          createdAt,
        });
        await handleNewThread(projectId);
      } finally {
        setIsAddingProject(false);
        setNewCwd("");
        setAddingProject(false);
      }
    },
    [
      api,
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      state.projects,
      state.threads,
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
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
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

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: asThreadId(threadId),
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
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
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: asThreadId(threadId),
      });
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
          force: true,
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
    [
      api,
      appSettings.confirmThreadDelete,
      dispatch,
      navigate,
      removeWorktreeMutation,
      routeThreadId,
      state.projects,
      state.threads,
    ],
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

      try {
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId: asProjectId(projectId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error deleting project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to delete "${project.name}"`,
          description: message,
        });
      }
    },
    [api, state.projects, state.threads],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const activeThread = routeThreadId
        ? state.threads.find((thread) => thread.id === routeThreadId)
        : undefined;
      if (isChatNewLocalShortcut(event, keybindings)) {
        const projectId = activeThread?.projectId ?? state.projects[0]?.id;
        if (!projectId) return;
        event.preventDefault();
        void handleNewThread(projectId);
        return;
      }

      if (!isChatNewShortcut(event, keybindings)) return;
      const projectId = activeThread?.projectId ?? state.projects[0]?.id;
      if (!projectId) return;
      event.preventDefault();
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? null,
      });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [handleNewThread, keybindings, routeThreadId, state.projects, state.threads]);

  return (
    <>
      <SidebarHeader
        className={`gap-3 ${isElectron ? "drag-region h-[52px] px-4 pl-[88px]" : "px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3"}`}
      >
        <div className="flex items-center gap-2">
          <SidebarTrigger className="shrink-0 md:hidden" />
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <T3Wordmark />
            <span className="truncate text-base font-medium tracking-tight text-muted-foreground">
              Code
            </span>
            <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-widest text-muted-foreground/60">
              {APP_STAGE_LABEL}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent"
          onClick={() => {
            if (state.projects.length === 0) {
              setAddingProject(true);
              return;
            }
            const firstProject = state.projects[0];
            if (firstProject) void handleNewThread(firstProject.id);
          }}
        >
          <span className="text-foreground">+</span>
          New thread
        </button>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 py-2">
          <SidebarMenu>
            {state.projects.map((project) => {
              const threads = state.threads
                .filter((thread) => thread.projectId === project.id)
                .toSorted((a, b) => {
                  const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
                  if (byDate !== 0) return byDate;
                  return b.id.localeCompare(a.id);
                });

              return (
                <Collapsible
                  key={project.id}
                  className="group/collapsible"
                  open={project.expanded}
                  onOpenChange={(open) => {
                    if (open === project.expanded) return;
                    dispatch({ type: "TOGGLE_PROJECT", projectId: project.id });
                  }}
                >
                  <SidebarMenuItem>
                    <CollapsibleTrigger
                      render={
                        <SidebarMenuButton
                          size="sm"
                          className="gap-2 px-2 py-1.5 text-left hover:bg-accent"
                        />
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        void handleProjectContextMenu(project.id, {
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <ChevronRightIcon
                        className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                          project.expanded ? "rotate-90" : ""
                        }`}
                      />
                      <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                        {project.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">{threads.length}</span>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <SidebarMenuSub className="mx-1 my-0 w-full translate-x-0 gap-0 px-1.5 py-0">
                        {threads.map((thread) => {
                          const isActive = routeThreadId === thread.id;
                          const threadStatus = threadStatusPill(
                            thread,
                            pendingApprovalByThreadId.get(thread.id) === true,
                          );
                          const terminalStatus = terminalStatusIndicator(thread);

                          return (
                            <SidebarMenuSubItem key={thread.id} className="w-full">
                              <SidebarMenuSubButton
                                render={<button type="button" />}
                                size="sm"
                                isActive={isActive}
                                className={`h-7 w-full translate-x-0 justify-start px-2 text-left hover:bg-accent hover:text-foreground ${
                                  isActive ? "text-foreground" : "text-muted-foreground"
                                }`}
                                onClick={() => {
                                  void navigate({
                                    to: "/$threadId",
                                    params: { threadId: thread.id },
                                  });
                                }}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  void handleThreadContextMenu(thread.id, {
                                    x: event.clientX,
                                    y: event.clientY,
                                  });
                                }}
                              >
                                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
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
                                  <span className="min-w-0 flex-1 truncate text-xs">
                                    {thread.title}
                                  </span>
                                </div>
                                <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          );
                        })}

                        <SidebarMenuSubItem className="w-full">
                          <SidebarMenuSubButton
                            render={<button type="button" />}
                            size="sm"
                            className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                            onClick={() => {
                              void handleNewThread(project.id);
                            }}
                          >
                            <span>+</span>
                            <span>New thread</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              );
            })}
          </SidebarMenu>

          {state.projects.length === 0 && !addingProject && (
            <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">
              No projects yet.
              <br />
              Add one to get started.
            </div>
          )}
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="gap-0 p-3">
        {addingProject ? (
          <>
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Add project
            </p>
            <input
              className="mb-2 w-full rounded-md border border-border bg-secondary px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-ring focus:outline-none"
              placeholder="/path/to/project"
              value={newCwd}
              onChange={(event) => setNewCwd(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleAddProject();
                if (event.key === "Escape") setAddingProject(false);
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
          </>
        ) : (
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground/70 transition-colors duration-150 hover:border-ring hover:text-muted-foreground"
            onClick={() => setAddingProject(true)}
          >
            + Add project
          </button>
        )}
      </SidebarFooter>

      <SidebarRail />
    </>
  );
}
