import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  IconChevronRight as ChevronRightIcon,
  IconMagnifyingglass as SearchIcon,
} from "symbols-react";
import type { GitListOpenPullRequestsResult } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useClientSettings } from "../hooks/useSettings";
import { openPullRequestLink, useOpenPrLink } from "../lib/openPullRequestLink";
import { readLocalApi } from "../localApi";
import { useProjects, useThreadShells } from "../state/entities";
import { gitEnvironment } from "../state/git";
import { useEnvironmentQuery } from "../state/query";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { Project, SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
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
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  ThreadRowLeadingStatus,
} from "./ThreadStatusIndicators";
import { AddProjectIcon, NewThreadIcon, SettingsHexIcon } from "./icons/custom";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { SidebarInset, SidebarTrigger } from "~/components/ui/sidebar";

const ACTION_CARD_CLASS_NAME =
  "relative isolate h-auto min-h-[11.5rem] w-full overflow-hidden rounded-[20px] border-border/60 bg-background px-5 py-5 text-left whitespace-normal shadow-sm shadow-black/5 transition-all duration-150 ease-out before:rounded-[19px] hover:-translate-y-0.5 hover:border-border/85 hover:bg-accent/16 hover:shadow-md hover:ring-4 hover:ring-foreground/5 hover:ring-offset-4 hover:ring-offset-background active:translate-y-0 active:scale-[0.985] active:shadow-sm";
const SECTION_HEADING_CLASS_NAME =
  "text-ui-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/64";
const LIST_TABLE_SHELL_CLASS_NAME = "rounded-[1.3rem] bg-foreground/5 p-1";
const LIST_TABLE_INNER_CLASS_NAME =
  "overflow-hidden rounded-[1.15rem] border border-border/55 bg-white dark:bg-white/5 shadow-sm";
const LIST_TABLE_HEADER_ROW_CLASS_NAME = "hidden items-center gap-4 px-4 py-2 md:grid";
const LIST_TABLE_HEADER_CELL_CLASS_NAME =
  "text-ui-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/68";
const RECENT_THREAD_TABLE_GRID_CLASS_NAME = "md:grid-cols-[minmax(0,1fr)_3rem]";
const PULL_REQUEST_TABLE_GRID_CLASS_NAME = "md:grid-cols-[minmax(0,1fr)_5rem]";
const PROJECT_TABLE_GRID_CLASS_NAME = "md:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)_auto]";

type OpenPullRequest = GitListOpenPullRequestsResult["pullRequests"][number];

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
  return item.project?.title ?? item.thread.worktreePath ?? "Unknown project";
}

function resolveThreadWorkspacePath(
  item: ReturnType<typeof getNoActiveThreadRecentThreadItems>[number],
): string | null {
  return item.thread.worktreePath ?? item.project?.workspaceRoot ?? null;
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

function ThreadListRow({
  item,
  onOpen,
}: {
  item: ReturnType<typeof getNoActiveThreadRecentThreadItems>[number];
  onOpen: () => void;
}) {
  const workspacePath = resolveThreadWorkspacePath(item);

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

  return (
    <div className="group/recent-thread">
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
            <ThreadRowLeadingStatus thread={item.thread} />
            <span className="truncate text-sm font-medium leading-5 text-foreground">
              {item.thread.title}
            </span>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground/72">
            <span
              className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} text-ui-xs leading-none`}
              title={workspacePath ?? resolveThreadProjectLabel(item)}
            >
              <ThreadBreadcrumbProjectChipContent
                icon={
                  <ProjectFavicon
                    environmentId={item.thread.environmentId}
                    cwd={item.project?.workspaceRoot ?? item.thread.worktreePath ?? ""}
                    className="size-3 shrink-0"
                  />
                }
                label={resolveThreadProjectLabel(item)}
              />
            </span>
            {item.thread.branch ? (
              <span
                className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} text-ui-xs leading-none`}
                title={item.thread.branch}
              >
                <ThreadBreadcrumbChipContent
                  icon={<ThreadBranchIcon />}
                  label={item.thread.branch}
                />
              </span>
            ) : null}
            <span className="text-ui-xs shrink-0 text-muted-foreground/68">
              {formatRelativeTimeLabel(getThreadTimestamp(item.thread))}
            </span>
          </div>
        </div>

        <div className="hidden h-7 w-12 shrink-0 items-center justify-center md:flex md:justify-self-end">
          <span className="text-muted-foreground/46" aria-hidden>
            <ChevronRightIcon className="size-3 fill-current" />
          </span>
        </div>
      </div>
    </div>
  );
}

