import { scopeProjectRef, scopeThreadRef } from "@forma/client-runtime";
import type { ScopedThreadRef } from "@forma/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  IconChevronRight as ChevronRightIcon,
  IconCube as CubeIcon,
  IconEllipsis as EllipsisIcon,
  IconMagnifyingglass as SearchIcon,
} from "symbols-react";
import {
  useCallback,
  useMemo,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { useThreadRowActions } from "../hooks/useThreadRowActions";
import { openProjectOrCreateThread } from "../lib/chatThreadActions";
import { MICRO_FADE_MOTION_CLASS_NAME } from "../lib/motion";
import { cn } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import {
  getNoActiveThreadProjectItems,
  getNoActiveThreadRecentThreadItems,
  resolveNoActiveThreadStateVariant,
} from "./NoActiveThreadState.logic";
import { LogomarkForma } from "./LogomarkForma";
import { ProjectFavicon } from "./ProjectFavicon";
import { DesktopSidebarReopenButton } from "./sidebar/DesktopSidebarReopenButton";
import {
  ThreadBreadcrumbChipContent,
  ThreadBreadcrumbProjectChipContent,
  THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME,
} from "./ThreadBreadcrumb";
import { ThreadRowLeadingStatus } from "./ThreadStatusIndicators";
import { AddProjectIcon, NewThreadIcon, SettingsHexIcon, SidebarArchiveIcon } from "./icons/custom";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { SidebarInset, SidebarTrigger, useSidebar } from "./ui/sidebar";

const ACTION_CARD_CLASS_NAME =
  "relative isolate h-auto min-h-[11.5rem] w-full overflow-hidden rounded-[20px] border-border/55 bg-card/34 px-5 py-5 text-left whitespace-normal shadow-md shadow-black/5 transition-all duration-150 ease-out before:rounded-[19px] hover:-translate-y-0.5 hover:border-border/80 hover:bg-accent/24 hover:shadow-lg hover:ring-4 hover:ring-foreground/6 hover:ring-offset-4 hover:ring-offset-background active:translate-y-0 active:scale-[0.985] active:shadow-md";
const SECTION_HEADING_CLASS_NAME =
  "text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/64";
const LIST_TABLE_SHELL_CLASS_NAME =
  "rounded-[1.5rem] bg-foreground/5 p-0.5";
const LIST_TABLE_INNER_CLASS_NAME =
  "overflow-hidden rounded-[1.15rem] border border-border/55 bg-white dark:bg-white/5 shadow-sm";
const LIST_TABLE_HEADER_CLASS_NAME =
  "hidden items-center gap-4 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/68 md:grid";
const RECENT_THREAD_TABLE_GRID_CLASS_NAME = "md:grid-cols-[minmax(0,1fr)_3rem]";
const PROJECT_TABLE_GRID_CLASS_NAME = "md:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)_auto]";

interface ActionCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  testId: string;
  onClick: () => void;
}

function ActionCard({ title, description, icon, testId, onClick }: ActionCardProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="xl"
      data-testid={testId}
      className={ACTION_CARD_CLASS_NAME}
      onClick={onClick}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 text-foreground/[0.06] opacity-70"
        style={{
          backgroundImage: "radial-gradient(currentColor 0.8px, transparent 0.8px)",
          backgroundSize: "12px 12px",
        }}
      />
      <span className="relative z-10 flex h-full w-full flex-col justify-between gap-2">
        <span className="inline-flex size-12 shrink-0">{icon}</span>
        <span className="flex min-h-[4.75rem] flex-col items-start gap-1.5">
          <span className="text-base font-semibold leading-6 text-foreground">{title}</span>
          <span className="max-w-[28ch] text-sm leading-6 text-muted-foreground/88">
            {description}
          </span>
        </span>
      </span>
    </Button>
  );
}

function getThreadTimestamp(
  thread: Pick<SidebarThreadSummary, "latestUserMessageAt" | "updatedAt" | "createdAt">,
): string {
  return thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
}

