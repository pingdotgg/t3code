import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ThreadId,
  type AgentDashboardFindingSeverity,
} from "@t3tools/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LoaderIcon,
  MessageCircleQuestionIcon,
  MessageCircleWarningIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  buildDashboardRepositoryQuestionPrompt,
  buildDashboardWorktreeGroups,
  buildResearchRepositoryGroups,
  configuredResearchDashboardUrl,
  isDashboardThreadActive,
  normalizeAgentDashboardSnapshot,
  resolveDashboardRepositoryName,
  resolveDashboardRepositoryStatus,
  resolveDashboardThreadState,
  resolveDashboardThreadActionLabel,
  resolveDashboardThreadStateLabel,
  selectDashboardThreadsForRepository,
  type DashboardRepositoryState,
  type DashboardServerRepository,
  type DashboardThreadRecord,
  type DashboardThreadState,
  type DashboardWorktreeGroup,
} from "../researchDashboard";
import {
  buildDashboardFindingQuestionPrompt,
  buildDashboardFindingRecords,
  buildDashboardUpdateQuestionPrompt,
  findDashboardProject,
  type DashboardFindingRecord,
  type NativeAgentFeedItem,
} from "../agentDashboardPages";
import { buildDashboardNeedsYouItems, type DashboardNeedsYouItem } from "../agentDashboardNeedsYou";
import { isElectron } from "../env";
import { usePrimarySettings } from "../hooks/useSettings";
import { newMessageId, newThreadId } from "../lib/utils";
import { resolveAppModelSelectionState } from "../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "../state/environments";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { agentDashboardEnvironment } from "../state/agentDashboard";
import { primaryServerProvidersAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import {
  AgentDashboardQuestionComposer,
  type AgentDashboardQuestionTarget,
} from "./AgentDashboardQuestionComposer";
import { AgentDashboardUpdates } from "./AgentDashboardUpdates";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { Button } from "./ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "./ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { SidebarInset } from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";

function repositoryStatusVariant(state: DashboardRepositoryState) {
  switch (state) {
    case "behind-main":
      return "warning" as const;
    case "ahead-of-main":
      return "info" as const;
    case "changes":
      return "outline" as const;
    case "clean":
      return "success" as const;
    case "not-repository":
    case "unavailable":
      return "outline" as const;
  }
}

function threadStatusVariant(state: DashboardThreadState) {
  switch (state) {
    case "running":
      return "info" as const;
    case "needs-input":
      return "warning" as const;
    case "error":
      return "error" as const;
    case "ready":
      return "success" as const;
    case "paused":
    case "idle":
      return "outline" as const;
  }
}

const ACTIVE_THREAD_PRIORITY = {
  "needs-input": 0,
  error: 1,
  running: 2,
  ready: 3,
  paused: 4,
  idle: 5,
} as const satisfies Record<DashboardThreadState, number>;

type DashboardQuestionTarget = AgentDashboardQuestionTarget & {
  readonly project: EnvironmentProject;
  readonly prompt:
    | { readonly kind: "repository" }
    | { readonly kind: "finding"; readonly record: DashboardFindingRecord }
    | { readonly kind: "update"; readonly update: NativeAgentFeedItem };
};

function RepositoryStatusBadge({
  state,
  label,
}: {
  readonly state: DashboardRepositoryState;
  readonly label: string;
}) {
  return (
    <Badge variant={repositoryStatusVariant(state)} size="sm">
      {state === "behind-main" ? <TriangleAlertIcon /> : null}
      {label}
    </Badge>
  );
}

function ThreadStatusBadge({ state }: { readonly state: DashboardThreadState }) {
  return (
    <Badge variant={threadStatusVariant(state)} size="sm">
      {state === "running" ? <LoaderIcon className="animate-spin" /> : null}
      {resolveDashboardThreadStateLabel(state)}
    </Badge>
  );
}

function DashboardThreadRow({
  thread,
  onOpenThread,
}: {
  readonly thread: DashboardThreadRecord;
  readonly onOpenThread: (thread: DashboardThreadRecord) => void;
}) {
  const state = resolveDashboardThreadState(thread);
  const actionLabel = resolveDashboardThreadActionLabel(state);
  const providerLabel = thread.session?.providerName ?? thread.modelSelection.instanceId;
  const updatedLabel = formatRelativeTimeLabel(thread.updatedAt);

  return (
    <div className="flex min-w-0 items-center gap-3 border-t border-border/60 px-3 py-2.5 first:border-t-0">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <SquareTerminalIcon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-sm font-medium">{thread.title}</p>
          <ThreadStatusBadge state={state} />
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span className="truncate font-mono">{thread.branch ?? "No branch"}</span>
          <span aria-hidden="true" className="text-muted-foreground/45">
            ·
          </span>
          <span className="truncate">{providerLabel}</span>
          {updatedLabel ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground/45">
                ·
              </span>
              <span>{updatedLabel}</span>
            </>
          ) : null}
        </div>
      </div>
      <Button
        aria-label={`${actionLabel} in thread ${thread.title}`}
        onClick={() => onOpenThread(thread)}
        size="xs"
        variant="outline"
      >
        <ArrowUpRightIcon />
        <span className="hidden sm:inline">{actionLabel}</span>
      </Button>
    </div>
  );
}