function openPullRequestUrl(url: string) {
  const api = readLocalApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Link opening is unavailable.",
    });
    return;
  }

  void openPullRequestLink(api.shell, url).catch((error) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open pull request link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  });
}

function PullRequestListRow({
  pullRequest,
  project,
  thread,
  onOpenThread,
}: {
  pullRequest: OpenPullRequest;
  project: Project;
  thread: SidebarThreadSummary | null;
  onOpenThread: (() => void) | null;
}) {
  const prStatus = prStatusIndicator(pullRequest, undefined);
  const openPrLink = useOpenPrLink();

  const handleOpenPr = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      openPrLink(event, pullRequest.url);
    },
    [openPrLink, pullRequest.url],
  );

  if (!prStatus) {
    return null;
  }

  const handleOpenRow = onOpenThread ?? (() => openPullRequestUrl(pullRequest.url));

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`no-active-thread-pr-row-${pullRequest.number}`}
      className={cn(
        "group/pr-row flex w-full flex-col gap-3 border-t border-border/45 px-4 py-3 text-left first:border-t-0 transition-colors hover:bg-accent/12 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:bg-accent/12",
        PULL_REQUEST_TABLE_GRID_CLASS_NAME,
        "md:grid md:items-center md:gap-4",
      )}
      onClick={handleOpenRow}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        handleOpenRow();
      }}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <ChangeRequestStatusIcon className={cn("size-3.5 shrink-0", prStatus.colorClass)} />
          <span className="truncate text-sm font-medium leading-5 text-foreground">
            #{pullRequest.number} {pullRequest.title}
          </span>
        </div>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground/72">
          <span
            className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} text-ui-xs leading-none`}
            title={project.workspaceRoot}
          >
            <ThreadBreadcrumbProjectChipContent
              icon={
                <ProjectFavicon
                  environmentId={project.environmentId}
                  cwd={project.workspaceRoot}
                  className="size-3 shrink-0"
                />
              }
              label={project.title}
            />
          </span>
          <span
            className={`${THREAD_BREADCRUMB_PROJECT_CHIP_CLASS_NAME} text-ui-xs leading-none`}
            title={pullRequest.headRef}
          >
            <ThreadBreadcrumbChipContent icon={<ThreadBranchIcon />} label={pullRequest.headRef} />
          </span>
          {thread ? (
            <span className="text-ui-xs shrink-0 text-muted-foreground/68">
              {formatRelativeTimeLabel(getThreadTimestamp(thread))}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="xs" variant="outline" onClick={handleOpenPr}>
          View
        </Button>
      </div>
    </div>
  );
}

interface ProjectPullRequestQueryState {
  readonly isPending: boolean;
  readonly count: number;
}

function ProjectOpenPullRequests({
  project,
  recentThreadByBranch,
  onOpenThread,
  onQueryStateChange,
}: {
  project: Project;
  recentThreadByBranch: ReadonlyMap<string, SidebarThreadSummary>;
  onOpenThread: (thread: SidebarThreadSummary) => void;
  onQueryStateChange: (projectKey: string, state: ProjectPullRequestQueryState | null) => void;
}) {
  const projectKey = `${project.environmentId}:${project.id}`;
  const query = useEnvironmentQuery(
    gitEnvironment.openPullRequests({
      environmentId: project.environmentId,
      input: { cwd: project.workspaceRoot },
    }),
  );
  const pullRequests = query.data?.pullRequests ?? [];
  const pullRequestCount = pullRequests.length;

  useEffect(() => {
    onQueryStateChange(projectKey, { isPending: query.isPending, count: pullRequestCount });
  }, [onQueryStateChange, projectKey, pullRequestCount, query.isPending]);
  useEffect(
    () => () => {
      onQueryStateChange(projectKey, null);
    },
    [onQueryStateChange, projectKey],
  );

  return (
    <>
      {pullRequests.map((pullRequest) => {
        const matchingThread =
          recentThreadByBranch.get(`${projectKey}:${pullRequest.headRef}`) ?? null;
        return (
          <PullRequestListRow
            key={`${projectKey}:${pullRequest.number}`}
            pullRequest={pullRequest}
            project={project}
            thread={matchingThread}
            onOpenThread={matchingThread ? () => onOpenThread(matchingThread) : null}
          />
        );
      })}
    </>
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
            cwd={item.project.workspaceRoot}
            className="size-4 rounded-sm"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{item.project.title}</p>
          <p className="truncate text-xs text-muted-foreground md:hidden">
            {item.project.workspaceRoot}
          </p>
        </div>
      </div>
      <p className="hidden min-w-0 truncate text-sm text-muted-foreground md:block">
        {item.project.workspaceRoot}
      </p>
      <div className="flex shrink-0 items-center justify-between gap-3 md:justify-end">
        <span className="text-ui-xs text-muted-foreground/68">
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
  const projects = useProjects();
  const threads = useThreadShells();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const sidebarProjectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const sidebarThreadSortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);
  const { handleNewThread } = useHandleNewThread();

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
        sortOrder: sidebarThreadSortOrder,
      }),
    [projects, sidebarThreadSortOrder, threads],
  );
  const projectItems = useMemo(
    () =>
      getNoActiveThreadProjectItems({
        projects,
        threads,
        projectOrder,
        projectSortOrder: sidebarProjectSortOrder,
        threadSortOrder: sidebarThreadSortOrder,
      }),
    [projectOrder, projects, sidebarProjectSortOrder, sidebarThreadSortOrder, threads],
  );
  const singleProject = projects.length === 1 ? (projects[0] ?? null) : null;
  const pullRequestProjects = useMemo(
    () => (singleProject ? [singleProject] : projectItems.map((item) => item.project)),
    [projectItems, singleProject],
  );
  const [pullRequestQueryStates, setPullRequestQueryStates] = useState<
    Record<string, ProjectPullRequestQueryState>
  >({});
  const handlePullRequestQueryStateChange = useCallback(
    (projectKey: string, state: ProjectPullRequestQueryState | null) => {
      setPullRequestQueryStates((previous) => {
        const existing = previous[projectKey];
        if (state === null) {
          if (existing === undefined) {
            return previous;
          }
          const next = { ...previous };
          delete next[projectKey];
          return next;
        }
        if (
          existing !== undefined &&
          existing.isPending === state.isPending &&
          existing.count === state.count
        ) {
          return previous;
        }
        return { ...previous, [projectKey]: state };
      });
    },
    [],
  );
  const openPullRequestCount = pullRequestProjects.reduce(
    (total, project) =>
      total + (pullRequestQueryStates[`${project.environmentId}:${project.id}`]?.count ?? 0),
    0,
  );
  const isLoadingPullRequests = pullRequestProjects.some((project) => {
    const state = pullRequestQueryStates[`${project.environmentId}:${project.id}`];
    return state === undefined || state.isPending;
  });
  const recentThreadByBranch = useMemo(() => {
    const threadByBranch = new Map<string, SidebarThreadSummary>();
    for (const item of recentThreadItems) {
      if (!item.thread.branch) {
        continue;
      }
      const key = `${item.thread.environmentId}:${item.thread.projectId}:${item.thread.branch}`;
      if (threadByBranch.has(key)) {
        continue;
      }
      threadByBranch.set(key, item.thread);
    }
    return threadByBranch;
  }, [recentThreadItems]);

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
    async (item: { project: Project; latestThread: SidebarThreadSummary | null }) => {
      if (item.latestThread) {
        await openThread(item.latestThread);
        return;
      }
      await handleNewThread(scopeProjectRef(item.project.environmentId, item.project.id));
    },
    [handleNewThread, openThread],
  );
  const handleSingleProjectNewThread = useCallback(async () => {
    if (!singleProject) {
      return;
    }
    await handleNewThread(scopeProjectRef(singleProject.environmentId, singleProject.id));
  }, [handleNewThread, singleProject]);
  const actions = useMemo(() => {
    if (variant === "no-projects") {
      return [
        {
          title: "Add project",
          description: "Browse for a repo and create your first thread.",
          icon: <AddProjectIcon className="size-5 fill-current" />,
          testId: "no-active-thread-action-add-project",
          onClick: () => openCommandPalette({ open: "add-project" }),
        },
        {
          title: "Search",
          description: "Open commands, projects, and threads from one place.",
          icon: <SearchIcon className="size-5 fill-current" />,
          testId: "no-active-thread-action-search",
          onClick: () => openCommandPalette(),
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
        title: singleProject ? `New thread in ${singleProject.title}` : "New thread in...",
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
          openCommandPalette({ open: "new-thread-in" });
        },
      },
      {
        title: "Search",
        description: "Jump straight to a project or thread.",
        icon: <SearchIcon className="size-5 fill-current" />,
        testId: "no-active-thread-action-search",
        onClick: () => openCommandPalette(),
      },
      {
        title: "Add project",
        description: "Bring in a project into the workspace.",
        icon: <AddProjectIcon className="size-5 fill-current" />,
        testId: "no-active-thread-action-add-project",
        onClick: () => openCommandPalette({ open: "add-project" }),
      },
    ];
  }, [handleSingleProjectNewThread, navigate, singleProject, variant]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 wco:pr-[var(--workspace-native-controls-inset)]">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <DesktopSidebarReopenButton />
          </div>
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

            {projects.length > 0 ? (
              <section className="space-y-3">
                <div className={SECTION_HEADING_CLASS_NAME}>Pull requests</div>
                <div className={LIST_TABLE_SHELL_CLASS_NAME}>
                  <div
                    className={cn(
                      LIST_TABLE_HEADER_ROW_CLASS_NAME,
                      PULL_REQUEST_TABLE_GRID_CLASS_NAME,
                    )}
                  >
                    <div className={LIST_TABLE_HEADER_CELL_CLASS_NAME}>Pull request</div>
                    <div className={`${LIST_TABLE_HEADER_CELL_CLASS_NAME} text-right`}>Link</div>
                  </div>
                  <Card className={LIST_TABLE_INNER_CLASS_NAME}>
                    {openPullRequestCount === 0 ? (
                      <div className="px-4 py-3 text-sm text-muted-foreground">
                        {isLoadingPullRequests
                          ? "Loading pull requests..."
                          : "No open pull requests found."}
                      </div>
                    ) : null}
                    {pullRequestProjects.map((project) => (
                      <ProjectOpenPullRequests
                        key={`${project.environmentId}:${project.id}`}
                        project={project}
                        recentThreadByBranch={recentThreadByBranch}
                        onOpenThread={(thread) => void openThread(thread)}
                        onQueryStateChange={handlePullRequestQueryStateChange}
                      />
                    ))}
                  </Card>
                </div>
              </section>
            ) : null}

            {variant === "recent-threads" ? (
              <section className="space-y-3">
                <div className={SECTION_HEADING_CLASS_NAME}>Recent threads</div>
                <div className={LIST_TABLE_SHELL_CLASS_NAME}>
                  <div
                    className={cn(
                      LIST_TABLE_HEADER_ROW_CLASS_NAME,
                      RECENT_THREAD_TABLE_GRID_CLASS_NAME,
                    )}
                  >
                    <div
                      data-testid="no-active-thread-recent-threads-header-thread"
                      className={LIST_TABLE_HEADER_CELL_CLASS_NAME}
                    >
                      Thread
                    </div>
                    <div
                      data-testid="no-active-thread-recent-threads-header-actions"
                      className={`${LIST_TABLE_HEADER_CELL_CLASS_NAME} text-center`}
                    >
                      Open
                    </div>
                  </div>
                  <Card className={LIST_TABLE_INNER_CLASS_NAME}>
                    {recentThreadItems.map((item, index) => (
                      <div key={`${item.thread.environmentId}:${item.thread.id}`}>
                        {index > 0 ? <div className="mx-4 h-px bg-border/45" /> : null}
                        <ThreadListRow item={item} onOpen={() => void openThread(item.thread)} />
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
                  <div
                    className={cn(LIST_TABLE_HEADER_ROW_CLASS_NAME, PROJECT_TABLE_GRID_CLASS_NAME)}
                  >
                    <div className={LIST_TABLE_HEADER_CELL_CLASS_NAME}>Project</div>
                    <div className={LIST_TABLE_HEADER_CELL_CLASS_NAME}>Path</div>
                    <div className={`${LIST_TABLE_HEADER_CELL_CLASS_NAME} text-right`}>Recent</div>
                  </div>
                  <Card className={LIST_TABLE_INNER_CLASS_NAME}>
                    {projectItems.map((item, index) => (
                      <div key={`${item.project.environmentId}:${item.project.id}`}>
                        {index > 0 ? <div className="mx-4 h-px bg-border/45" /> : null}
                        <ProjectListRow
                          item={item}
                          onClick={() => void handleProjectRowClick(item)}
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