function resolveThreadProjectLabel(
  item: ReturnType<typeof getNoActiveThreadRecentThreadItems>[number],
) {
  return item.project?.name ?? item.thread.worktreePath ?? "Unknown project";
}

function resolveThreadWorkspacePath(
  item: ReturnType<typeof getNoActiveThreadRecentThreadItems>[number],
): string | null {
  return item.thread.worktreePath ?? item.project?.cwd ?? null;
}

function renderThreadProjectBreadcrumbIcon() {
  return <CubeIcon className="size-3 shrink-0 fill-current opacity-70" aria-hidden />;
}

function ThreadBranchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className="size-3 shrink-0 fill-current opacity-70"
    >
      <path d="M9.5 3.25a2.25 2.25 0 0 1 4.315-.894c.164.378.22.795.164 1.203A2.25 2.25 0 0 1 12.5 5.371V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.25 2.25 0 1 1-1.5 0V5.37a2.25 2.25 0 1 1 1.5 0v1.836a2.492 2.492 0 0 1 1-.208h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.499.75.75 0 0 0 0-1.5Zm-7.5 9.499a.75.75 0 1 0 0 1.499.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}

function stopPointerEventPropagation(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
}

function stopMouseEventPropagation(event: MouseEvent<HTMLElement>) {
  event.stopPropagation();
}