function needsYouPresentation(item: DashboardNeedsYouItem) {
  switch (item.kind) {
    case "thread":
      return item.state === "needs-input"
        ? { icon: MessageCircleWarningIcon, variant: "warning" as const, label: "Needs input" }
        : { icon: CircleAlertIcon, variant: "error" as const, label: "Agent error" };
    case "finding":
      return item.actionLabel === "Triage finding"
        ? { icon: TriangleAlertIcon, variant: "error" as const, label: "Critical finding" }
        : { icon: FileSearchIcon, variant: "warning" as const, label: "Open findings" };
    case "run":
      return { icon: CircleAlertIcon, variant: "error" as const, label: "Failed run" };
    case "coverage":
      return { icon: FolderGit2Icon, variant: "warning" as const, label: "Coverage" };
  }
}

function DashboardNeedsYouRow({
  item,
  onOpenThread,
}: {
  readonly item: DashboardNeedsYouItem;
  readonly onOpenThread: (environmentId: string, threadId: string) => void;
}) {
  const presentation = needsYouPresentation(item);
  const Icon = presentation.icon;
  const relativeTime = formatRelativeTimeLabel(item.updatedAt);
  const action = (() => {
    switch (item.kind) {
      case "thread":
        return (
          <Button
            className="min-h-11 w-full shrink-0 sm:w-auto"
            onClick={() => onOpenThread(item.environmentId, item.threadId)}
            size="sm"
            variant="outline"
          >
            {item.actionLabel}
            <ArrowUpRightIcon />
          </Button>
        );
      case "finding":
        return (
          <Button
            className="min-h-11 w-full shrink-0 sm:w-auto"
            render={
              <Link
                to="/agent-dashboard/findings"
                search={{
                  project: item.projectId,
                  severity: item.actionLabel === "Triage finding" ? "critical" : "all",
                  status: "all",
                  findingId: item.findingId,
                }}
              />
            }
            size="sm"
            variant="outline"
          >
            {item.actionLabel}
            <ArrowUpRightIcon />
          </Button>
        );
      case "run":
        return (
          <Button
            className="min-h-11 w-full shrink-0 sm:w-auto"
            render={
              <Link
                to="/agent-dashboard/runs"
                search={{
                  project: item.projectId,
                  status: "failed",
                  runId: item.runId,
                  focus: "runs",
                }}
              />
            }
            size="sm"
            variant="outline"
          >
            {item.actionLabel}
            <ArrowUpRightIcon />
          </Button>
        );
      case "coverage":
        return (
          <Button
            className="min-h-11 w-full shrink-0 sm:w-auto"
            render={
              <Link
                to="/agent-dashboard/runs"
                search={{ project: item.projectId, status: "all", focus: "coverage" }}
              />
            }
            size="sm"
            variant="outline"
          >
            {item.actionLabel}
            <ArrowUpRightIcon />
          </Button>
        );
    }
  })();

  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-border/60 px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:px-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 truncate text-sm font-medium">{item.title}</p>
            <Badge size="sm" variant={presentation.variant}>
              {presentation.label}
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.reason}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {item.projectName}
            {relativeTime ? ` · ${relativeTime}` : ""}
          </p>
        </div>
      </div>
      {action}
    </div>
  );
}

function DashboardWorktree({
  worktree,
  onOpenThread,
}: {
  readonly worktree: DashboardWorktreeGroup;
  readonly onOpenThread: (thread: DashboardThreadRecord) => void;
}) {
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: worktree.environmentId as EnvironmentId,
      input: { cwd: worktree.path },
    }),
  );
  const status = resolveDashboardRepositoryStatus(statusQuery.data, statusQuery.error);
  const branch = statusQuery.data?.refName ?? worktree.branch ?? "Detached HEAD";

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <GitBranchIcon className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-mono text-sm font-medium">{branch}</p>
            <RepositoryStatusBadge state={status.state} label={status.label} />
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{worktree.path}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {worktree.threads.length} {worktree.threads.length === 1 ? "agent" : "agents"}
        </span>
      </div>
      <div className="bg-muted/25">
        {worktree.threads.map((thread) => (
          <DashboardThreadRow key={thread.id} thread={thread} onOpenThread={onOpenThread} />
        ))}
      </div>
    </div>
  );
}

