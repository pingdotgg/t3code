import { scopeProjectRef, scopeThreadRef } from "@forma/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { IconMagnifyingglass as SearchIcon } from "symbols-react";
import { useCallback, useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useSettings } from "../hooks/useSettings";
import { openProjectOrCreateThread } from "../lib/chatThreadActions";
import { cn } from "../lib/utils";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { useUiStateStore } from "../uiStateStore";
import {
  getNoActiveThreadProjectItems,
  getNoActiveThreadRecentThreadItems,
  resolveNoActiveThreadStateVariant,
} from "./NoActiveThreadState.logic";
import { LogomarkForma } from "./LogomarkForma";
import { ProjectFavicon } from "./ProjectFavicon";
import { DesktopSidebarReopenButton } from "./sidebar/DesktopSidebarReopenButton";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { AddProjectIcon, NewThreadIcon, SettingsHexIcon } from "./icons/custom";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import type { Project, SidebarThreadSummary } from "../types";

const ACTION_CARD_CLASS_NAME =
  "relative isolate h-auto min-h-[11.5rem] w-full overflow-hidden rounded-[20px] border-border/55 bg-card/34 px-5 py-5 text-left whitespace-normal shadow-md shadow-black/5 transition-all duration-150 ease-out before:rounded-[19px] hover:-translate-y-0.5 hover:border-border/80 hover:bg-accent/24 hover:shadow-lg hover:ring-4 hover:ring-foreground/6 hover:ring-offset-4 hover:ring-offset-background active:translate-y-0 active:scale-[0.985] active:shadow-md";
const SECTION_HEADING_CLASS_NAME =
  "text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/64";

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

function renderThreadSubtitle(projectName: string | null, branch: string | null): string {
  const parts: string[] = [];
  if (projectName) {
    parts.push(projectName);
  }
  if (branch) {
    parts.push(`#${branch}`);
  }
  return parts.join(" · ");
}

function ThreadListRow({
  item,
  onClick,
}: {
  item: ReturnType<typeof getNoActiveThreadRecentThreadItems>[number];
  onClick: () => void;
}) {
  const subtitle = renderThreadSubtitle(item.projectName, item.thread.branch);

  return (
    <button
      type="button"
      data-testid={`no-active-thread-thread-row-${item.thread.id}`}
      className="flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/24 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <ThreadRowLeadingStatus thread={item.thread} />
          <span className="truncate text-sm font-medium text-foreground">{item.thread.title}</span>
        </div>
        {subtitle.length > 0 ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3 pl-2">
        <span className="text-xs text-muted-foreground">
          {formatRelativeTimeLabel(getThreadTimestamp(item.thread))}
        </span>
        <ThreadRowTrailingStatus thread={item.thread} />
      </div>
    </button>
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
      className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-accent/24 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onClick}
    >
      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-2xl bg-accent/35">
        <ProjectFavicon
          environmentId={item.project.environmentId}
          cwd={item.project.cwd}
          className="size-4 rounded-sm"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{item.project.name}</p>
        <p className="truncate text-xs text-muted-foreground">{item.project.cwd}</p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">
        {item.latestThread
          ? formatRelativeTimeLabel(getThreadTimestamp(item.latestThread))
          : "No threads yet"}
      </span>
    </button>
  );
}

export function NoActiveThreadState() {
  const navigate = useNavigate();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const settings = useSettings((state) => ({
    defaultThreadEnvMode: state.defaultThreadEnvMode,
    sidebarProjectSortOrder: state.sidebarProjectSortOrder,
    sidebarThreadSortOrder: state.sidebarThreadSortOrder,
  }));
  const { handleNewThread } = useHandleNewThread();
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
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const recentThreadItems = useMemo(
    () =>
      getNoActiveThreadRecentThreadItems({
        threads,
        projectNameById,
        sortOrder: settings.sidebarThreadSortOrder,
      }),
    [projectNameById, settings.sidebarThreadSortOrder, threads],
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
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              <DesktopSidebarReopenButton />
              <span>No active thread</span>
            </div>
          ) : (
            <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <DesktopSidebarReopenButton />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
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
                <Card className="overflow-hidden rounded-[1.75rem] border-border/55 bg-card/24 shadow-none">
                  {recentThreadItems.map((item, index) => (
                    <div
                      key={item.thread.id}
                      className={cn(index > 0 && "border-t border-border/60")}
                    >
                      <ThreadListRow item={item} onClick={() => void openThread(item.thread)} />
                    </div>
                  ))}
                </Card>
              </section>
            ) : null}

            {variant === "projects-no-threads" ? (
              <section className="space-y-3">
                <div className={SECTION_HEADING_CLASS_NAME}>Projects</div>
                <Card className="overflow-hidden rounded-[1.75rem] border-border/55 bg-card/24 shadow-none">
                  {projectItems.map((item, index) => (
                    <div
                      key={`${item.project.environmentId}:${item.project.id}`}
                      className={cn(index > 0 && "border-t border-border/60")}
                    >
                      <ProjectListRow
                        item={item}
                        onClick={() => void handleProjectRowClick(item.project)}
                      />
                    </div>
                  ))}
                </Card>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