function ThreadListRow({
  item,
  confirmThreadArchive,
  onOpen,
  archiveNow,
  copyThreadId,
  copyWorkspacePath,
  deleteWithConfirmation,
  markUnread,
}: {
  item: ReturnType<typeof getNoActiveThreadRecentThreadItems>[number];
  confirmThreadArchive: boolean;
  onOpen: () => void;
  archiveNow: (threadRef: ScopedThreadRef) => Promise<void>;
  copyThreadId: ReturnType<typeof useThreadRowActions>["copyThreadId"];
  copyWorkspacePath: ReturnType<typeof useThreadRowActions>["copyWorkspacePath"];
  deleteWithConfirmation: ReturnType<typeof useThreadRowActions>["deleteWithConfirmation"];
  markUnread: ReturnType<typeof useThreadRowActions>["markUnread"];
}) {
  const [isConfirmingArchive, setIsConfirmingArchive] = useState(false);
  const threadRef = scopeThreadRef(item.thread.environmentId, item.thread.id);
  const isThreadRunning =
    item.thread.session?.status === "running" && item.thread.session.activeTurnId != null;
  const canArchive = !isThreadRunning;
  const workspacePath = resolveThreadWorkspacePath(item);
  const defaultChevronClassName = cn(
    "pointer-coarse:opacity-0 transition-opacity [transition-duration:var(--motion-duration-micro)] [transition-timing-function:var(--motion-ease-out)] group-hover/recent-thread:opacity-0 group-focus-within/recent-thread:opacity-0",
    MICRO_FADE_MOTION_CLASS_NAME,
    isConfirmingArchive && "opacity-0",
  );
  const actionRailClassName = cn(
    "pointer-events-none absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-1 opacity-0 group-hover/recent-thread:pointer-events-auto group-hover/recent-thread:opacity-100 group-focus-within/recent-thread:pointer-events-auto group-focus-within/recent-thread:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100",
    MICRO_FADE_MOTION_CLASS_NAME,
    isConfirmingArchive && "pointer-events-auto opacity-100",
  );

  const clearArchiveConfirmation = useCallback(() => {
    setIsConfirmingArchive(false);
  }, []);

  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearArchiveConfirmation();
      });
    },
    [clearArchiveConfirmation],
  );

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onOpen();
    },
    [onOpen],
  );

  const handleArchiveConfirmation = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearArchiveConfirmation();
      void archiveNow(threadRef);
    },
    [archiveNow, clearArchiveConfirmation, threadRef],
  );

  const handleStartArchiveConfirmation = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsConfirmingArchive(true);
  }, []);

  const handleArchiveImmediately = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void archiveNow(threadRef);
    },
    [archiveNow, threadRef],
  );

  const handleArchiveFromMenu = useCallback(() => {
    clearArchiveConfirmation();
    void archiveNow(threadRef);
  }, [archiveNow, clearArchiveConfirmation, threadRef]);

  const handleDelete = useCallback(() => {
    clearArchiveConfirmation();
    void deleteWithConfirmation(threadRef);
  }, [clearArchiveConfirmation, deleteWithConfirmation, threadRef]);

  const handleMarkUnread = useCallback(() => {
    markUnread({
      threadRef,
      latestTurnCompletedAt: item.thread.latestTurn?.completedAt,
    });
  }, [item.thread.latestTurn?.completedAt, markUnread, threadRef]);

  const handleCopyPath = useCallback(() => {
    copyWorkspacePath(workspacePath);
  }, [copyWorkspacePath, workspacePath]);

  const handleCopyThreadId = useCallback(() => {
    copyThreadId(item.thread.id);
  }, [copyThreadId, item.thread.id]);

  return (
    <div
      className="group/recent-thread"
      onBlurCapture={handleBlurCapture}
      onMouseLeave={clearArchiveConfirmation}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={`no-active-thread-thread-row-${item.thread.id}`}
        className={cn(
          "group/recent-thread-row relative flex w-full flex-col gap-3 rounded-[1rem] px-4 py-3 text-left transition-colors hover:bg-accent/12 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:bg-accent/12",
          RECENT_THREAD_TABLE_GRID_CLASS_NAME,
          "md:grid md:items-center md:gap-4",
        )}
        onClick={onOpen}
        onKeyDown={handleRowKeyDown}
      >
        <div className="min-w-0 md:min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <ThreadRowLeadingStatus thread={item.thread} compact />
            <span className="truncate text-sm font-medium leading-5 text-foreground">
              {item.thread.title}
            </span>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden text-xs text-muted-foreground/72">
            <span
              className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} text-[11px] leading-none`}
              title={workspacePath ?? resolveThreadProjectLabel(item)}
            >
              <ThreadBreadcrumbProjectChipContent
                icon={renderThreadProjectBreadcrumbIcon()}
                label={resolveThreadProjectLabel(item)}
              />
            </span>
            {item.thread.branch ? (
              <span
                className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} text-[11px] leading-none`}
                title={item.thread.branch}
              >
                <ThreadBreadcrumbChipContent
                  icon={<ThreadBranchIcon />}
                  label={item.thread.branch}
                />
              </span>
            ) : null}
            <span className="shrink-0 text-[11px] text-muted-foreground/68">
              {formatRelativeTimeLabel(getThreadTimestamp(item.thread))}
            </span>
          </div>
        </div>

        <div className="relative hidden h-7 w-12 shrink-0 items-center justify-center md:flex md:justify-self-end">
          <span className={cn("text-muted-foreground/46", defaultChevronClassName)} aria-hidden>
            <ChevronRightIcon className="size-3 fill-current" />
          </span>

          <div
            data-testid={`no-active-thread-thread-actions-${item.thread.id}`}
            className={actionRailClassName}
          >
            {isConfirmingArchive ? (
              <button
                type="button"
                data-testid={`no-active-thread-thread-archive-confirm-${item.thread.id}`}
                aria-label={`Confirm archive ${item.thread.title}`}
                className="pointer-coarse:hidden inline-flex h-7 cursor-pointer items-center rounded-full bg-destructive/12 px-2.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={stopPointerEventPropagation}
                onClick={handleArchiveConfirmation}
              >
                Confirm
              </button>
            ) : canArchive ? (
              confirmThreadArchive ? (
                <button
                  type="button"
                  data-testid={`no-active-thread-thread-archive-${item.thread.id}`}
                  aria-label={`Archive ${item.thread.title}`}
                  className="pointer-coarse:hidden inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/58 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring [&_svg]:fill-current"
                  onPointerDown={stopPointerEventPropagation}
                  onClick={handleStartArchiveConfirmation}
                >
                  <SidebarArchiveIcon className="size-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`no-active-thread-thread-archive-${item.thread.id}`}
                  aria-label={`Archive ${item.thread.title}`}
                  className="pointer-coarse:hidden inline-flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/58 transition-colors hover:bg-accent/80 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring [&_svg]:fill-current"
                  onPointerDown={stopPointerEventPropagation}
                  onClick={handleArchiveImmediately}
                >
                  <SidebarArchiveIcon className="size-3.5" />
                </button>
              )
            ) : null}

            <div onClick={stopMouseEventPropagation} onPointerDown={stopPointerEventPropagation}>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      aria-label="Recent thread actions"
                      size="icon-xs"
                      variant="ghost"
                      data-testid={`no-active-thread-thread-menu-trigger-${item.thread.id}`}
                      className="size-7 rounded-lg text-muted-foreground/58 transition-colors hover:bg-accent/80 hover:text-foreground data-[popup-open]:bg-accent/80 data-[popup-open]:text-foreground"
                    />
                  }
                >
                  <EllipsisIcon aria-hidden="true" className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-40">
                  <MenuItem
                    disabled={!item.thread.latestTurn?.completedAt}
                    onClick={handleMarkUnread}
                  >
                    Mark unread
                  </MenuItem>
                  <MenuItem disabled={!workspacePath} onClick={handleCopyPath}>
                    Copy path
                  </MenuItem>
                  <MenuItem onClick={handleCopyThreadId}>Copy thread ID</MenuItem>
                  {canArchive ? <MenuItem onClick={handleArchiveFromMenu}>Archive</MenuItem> : null}
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={handleDelete}>
                    Delete
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-1 md:hidden">
          <div onClick={stopMouseEventPropagation} onPointerDown={stopPointerEventPropagation}>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    aria-label="Recent thread actions"
                    size="icon-xs"
                    variant="ghost"
                    className="size-7 rounded-lg text-muted-foreground/58 transition-colors hover:bg-accent/80 hover:text-foreground data-[popup-open]:bg-accent/80 data-[popup-open]:text-foreground"
                  />
                }
              >
                <EllipsisIcon aria-hidden="true" className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom" className="min-w-40">
                <MenuItem
                  disabled={!item.thread.latestTurn?.completedAt}
                  onClick={handleMarkUnread}
                >
                  Mark unread
                </MenuItem>
                <MenuItem disabled={!workspacePath} onClick={handleCopyPath}>
                  Copy path
                </MenuItem>
                <MenuItem onClick={handleCopyThreadId}>Copy thread ID</MenuItem>
                {canArchive ? <MenuItem onClick={handleArchiveFromMenu}>Archive</MenuItem> : null}
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={handleDelete}>
                  Delete
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectListRow({
  item,
  onClick,
}: {
  item: ReturnType<typeof getNoActiveThreadProjectItems>[number];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`no-active-thread-project-row-${item.project.id}`}
      className={cn(
        "group/project-row flex w-full flex-col gap-3 rounded-[1rem] px-4 py-3 text-left transition-colors hover:bg-accent/12 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        PROJECT_TABLE_GRID_CLASS_NAME,
        "md:grid md:items-center md:gap-4",
      )}
      onClick={onClick}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-2xl bg-accent/35">
          <ProjectFavicon
            environmentId={item.project.environmentId}
            cwd={item.project.cwd}
            className="size-4 rounded-sm"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{item.project.name}</p>
          <p className="truncate text-xs text-muted-foreground md:hidden">{item.project.cwd}</p>
        </div>
      </div>
      <p className="hidden min-w-0 truncate text-sm text-muted-foreground md:block">
        {item.project.cwd}
      </p>
      <div className="flex shrink-0 items-center justify-between gap-3 md:justify-end">
        <span className="text-[11px] text-muted-foreground/68">
          {item.latestThread
            ? formatRelativeTimeLabel(getThreadTimestamp(item.latestThread))
            : "No threads yet"}
        </span>
        <ChevronRightIcon className="size-3 shrink-0 fill-current text-muted-foreground/46" />
      </div>
    </button>
  );
}