function RepositoryOverviewRow({
  group,
  threads,
  environmentLabelById,
  serverRepository,
  serverSnapshotPending,
  refreshServerSnapshot,
  onOpenThread,
  onAskRepository,
}: {
  readonly group: ReturnType<typeof buildResearchRepositoryGroups>[number];
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly serverRepository: DashboardServerRepository | null;
  readonly serverSnapshotPending: boolean;
  readonly refreshServerSnapshot: () => void;
  readonly onOpenThread: (thread: DashboardThreadRecord) => void;
  readonly onAskRepository: (
    project: EnvironmentProject,
    repositoryName: string,
    repositoryDetail: string,
  ) => void;
}) {
  const statusQuery = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: group.representative.environmentId,
      input: { cwd: group.representative.workspaceRoot },
    }),
  );
  const worktreeInventoryQuery = useEnvironmentQuery(
    vcsEnvironment.listRefs({
      environmentId: group.representative.environmentId,
      input: {
        cwd: group.representative.workspaceRoot,
        refKind: "local",
        refresh: true,
        limit: 1,
      },
    }),
  );
  const status = serverRepository?.vcs ?? statusQuery.data;
  const statusError = serverRepository === null ? statusQuery.error : null;
  const statusPending = serverRepository === null ? statusQuery.isPending : serverSnapshotPending;
  const repositoryStatus = resolveDashboardRepositoryStatus(status, statusError);
  const repositoryThreads = useMemo(
    () => selectDashboardThreadsForRepository(threads, group.memberProjectRefs),
    [group.memberProjectRefs, threads],
  );
  const mainThreads = repositoryThreads.filter((thread) => thread.worktreePath === null);
  const registeredWorktrees = worktreeInventoryQuery.data?.worktrees;
  const worktrees = useMemo(
    () =>
      buildDashboardWorktreeGroups({
        environmentId: group.representative.environmentId,
        worktrees: registeredWorktrees ?? [],
        threads: repositoryThreads,
      }),
    [group.representative.environmentId, registeredWorktrees, repositoryThreads],
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const primaryEnvironmentLabel =
    environmentLabelById.get(group.representative.environmentId) ?? "Environment";
  const branchLabel =
    status === null && statusPending ? "Loading" : (status?.refName ?? "Detached HEAD");
  const workingTreeLabel =
    status === null
      ? statusPending
        ? "Loading"
        : "Unavailable"
      : status.hasWorkingTreeChanges
        ? "Changes"
        : "Clean";
  const activeThreadCount = repositoryThreads.filter(isDashboardThreadActive).length;
  const repositoryName = resolveDashboardRepositoryName(group.representative);
  const worktreeCountLabel = worktreeInventoryQuery.isPending
    ? "Loading worktrees"
    : registeredWorktrees === undefined
      ? "Worktrees unavailable"
      : `${registeredWorktrees.length} Git ${registeredWorktrees.length === 1 ? "worktree" : "worktrees"}`;

  return (
    <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
      <div className="border-b border-border/60 last:border-b-0">
        <div className="flex min-w-0 items-stretch transition-colors hover:bg-muted/35">
          <CollapsibleTrigger className="group flex min-h-16 min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left sm:px-4">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
              <FolderGit2Icon className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-semibold">{repositoryName}</p>
                {activeThreadCount > 0 ? (
                  <Badge size="sm" variant="info">
                    {activeThreadCount} active
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {group.representative.workspaceRoot}
              </p>
            </div>
            <div className="hidden min-w-0 flex-[1.15] items-center justify-end gap-5 text-xs text-muted-foreground md:flex">
              <span className="min-w-0 truncate font-mono text-foreground/85">{branchLabel}</span>
              <span className="whitespace-nowrap">{workingTreeLabel}</span>
              <span className="whitespace-nowrap">
                {group.members.length} {group.members.length === 1 ? "checkout" : "checkouts"}
              </span>
              <span className="whitespace-nowrap">{worktreeCountLabel}</span>
            </div>
            <RepositoryStatusBadge state={repositoryStatus.state} label={repositoryStatus.label} />
            <ChevronDownIcon
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                detailsOpen && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center pr-3 sm:pr-4">
            <Button
              aria-label={`Ask about ${repositoryName}`}
              onClick={() =>
                onAskRepository(
                  group.representative,
                  repositoryName,
                  `${branchLabel} · ${repositoryStatus.label}`,
                )
              }
              size="xs"
              variant="outline"
            >
              <MessageCircleQuestionIcon />
              <span className="hidden sm:inline">Ask</span>
            </Button>
          </div>
        </div>

        <CollapsiblePanel>
          <div className="space-y-3 border-t border-border/60 bg-muted/15 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground md:hidden">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <GitBranchIcon className="size-3.5" />
                <span className="truncate font-mono text-foreground/85">{branchLabel}</span>
              </span>
              <span>{workingTreeLabel}</span>
              <span>
                {group.members.length} {group.members.length === 1 ? "checkout" : "checkouts"}
              </span>
              <span>{worktreeCountLabel}</span>
            </div>

            {statusError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{statusError}</span>
              </div>
            ) : null}

            <section className="overflow-hidden rounded-xl border border-border/70 bg-background">
              <div className="flex items-start gap-3 px-3 py-3">
                <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <GitBranchIcon className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {status?.isDefaultRef ? "Main checkout" : "Primary checkout"}
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                    {group.representative.workspaceRoot}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {repositoryStatus.detail} · {primaryEnvironmentLabel}
                  </p>
                </div>
                <Button
                  aria-label={`Refresh status for ${repositoryName}`}
                  disabled={statusPending}
                  onClick={serverRepository === null ? statusQuery.refresh : refreshServerSnapshot}
                  size="icon-xs"
                  variant="ghost"
                >
                  <RefreshCwIcon className={cn(statusPending && "animate-spin")} />
                </Button>
              </div>
              {mainThreads.length > 0 ? (
                <div className="border-t border-border/60">
                  {mainThreads.map((thread) => (
                    <DashboardThreadRow
                      key={thread.id}
                      thread={thread}
                      onOpenThread={onOpenThread}
                    />
                  ))}
                </div>
              ) : (
                <p className="border-t border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  No threads are attached to the primary checkout.
                </p>
              )}
            </section>

            {worktrees.length > 0 ? (
              <section className="overflow-hidden rounded-xl border border-border/70 bg-background">
                <div className="border-b border-border/60 px-3 py-2.5 text-sm font-medium">
                  Linked worktrees{" "}
                  <span className="text-muted-foreground">({worktrees.length})</span>
                </div>
                {worktrees.map((worktree) => (
                  <DashboardWorktree
                    key={worktree.key}
                    worktree={worktree}
                    onOpenThread={onOpenThread}
                  />
                ))}
              </section>
            ) : null}

            {group.members.length > 1 ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>Grouped checkouts:</span>
                {group.members.map(({ project }) => (
                  <span key={`${project.environmentId}:${project.id}`} className="font-mono">
                    {project.workspaceRoot}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

function DashboardLoadingState() {
  return (
    <Card className="overflow-hidden">
      {["one", "two", "three", "four"].map((key) => (
        <div
          key={key}
          className="flex min-h-16 items-center gap-3 border-b border-border/60 px-4 py-3 last:border-b-0"
        >
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-48 max-w-full" />
            <Skeleton className="h-3 w-80 max-w-full" />
          </div>
          <Skeleton className="hidden h-4 w-32 md:block" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </Card>
  );
}

function findingSeverityVariant(severity: AgentDashboardFindingSeverity) {
  switch (severity) {
    case "critical":
    case "high":
      return "error" as const;
    case "medium":
      return "warning" as const;
    case "low":
      return "outline" as const;
  }
}

function DashboardEmptyState() {
  return (
    <Empty className="min-h-[min(28rem,60vh)] rounded-2xl border border-dashed border-border/80 bg-card">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderGit2Icon />
        </EmptyMedia>
        <EmptyTitle>No repositories yet</EmptyTitle>
        <EmptyDescription>
          Add a project to T3 Code and it will appear here with its branch, worktrees, and agent
          threads.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          render={<a href={configuredResearchDashboardUrl()} target="_blank" rel="noreferrer" />}
          variant="outline"
        >
          <ExternalLinkIcon />
          Open standalone dashboard
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function AgentDashboard() {
  const projects = useProjects();
  const threads = useThreadShells();
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const allEnvironmentShellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  const router = useRouter();
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [questionTarget, setQuestionTarget] = useState<DashboardQuestionTarget | null>(null);
  const [questionPending, setQuestionPending] = useState(false);
  const [needsYouExpanded, setNeedsYouExpanded] = useState(false);
  const [activeThreadsExpanded, setActiveThreadsExpanded] = useState(false);
  const dashboardUrl = configuredResearchDashboardUrl();
  const serverSnapshotQuery = useEnvironmentQuery(
    primaryEnvironmentId === null
      ? null
      : agentDashboardEnvironment.snapshot({
          environmentId: primaryEnvironmentId,
          input: {},
        }),
  );
  const serverRepositories = useMemo(
    () =>
      serverSnapshotQuery.data === null || primaryEnvironmentId === null
        ? []
        : normalizeAgentDashboardSnapshot(serverSnapshotQuery.data, primaryEnvironmentId),
    [primaryEnvironmentId, serverSnapshotQuery.data],
  );
  const serverRepositoryByProjectKey = useMemo(
    () =>
      new Map(
        serverRepositories.map((repository) => [
          `${repository.environmentId}:${repository.projectId}`,
          repository,
        ]),
      ),
    [serverRepositories],
  );
  const portfolioHealth = serverSnapshotQuery.data?.portfolioHealth;
  const environmentLabelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const repositoryGroups = useMemo(
    () => buildResearchRepositoryGroups(projects, primaryEnvironmentId),
    [primaryEnvironmentId, projects],
  );
  const activeThreads = useMemo(() => {
    const uniqueThreads = new Map<string, DashboardThreadRecord>();

    for (const group of repositoryGroups) {
      for (const thread of selectDashboardThreadsForRepository(threads, group.memberProjectRefs)) {
        uniqueThreads.set(`${thread.environmentId}:${thread.id}`, thread);
      }
    }

    return [...uniqueThreads.values()].filter(isDashboardThreadActive).toSorted((left, right) => {
      const priorityDifference =
        ACTIVE_THREAD_PRIORITY[resolveDashboardThreadState(left)] -
        ACTIVE_THREAD_PRIORITY[resolveDashboardThreadState(right)];
      if (priorityDifference !== 0) return priorityDifference;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
  }, [repositoryGroups, threads]);
  const recentFindings = useMemo(
    () =>
      (serverSnapshotQuery.data?.findings ?? [])
        .toSorted((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
        .slice(0, 4),
    [serverSnapshotQuery.data?.findings],
  );
  const findingRecordById = useMemo(
    () =>
      new Map(
        (serverSnapshotQuery.data === null
          ? []
          : buildDashboardFindingRecords(serverSnapshotQuery.data)
        ).map((record) => [record.id, record]),
      ),
    [serverSnapshotQuery.data],
  );
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [String(project.id), project.title])),
    [projects],
  );
  const needsYouItems = useMemo(() => {
    const snapshot = serverSnapshotQuery.data;
    const repositoryNameById = new Map(
      (snapshot?.repositories ?? []).map((repository) => [
        String(repository.projectId),
        repository.title,
      ]),
    );
    const projectName = (projectId: string) =>
      repositoryNameById.get(projectId) ?? projectNameById.get(projectId) ?? "Repository";

    return buildDashboardNeedsYouItems({
      threads: activeThreads.flatMap((thread) => {
        const state = resolveDashboardThreadState(thread);
        if (state !== "needs-input" && state !== "error") return [];
        return [
          {
            environmentId: thread.environmentId,
            threadId: thread.id,
            title: thread.title,
            projectName: projectName(String(thread.projectId)),
            state,
            updatedAt: thread.updatedAt,
          },
        ];
      }),
      feedInputRequests: (snapshot?.feed ?? []).flatMap((item) => {
        if (item.status !== "needs-input" || primaryEnvironmentId === null) return [];
        return [
          {
            environmentId: primaryEnvironmentId,
            threadId: item.thread ? String(item.thread.threadId) : null,
            title: `Input requested in ${projectName(String(item.repository.projectId))}`,
            projectName: projectName(String(item.repository.projectId)),
            summary: item.summary,
            updatedAt: item.occurredAt,
          },
        ];
      }),
      findings: [...findingRecordById.values()].map((record) => ({
        id: record.id,
        projectId: record.projectId,
        projectName: record.projectName,
        title: record.finding.title,
        severity: record.finding.severity,
        status: record.status,
        updatedAt: record.updatedAt,
      })),
      runs: (snapshot?.automationRuns ?? []).map((run) => ({
        id: run.id,
        projectId: String(run.repository.projectId),
        projectName: projectName(String(run.repository.projectId)),
        title:
          run.target?.trim() ||
          (run.kind === "continuous-improvement"
            ? "Continuous improvement run"
            : `${run.kind} run`),
        status: run.status,
        updatedAt: run.updatedAt,
      })),
      coverage: (snapshot?.repositoryCoverage ?? []).map((coverage) => ({
        projectId: String(coverage.repository.projectId),
        projectName: projectName(String(coverage.repository.projectId)),
        status: coverage.status,
        lastRunId: coverage.lastRunId,
        lastError: coverage.lastError,
        updatedAt: coverage.observedAt,
      })),
    });
  }, [
    activeThreads,
    findingRecordById,
    primaryEnvironmentId,
    projectNameById,
    serverSnapshotQuery.data,
  ]);
  const needsYouCount = needsYouItems.length;
  const defaultModelSelection = useMemo(
    () => resolveAppModelSelectionState(settings, serverProviders),
    [serverProviders, settings],
  );
  const defaultModelLabel = defaultModelSelection.model.trim() || "an enabled model";
  const openThread = useCallback(
    (thread: DashboardThreadRecord) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: {
          ...scopeThreadRef(EnvironmentId.make(thread.environmentId), ThreadId.make(thread.id)),
        },
      });
    },
    [router],
  );
  const openScopedThread = useCallback(
    (environmentId: string, threadId: string) => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
      });
    },
    [router],
  );
  const askAboutRepository = useCallback(
    (project: EnvironmentProject, repositoryName: string, repositoryDetail: string) => {
      setQuestionTarget({
        key: `repository:${project.environmentId}:${project.id}`,
        kindLabel: "Repository",
        title: repositoryName,
        detail: repositoryDetail,
        project,
        prompt: { kind: "repository" },
      });
    },
    [],
  );
  const askAboutFinding = useCallback(
    (findingId: string) => {
      const record = findingRecordById.get(findingId);
      const environmentId = primaryEnvironmentId ?? primaryEnvironment?.environmentId ?? null;
      if (!record || environmentId === null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Finding context is unavailable",
            description: "Refresh the dashboard and try again.",
          }),
        );
        return;
      }
      const project = findDashboardProject(projects, record, environmentId);
      if (!project) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Add this repository first",
            description: `No T3 Code project is configured for ${record.repositoryPath || record.projectName}.`,
          }),
        );
        return;
      }
      setQuestionTarget({
        key: `finding:${record.id}`,
        kindLabel: "Finding",
        title: record.finding.title,
        detail: record.projectName,
        project,
        prompt: { kind: "finding", record },
      });
    },
    [findingRecordById, primaryEnvironment?.environmentId, primaryEnvironmentId, projects],
  );
  const askAboutUpdate = useCallback(
    (update: NativeAgentFeedItem) => {
      const project = findDashboardProject(
        projects,
        { projectId: update.projectId, repositoryPath: update.workspaceRoot },
        update.environmentId,
      );
      if (!project) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Add this repository first",
            description: `No T3 Code project is configured for ${update.workspaceRoot || update.projectName}.`,
          }),
        );
        return;
      }
      setQuestionTarget({
        key: `update:${update.id}`,
        kindLabel: "Update",
        title: update.title,
        detail: update.projectName,
        project,
        prompt: { kind: "update", update },
      });
    },
    [projects],
  );
  const submitDashboardQuestion = useCallback(
    async (question: string) => {
      if (questionTarget === null || questionPending) return;
      const prompt = question.trim();
      if (!prompt) return;
      const modelSelection = resolveAppModelSelectionState(settings, serverProviders);
      if (modelSelection.model.trim().length === 0) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Enable an agent provider first",
            description: "Choose and authenticate a provider before asking this question.",
          }),
        );
        return;
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const title = `Ask: ${questionTarget.title}`.slice(0, 80);
      let messageText: string;
      switch (questionTarget.prompt.kind) {
        case "finding":
          messageText = buildDashboardFindingQuestionPrompt(questionTarget.prompt.record, prompt);
          break;
        case "repository":
          messageText = buildDashboardRepositoryQuestionPrompt(questionTarget.project, prompt);
          break;
        case "update":
          messageText = buildDashboardUpdateQuestionPrompt(questionTarget.prompt.update, prompt);
          break;
        default: {
          const unreachable: never = questionTarget.prompt;
          throw new Error(`Unhandled dashboard question target: ${String(unreachable)}`);
        }
      }
      setQuestionPending(true);
      try {
        const result = await startThreadTurn({
          environmentId: questionTarget.project.environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: messageText,
              attachments: [],
            },
            modelSelection,
            titleSeed: title,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: questionTarget.project.id,
                title,
                modelSelection,
                runtimeMode: DEFAULT_RUNTIME_MODE,
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
            createdAt,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not start the conversation",
                description:
                  error instanceof Error
                    ? error.message
                    : "The agent session could not be started.",
              }),
            );
          }
          return;
        }
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: questionTarget.project.environmentId,
            threadId,
          },
        });
      } finally {
        setQuestionPending(false);
      }
    },
    [questionPending, questionTarget, router, serverProviders, settings, startThreadTurn],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader
          electron={isElectron}
          className="justify-between border-b border-border/70 bg-background"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-card text-muted-foreground">
              <FolderGit2Icon className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold tracking-tight">Agent Dashboard</h1>
              <p className="truncate text-xs text-muted-foreground/75">
                What needs you and what agents are doing now
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {activeThreads.length > 0 ? (
              <Button
                className="hidden sm:inline-flex"
                render={<a href="#dashboard-active" />}
                size="xs"
                variant="ghost"
              >
                {activeThreads.length} active
                <ArrowUpRightIcon />
              </Button>
            ) : null}
            <Button
              className="hidden md:inline-flex"
              render={<a href="#dashboard-repositories" />}
              size="xs"
              variant="ghost"
            >
              {repositoryGroups.length}{" "}
              {repositoryGroups.length === 1 ? "repository" : "repositories"}
            </Button>
            <Button render={<Link to="/agent-dashboard/findings" />} size="sm" variant="outline">
              <FileSearchIcon />
              <span className="hidden sm:inline">Findings</span>
            </Button>
            <Button
              render={
                <a
                  href={dashboardUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open standalone dashboard"
                />
              }
              size="icon-sm"
              variant="outline"
            >
              <ExternalLinkIcon />
            </Button>
          </div>
        </WorkspacePageHeader>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
            <Card className={cn(needsYouCount > 0 && "border-warning/35")}>
              <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 p-3 sm:p-4">
                <div className="min-w-0">
                  <CardTitle className="text-base">Needs you</CardTitle>
                  <CardDescription className="mt-1">
                    Open the exact work behind every decision, failure, and repository alert.
                  </CardDescription>
                </div>
                <Badge size="sm" variant={needsYouCount > 0 ? "warning" : "success"}>
                  {needsYouCount > 0
                    ? `${needsYouCount} ${needsYouCount === 1 ? "action" : "actions"}`
                    : "Clear"}
                </Badge>
              </CardHeader>
              <CardPanel className="p-0">
                {needsYouCount > 0 ? (
                  <>
                    {(needsYouExpanded ? needsYouItems : needsYouItems.slice(0, 4)).map((item) => (
                      <DashboardNeedsYouRow
                        item={item}
                        key={item.key}
                        onOpenThread={openScopedThread}
                      />
                    ))}
                    {needsYouItems.length > 4 ? (
                      <Button
                        className="min-h-11 w-full rounded-none border-x-0 border-b-0"
                        onClick={() => setNeedsYouExpanded((current) => !current)}
                        variant="ghost"
                      >
                        {needsYouExpanded
                          ? "Show priority actions only"
                          : `Show ${needsYouItems.length - 4} more ${needsYouItems.length - 4 === 1 ? "action" : "actions"}`}
                        <ChevronDownIcon
                          className={cn("transition-transform", needsYouExpanded && "rotate-180")}
                        />
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <div className="flex min-h-20 items-center gap-3 px-4 py-3 text-sm">
                    <CheckCircle2Icon className="size-4 text-success" />
                    <div>
                      <p className="font-medium">Nothing needs your intervention</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {serverSnapshotQuery.data === null
                          ? "Actionable repository health will appear when the server snapshot is available."
                          : "No agent requests, critical findings, failed runs, or coverage issues are waiting."}
                      </p>
                    </div>
                  </div>
                )}
              </CardPanel>
            </Card>

            <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(20rem,1fr)]">
              <Card className="overflow-hidden" id="dashboard-active">
                <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 p-3 sm:p-4">
                  <div className="min-w-0">
                    <CardTitle className="text-base">Active now</CardTitle>
                    <CardDescription className="mt-1">
                      Running agents and work ready for review or input.
                    </CardDescription>
                  </div>
                  {activeThreads.length > 6 ? (
                    <Button
                      onClick={() => setActiveThreadsExpanded((current) => !current)}
                      size="xs"
                      variant="ghost"
                    >
                      {activeThreadsExpanded ? "Show fewer" : "Show all"}
                      <ChevronDownIcon
                        className={cn(
                          "transition-transform",
                          activeThreadsExpanded && "rotate-180",
                        )}
                      />
                    </Button>
                  ) : null}
                </CardHeader>
                <CardPanel className="p-0">
                  {activeThreads.length > 0 ? (
                    <>
                      {(activeThreadsExpanded ? activeThreads : activeThreads.slice(0, 6)).map(
                        (thread) => (
                          <DashboardThreadRow
                            key={`${thread.environmentId}:${thread.id}`}
                            thread={thread}
                            onOpenThread={openThread}
                          />
                        ),
                      )}
                      {!activeThreadsExpanded && activeThreads.length > 6 ? (
                        <Button
                          className="h-9 w-full rounded-none border-x-0 border-b-0"
                          onClick={() => setActiveThreadsExpanded(true)}
                          variant="ghost"
                        >
                          Show {activeThreads.length - 6} more active agents
                          <ChevronDownIcon />
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex min-h-28 items-center gap-3 px-4 py-5">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <BotIcon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">No agents are active</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Running and actionable threads will appear here.
                        </p>
                      </div>
                      {repositoryGroups[0] ? (
                        <Button
                          onClick={() => {
                            const project = repositoryGroups[0]!.representative;
                            askAboutRepository(
                              project,
                              resolveDashboardRepositoryName(project),
                              "Repository overview",
                            );
                          }}
                          size="xs"
                          variant="outline"
                        >
                          <MessageCircleQuestionIcon />
                          Ask
                        </Button>
                      ) : null}
                    </div>
                  )}
                </CardPanel>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 p-3 sm:p-4">
                  <div className="min-w-0">
                    <CardTitle className="text-base">Recent findings</CardTitle>
                    <CardDescription className="mt-1">
                      Latest signals across repositories.
                    </CardDescription>
                  </div>
                  <Button
                    render={<Link to="/agent-dashboard/findings" />}
                    size="xs"
                    variant="ghost"
                  >
                    View all
                    <ArrowUpRightIcon />
                  </Button>
                </CardHeader>
                <CardPanel className="p-0">
                  {recentFindings.length > 0 ? (
                    recentFindings.map((finding) => {
                      const relativeTime = formatRelativeTimeLabel(finding.lastSeenAt);
                      return (
                        <div
                          className="flex min-h-16 items-start gap-3 border-t border-border/60 px-3 py-3 transition-colors first:border-t-0 hover:bg-muted/35 sm:px-4"
                          key={finding.id}
                        >
                          <FileSearchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-2 text-sm font-medium">{finding.title}</p>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {projectNameById.get(String(finding.repository.projectId)) ??
                                "Repository"}
                              {relativeTime ? ` · ${relativeTime}` : ""}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2">
                            <Badge size="sm" variant={findingSeverityVariant(finding.severity)}>
                              {finding.severity}
                            </Badge>
                            <div className="flex items-center gap-1">
                              <Button
                                aria-label={`Review finding ${finding.title}`}
                                render={<Link to="/agent-dashboard/findings" />}
                                size="xs"
                                variant="ghost"
                              >
                                Review
                              </Button>
                              <Button
                                aria-label={`Ask about finding ${finding.title}`}
                                onClick={() => askAboutFinding(finding.id)}
                                size="xs"
                                variant="outline"
                              >
                                <MessageCircleQuestionIcon />
                                Ask
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="flex min-h-28 items-center gap-3 px-4 py-5">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <FileSearchIcon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">No recent findings</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Findings will appear when repository collectors report them.
                        </p>
                      </div>
                      <Button
                        render={<Link to="/agent-dashboard/runs" />}
                        size="xs"
                        variant="outline"
                      >
                        Review runs
                      </Button>
                    </div>
                  )}
                </CardPanel>
              </Card>
            </div>

            <AgentDashboardUpdates onAsk={askAboutUpdate} onOpenThread={openScopedThread} />

            <section className="space-y-3" id="dashboard-repositories">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-heading text-base font-semibold tracking-tight">
                    Repositories
                  </h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expand a repository for checkout, worktree, and thread details.
                  </p>
                </div>
                {portfolioHealth ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <Button render={<Link to="/agent-dashboard/runs" />} size="xs" variant="ghost">
                      {portfolioHealth.healthyRepositoryCount} healthy
                    </Button>
                    {portfolioHealth.attentionRepositoryCount > 0 ? (
                      <Button
                        className="text-warning-foreground"
                        render={<Link to="/agent-dashboard/runs" />}
                        size="xs"
                        variant="ghost"
                      >
                        {portfolioHealth.attentionRepositoryCount} attention
                      </Button>
                    ) : null}
                    {portfolioHealth.unassessedRepositoryCount > 0 ? (
                      <Button
                        render={<Link to="/agent-dashboard/runs" />}
                        size="xs"
                        variant="ghost"
                      >
                        {portfolioHealth.unassessedRepositoryCount} unassessed
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {!allEnvironmentShellsBootstrapped && repositoryGroups.length === 0 ? (
                <DashboardLoadingState />
              ) : repositoryGroups.length === 0 ? (
                <DashboardEmptyState />
              ) : (
                <Card className="overflow-hidden">
                  {repositoryGroups.map((group) => (
                    <RepositoryOverviewRow
                      key={group.key}
                      group={group}
                      threads={threads}
                      environmentLabelById={environmentLabelById}
                      serverRepository={
                        group.members
                          .map(({ project }) =>
                            serverRepositoryByProjectKey.get(
                              `${project.environmentId}:${project.id}`,
                            ),
                          )
                          .find(
                            (repository): repository is DashboardServerRepository =>
                              repository !== undefined,
                          ) ?? null
                      }
                      serverSnapshotPending={serverSnapshotQuery.isPending}
                      refreshServerSnapshot={serverSnapshotQuery.refresh}
                      onOpenThread={openThread}
                      onAskRepository={askAboutRepository}
                    />
                  ))}
                </Card>
              )}
            </section>
          </div>
        </main>
        <AgentDashboardQuestionComposer
          key={questionTarget?.key ?? "dashboard-question-idle"}
          busy={questionPending}
          disabled={false}
          modelLabel={defaultModelLabel}
          onClose={() => setQuestionTarget(null)}
          onSubmit={(question) => void submitDashboardQuestion(question)}
          target={questionTarget}
        />
      </div>
    </SidebarInset>
  );
}