export function NoActiveThreadState() {
  const navigate = useNavigate();
  const { isMobile, open } = useSidebar();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const settings = useSettings((state) => ({
    confirmThreadArchive: state.confirmThreadArchive,
    defaultThreadEnvMode: state.defaultThreadEnvMode,
    sidebarProjectSortOrder: state.sidebarProjectSortOrder,
    sidebarThreadSortOrder: state.sidebarThreadSortOrder,
  }));
  const { handleNewThread } = useHandleNewThread();
  const { archiveNow, copyThreadId, copyWorkspacePath, deleteWithConfirmation, markUnread } =
    useThreadRowActions();
  const setCommandPaletteOpen = useCommandPaletteStore((store) => store.setOpen);
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  const openNewThreadIn = useCommandPaletteStore((store) => store.openNewThreadIn);

  const variant = useMemo(
    () =>
      resolveNoActiveThreadStateVariant({
        projects,
        threads,
      }),
    [projects, threads],
  );
  const recentThreadItems = useMemo(
    () =>
      getNoActiveThreadRecentThreadItems({
        projects,
        threads,
        sortOrder: settings.sidebarThreadSortOrder,
      }),
    [projects, settings.sidebarThreadSortOrder, threads],
  );
  const projectItems = useMemo(
    () =>
      getNoActiveThreadProjectItems({
        projects,
        threads,
        projectOrder,
        projectSortOrder: settings.sidebarProjectSortOrder,
        threadSortOrder: settings.sidebarThreadSortOrder,
      }),
    [
      projectOrder,
      projects,
      settings.sidebarProjectSortOrder,
      settings.sidebarThreadSortOrder,
      threads,
    ],
  );
  const singleProject = projects.length === 1 ? (projects[0] ?? null) : null;
  const showSidebarControls = isElectron || isMobile || !open;

  const openThread = useCallback(
    async (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) => {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      });
    },
    [navigate],
  );
  const handleProjectRowClick = useCallback(
    async (project: Project) => {
      await openProjectOrCreateThread({
        project,
        threads: threads.filter((thread) => thread.environmentId === project.environmentId),
        sortOrder: settings.sidebarThreadSortOrder,
        context: {
          defaultThreadEnvMode: settings.defaultThreadEnvMode,
          handleNewThread,
        },
        openThread,
      });
    },
    [
      handleNewThread,
      openThread,
      settings.defaultThreadEnvMode,
      settings.sidebarThreadSortOrder,
      threads,
    ],
  );
  const handleSingleProjectNewThread = useCallback(async () => {
    if (!singleProject) {
      return;
    }

    await handleNewThread(scopeProjectRef(singleProject.environmentId, singleProject.id), {
      envMode: settings.defaultThreadEnvMode,
    });
  }, [handleNewThread, settings.defaultThreadEnvMode, singleProject]);
  const actions = useMemo(() => {
    if (variant === "no-projects") {
      return [
        {
          title: "Add project",
          description: "Browse for a repo and create your first thread.",
          icon: <AddProjectIcon className="size-5 fill-current" />,
          testId: "no-active-thread-action-add-project",
          onClick: openAddProject,
        },
        {
          title: "Search",
          description: "Open commands, projects, and threads from one place.",
          icon: <SearchIcon className="size-5 fill-current" />,
          testId: "no-active-thread-action-search",
          onClick: () => setCommandPaletteOpen(true),
        },
        {
          title: "Open settings",
          description: "Adjust defaults, keybindings, and local app behavior.",
          icon: <SettingsHexIcon className="size-5 text-current" />,
          testId: "no-active-thread-action-settings",
          onClick: () => {
            void navigate({ to: "/settings" });
          },
        },
      ];
    }

    return [
      {
        title: singleProject ? `New thread in ${singleProject.name}` : "New thread in...",
        description: singleProject
          ? "Create a fresh thread in this project."
          : "Create a fresh thread in any project.",
        icon: <NewThreadIcon className="size-5 fill-current" />,
        testId: "no-active-thread-action-new-thread",
        onClick: () => {
          if (singleProject) {
            void handleSingleProjectNewThread();
            return;
          }
          openNewThreadIn();
        },
      },
      {
        title: "Search",
        description: "Jump straight to a project or thread.",
        icon: <SearchIcon className="size-5 fill-current" />,
        testId: "no-active-thread-action-search",
        onClick: () => setCommandPaletteOpen(true),
      },
      {
        title: "Add project",
        description: "Bring in a project into the workspace.",
        icon: <AddProjectIcon className="size-5 fill-current" />,
        testId: "no-active-thread-action-add-project",
        onClick: openAddProject,
      },
    ];
  }, [
    handleSingleProjectNewThread,
    navigate,
    openAddProject,
    openNewThreadIn,
    setCommandPaletteOpen,
    singleProject,
    variant,
  ]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-muted/[0.18] text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-muted/[0.18]">
        <header
          className={cn(
            "px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              {showSidebarControls ? (
                <>
                  <SidebarTrigger className="size-7 shrink-0 md:hidden" />
                  <DesktopSidebarReopenButton />
                </>
              ) : null}
            </div>
          ) : (
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              {showSidebarControls ? (
                <>
                  <SidebarTrigger className="size-7 shrink-0 md:hidden" />
                  <DesktopSidebarReopenButton />
                </>
              ) : null}
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="no-active-thread-state">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-14">
            <section className="flex items-start">
              <div className="inline-flex size-12 items-center justify-center text-foreground sm:size-14">
                <LogomarkForma className="size-14" aria-hidden="true" />
              </div>
            </section>

            <section className="grid auto-rows-fr gap-4 md:grid-cols-3">
              {actions.map((action) => (
                <ActionCard key={action.testId} {...action} />
              ))}
            </section>

            {variant === "recent-threads" ? (
              <section className="space-y-3">
                <div className={SECTION_HEADING_CLASS_NAME}>Recent threads</div>
                <div className={LIST_TABLE_SHELL_CLASS_NAME}>
                  <div
                    className={cn(
                      LIST_TABLE_HEADER_CLASS_NAME,
                      RECENT_THREAD_TABLE_GRID_CLASS_NAME,
                    )}
                  >
                    <div>Thread</div>
                    <div className="text-center">Actions</div>
                  </div>
                  <Card className={LIST_TABLE_INNER_CLASS_NAME}>
                    {recentThreadItems.map((item, index) => (
                      <div key={`${item.thread.environmentId}:${item.thread.id}`}>
                        {index > 0 ? <div className="mx-4 h-px bg-border/45" /> : null}
                        <ThreadListRow
                          item={item}
                          confirmThreadArchive={settings.confirmThreadArchive}
                          onOpen={() => void openThread(item.thread)}
                          archiveNow={archiveNow}
                          copyThreadId={copyThreadId}
                          copyWorkspacePath={copyWorkspacePath}
                          deleteWithConfirmation={deleteWithConfirmation}
                          markUnread={markUnread}
                        />
                      </div>
                    ))}
                  </Card>
                </div>
              </section>
            ) : null}

            {variant === "projects-no-threads" ? (
              <section className="space-y-3">
                <div className={SECTION_HEADING_CLASS_NAME}>Projects</div>
                <div className={LIST_TABLE_SHELL_CLASS_NAME}>
                  <div className={cn(LIST_TABLE_HEADER_CLASS_NAME, PROJECT_TABLE_GRID_CLASS_NAME)}>
                    <div>Project</div>
                    <div>Path</div>
                    <div className="text-right">Recent</div>
                  </div>
                  <Card className={LIST_TABLE_INNER_CLASS_NAME}>
                    {projectItems.map((item, index) => (
                      <div key={`${item.project.environmentId}:${item.project.id}`}>
                        {index > 0 ? <div className="mx-4 h-px bg-border/45" /> : null}
                        <ProjectListRow
                          item={item}
                          onClick={() => void handleProjectRowClick(item.project)}
                        />
                      </div>
                    ))}
                  </Card>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
