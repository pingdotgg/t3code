import { scopeThreadRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  CheckCircle2Icon,
  CircleStopIcon,
  Clock3Icon,
  ExternalLinkIcon,
  GitCompareArrowsIcon,
  ListTodoIcon,
  MessageCircleQuestionIcon,
  PlayIcon,
  ShieldAlertIcon,
  SquareTerminalIcon,
  Trash2Icon,
  TrophyIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../environmentApi";
import {
  bakeoffThreadKeys,
  buildBakeoffViews,
  useBakeoffs,
  type Bakeoff,
  type BakeoffView,
} from "../bakeoffs";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { useThreadActions } from "../hooks/useThreadActions";
import { newCommandId } from "../lib/utils";
import { useServerConfig } from "../rpc/serverState";
import {
  buildAgentRuns,
  buildTerminalProcessRuns,
  isAgentRunActive,
  type AgentRun,
  type AgentRunStatus,
  type TerminalProcessRun,
} from "../runs";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { useKnownTerminalSessionsAcrossEnvironments } from "../terminalSessionState";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { BakeoffCreateDialog } from "./BakeoffCreateDialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

type RunFilter = "all" | "active" | "recent";

const STATUS_META: Record<
  AgentRunStatus,
  {
    label: string;
    badge: "error" | "info" | "success" | "warning" | "secondary";
    icon: typeof PlayIcon;
  }
> = {
  "awaiting-approval": { label: "Approval needed", badge: "warning", icon: ShieldAlertIcon },
  "awaiting-input": { label: "Input needed", badge: "info", icon: MessageCircleQuestionIcon },
  running: { label: "Running", badge: "info", icon: PlayIcon },
  completed: { label: "Completed", badge: "success", icon: CheckCircle2Icon },
  interrupted: { label: "Interrupted", badge: "secondary", icon: CircleStopIcon },
  failed: { label: "Failed", badge: "error", icon: XCircleIcon },
};

export function RunsView() {
  const navigate = useNavigate();
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryServerConfig = useServerConfig();
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const [bakeoffs, setBakeoffs] = useBakeoffs();
  const [createBakeoffOpen, setCreateBakeoffOpen] = useState(false);
  const environmentIds = useMemo(
    () => [...new Set(threads.map((thread) => thread.environmentId))],
    [threads],
  );
  const terminalSessions = useKnownTerminalSessionsAcrossEnvironments(environmentIds);
  const ensureTerminal = useTerminalUiStateStore((state) => state.ensureTerminal);
  const closeTerminal = useTerminalUiStateStore((state) => state.closeTerminal);
  const { archiveThread } = useThreadActions();
  const [filter, setFilter] = useState<RunFilter>("all");
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const runs = useMemo(() => buildAgentRuns({ projects, threads }), [projects, threads]);
  const bakeoffViews = useMemo(() => buildBakeoffViews(bakeoffs, runs), [bakeoffs, runs]);
  const bakeoffKeys = useMemo(() => bakeoffThreadKeys(bakeoffs), [bakeoffs]);
  const processRuns = useMemo(
    () => buildTerminalProcessRuns({ projects, sessions: terminalSessions, threads }),
    [projects, terminalSessions, threads],
  );
  const activeCount = runs.filter(isAgentRunActive).length + processRuns.length;
  const visibleRuns = runs.filter((run) => {
    if (bakeoffKeys.has(`${run.thread.environmentId}:${run.thread.id}`)) return false;
    if (filter === "active") return isAgentRunActive(run);
    if (filter === "recent") return !isAgentRunActive(run);
    return true;
  });
  const visibleBakeoffViews = bakeoffViews.filter((view) => {
    const hasActiveContestant = view.contestants.some(({ run }) => run && isAgentRunActive(run));
    if (filter === "active") return hasActiveContestant;
    if (filter === "recent") return !hasActiveContestant;
    return true;
  });
  const visibleProcessRuns = filter === "recent" ? [] : processRuns;
  const hasVisibleRuns =
    visibleBakeoffViews.length > 0 || visibleRuns.length > 0 || visibleProcessRuns.length > 0;
  const configByEnvironmentId = useMemo(() => {
    const configs = new Map<string, typeof primaryServerConfig>();
    if (primaryEnvironmentId && primaryServerConfig) {
      configs.set(primaryEnvironmentId, primaryServerConfig);
    }
    for (const [environmentId, runtime] of Object.entries(savedEnvironmentRuntimeById)) {
      configs.set(environmentId, runtime.serverConfig);
    }
    return configs;
  }, [primaryEnvironmentId, primaryServerConfig, savedEnvironmentRuntimeById]);

  const withPending = useCallback(async (key: string, action: () => Promise<void>) => {
    setPendingKeys((current) => new Set(current).add(key));
    try {
      await action();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Run action failed",
        description: error instanceof Error ? error.message : "The action could not be completed.",
      });
    } finally {
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const openRun = useCallback(
    (threadRef: ScopedThreadRef) =>
      navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) }),
    [navigate],
  );
  const interruptRun = useCallback(async (run: AgentRun): Promise<void> => {
    const api = readEnvironmentApi(run.thread.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: run.thread.id,
      turnId: run.thread.latestTurn?.turnId,
      createdAt: new Date().toISOString(),
    });
  }, []);
  const updateBakeoff = useCallback(
    (id: string, update: (bakeoff: Bakeoff) => Bakeoff) => {
      setBakeoffs((current) =>
        current.map((bakeoff) => (bakeoff.id === id ? update(bakeoff) : bakeoff)),
      );
    },
    [setBakeoffs],
  );
  const openProcessRun = useCallback(
    (run: TerminalProcessRun): void => {
      const threadRef = scopeThreadRef(
        run.session.target.environmentId,
        run.session.target.threadId,
      );
      ensureTerminal(threadRef, run.session.target.terminalId, { active: true, open: true });
      void openRun(threadRef);
    },
    [ensureTerminal, openRun],
  );
  const stopProcessRun = useCallback(
    async (run: TerminalProcessRun): Promise<void> => {
      const api = readEnvironmentApi(run.session.target.environmentId);
      if (!api) return;
      await api.terminal.close({
        threadId: run.session.target.threadId,
        terminalId: run.session.target.terminalId,
        deleteHistory: true,
      });
      closeTerminal(
        scopeThreadRef(run.session.target.environmentId, run.session.target.threadId),
        run.session.target.terminalId,
      );
    },
    [closeTerminal],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex min-h-7 items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <ListTodoIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Runs</span>
            {activeCount > 0 ? (
              <Badge variant="info" size="sm">
                {activeCount} active
              </Badge>
            ) : null}
            <Button
              size="xs"
              className="ml-auto"
              disabled={projects.length === 0}
              onClick={() => setCreateBakeoffOpen(true)}
            >
              <GitCompareArrowsIcon />
              New bakeoff
            </Button>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Monitor agent activity and running processes across every environment.
                </p>
              </div>
              <div className="flex rounded-lg border border-border bg-card p-0.5">
                {(["all", "active", "recent"] as const).map((value) => (
                  <Button
                    key={value}
                    size="xs"
                    variant={filter === value ? "secondary" : "ghost"}
                    className="capitalize"
                    onClick={() => setFilter(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            </div>

            {!hasVisibleRuns ? (
              <Empty className="min-h-80 rounded-2xl border border-dashed border-border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Clock3Icon />
                  </EmptyMedia>
                  <EmptyTitle>
                    {runs.length === 0 && processRuns.length === 0
                      ? "No runs yet"
                      : "No matching runs"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {runs.length === 0 && processRuns.length === 0
                      ? "Agent activity and running terminal processes will appear here."
                      : "Choose another filter to see the rest of your runs."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-6">
                {visibleBakeoffViews.length > 0 ? (
                  <section className="grid gap-3">
                    <h2 className="text-sm font-medium">Multi-agent bakeoffs</h2>
                    {visibleBakeoffViews.map((view) => (
                      <BakeoffCard
                        key={view.bakeoff.id}
                        view={view}
                        pendingKeys={pendingKeys}
                        onOpen={(run) =>
                          void openRun(scopeThreadRef(run.thread.environmentId, run.thread.id))
                        }
                        onInterrupt={(run) =>
                          void withPending(
                            `agent:${run.thread.environmentId}:${run.thread.id}`,
                            () => interruptRun(run),
                          )
                        }
                        onPickWinner={(threadId) =>
                          updateBakeoff(view.bakeoff.id, (bakeoff) => ({
                            ...bakeoff,
                            winnerThreadId: threadId,
                          }))
                        }
                        onRemove={() =>
                          setBakeoffs((current) =>
                            current.filter((bakeoff) => bakeoff.id !== view.bakeoff.id),
                          )
                        }
                      />
                    ))}
                  </section>
                ) : null}
                {visibleProcessRuns.length > 0 ? (
                  <section className="grid gap-3">
                    <h2 className="text-sm font-medium">Running processes</h2>
                    {visibleProcessRuns.map((run) => {
                      const runKey = `terminal:${run.session.target.environmentId}:${run.session.target.threadId}:${run.session.target.terminalId}`;
                      return (
                        <TerminalProcessCard
                          key={runKey}
                          run={run}
                          isPending={pendingKeys.has(runKey)}
                          onOpen={() => openProcessRun(run)}
                          onStop={() => void withPending(runKey, () => stopProcessRun(run))}
                        />
                      );
                    })}
                  </section>
                ) : null}
                {visibleRuns.length > 0 ? (
                  <section className="grid gap-3">
                    {visibleProcessRuns.length > 0 || visibleBakeoffViews.length > 0 ? (
                      <h2 className="text-sm font-medium">Agent activity</h2>
                    ) : null}
                    {visibleRuns.map((run) => {
                      const threadRef = scopeThreadRef(run.thread.environmentId, run.thread.id);
                      const runKey = `agent:${run.thread.environmentId}:${run.thread.id}`;
                      const isPending = pendingKeys.has(runKey);
                      return (
                        <RunCard
                          key={runKey}
                          run={run}
                          isPending={isPending}
                          onOpen={() => void openRun(threadRef)}
                          onInterrupt={() => void withPending(runKey, () => interruptRun(run))}
                          onArchive={() => void withPending(runKey, () => archiveThread(threadRef))}
                        />
                      );
                    })}
                  </section>
                ) : null}
              </div>
            )}
          </div>
        </main>
      </div>
      <BakeoffCreateDialog
        open={createBakeoffOpen}
        onOpenChange={setCreateBakeoffOpen}
        projects={projects}
        configByEnvironmentId={configByEnvironmentId}
        onCreated={(bakeoff) => setBakeoffs((current) => [bakeoff, ...current])}
      />
    </SidebarInset>
  );
}

function BakeoffCard(props: {
  view: BakeoffView;
  pendingKeys: ReadonlySet<string>;
  onOpen: (run: AgentRun) => void;
  onInterrupt: (run: AgentRun) => void;
  onPickWinner: (threadId: Bakeoff["winnerThreadId"]) => void;
  onRemove: () => void;
}) {
  const { bakeoff } = props.view;
  return (
    <Card className="overflow-hidden rounded-xl">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitCompareArrowsIcon className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="truncate text-sm font-semibold">{bakeoff.title}</h3>
            <Badge variant="secondary" size="sm">
              {bakeoff.contestants.length} contestants
            </Badge>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{bakeoff.prompt}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Base {bakeoff.baseBranch} · {formatRelativeTimeLabel(bakeoff.createdAt)}
          </p>
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="Remove bakeoff" onClick={props.onRemove}>
          <Trash2Icon />
        </Button>
      </div>
      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
        {props.view.contestants.map(({ contestant, run }) => {
          const isWinner = bakeoff.winnerThreadId === contestant.threadId;
          const meta = run ? STATUS_META[run.status] : null;
          const StatusIcon = meta?.icon ?? Clock3Icon;
          const pendingKey = run
            ? `agent:${run.thread.environmentId}:${run.thread.id}`
            : `agent:${bakeoff.environmentId}:${contestant.threadId}`;
          return (
            <div key={contestant.threadId} className="flex min-w-0 flex-col gap-3 bg-card p-4">
              <div className="flex min-w-0 items-start gap-2">
                <StatusIcon
                  className={
                    run?.status === "running" ? "mt-0.5 size-4 animate-pulse" : "mt-0.5 size-4"
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{contestant.label}</span>
                    {isWinner ? (
                      <Badge variant="success" size="sm">
                        Winner
                      </Badge>
                    ) : null}
                    {meta ? (
                      <Badge variant={meta.badge} size="sm">
                        {meta.label}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {run?.thread.branch ??
                      contestant.launchError ??
                      "Waiting for the contestant thread to appear…"}
                  </p>
                </div>
              </div>
              <div className="mt-auto flex flex-wrap gap-2">
                {run?.status === "running" ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={props.pendingKeys.has(pendingKey)}
                    onClick={() => props.onInterrupt(run)}
                  >
                    <CircleStopIcon />
                    Stop
                  </Button>
                ) : null}
                {run ? (
                  <Button size="xs" variant="outline" onClick={() => props.onOpen(run)}>
                    <ExternalLinkIcon />
                    Review
                  </Button>
                ) : null}
                {!isWinner && run && !isAgentRunActive(run) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => props.onPickWinner(contestant.threadId)}
                  >
                    <TrophyIcon />
                    Pick winner
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TerminalProcessCard(props: {
  run: TerminalProcessRun;
  isPending: boolean;
  onOpen: () => void;
  onStop: () => void;
}) {
  const summary = props.run.session.state.summary;
  const label = summary?.label?.trim() || props.run.session.target.terminalId;
  const updatedAt = props.run.session.state.updatedAt;

  return (
    <Card className="rounded-xl">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
            <SquareTerminalIcon className="size-4 animate-pulse" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="truncate text-left text-sm font-medium hover:underline"
                onClick={props.onOpen}
              >
                {label}
              </button>
              <Badge variant="info" size="sm">
                Process running
              </Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {props.run.project?.name ?? "Unknown project"}
              {props.run.thread ? ` · ${props.run.thread.title}` : ""}
              {summary?.cwd ? ` · ${summary.cwd}` : ""}
              {updatedAt ? ` · ${formatRelativeTimeLabel(updatedAt)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={props.isPending}
            onClick={props.onStop}
          >
            <CircleStopIcon />
            Stop
          </Button>
          <Button size="xs" variant="outline" onClick={props.onOpen}>
            <ExternalLinkIcon />
            Open terminal
          </Button>
        </div>
      </div>
    </Card>
  );
}

function RunCard(props: {
  run: AgentRun;
  isPending: boolean;
  onOpen: () => void;
  onInterrupt: () => void;
  onArchive: () => void;
}) {
  const { run } = props;
  const meta = STATUS_META[run.status];
  const StatusIcon = meta.icon;
  const isActive = isAgentRunActive(run);
  const canInterrupt = run.status === "running";

  return (
    <Card className="rounded-xl">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
            <StatusIcon className={run.status === "running" ? "size-4 animate-pulse" : "size-4"} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="truncate text-left text-sm font-medium hover:underline"
                onClick={props.onOpen}
              >
                {run.thread.title}
              </button>
              <Badge variant={meta.badge} size="sm">
                {meta.label}
              </Badge>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {run.project?.name ?? "Unknown project"}
              {run.thread.branch ? ` · ${run.thread.branch}` : ""}
              {` · ${formatRelativeTimeLabel(run.statusAt)}`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {canInterrupt ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={props.isPending}
              onClick={props.onInterrupt}
            >
              <CircleStopIcon />
              Stop
            </Button>
          ) : null}
          {!isActive && run.thread.archivedAt === null ? (
            <Button
              size="xs"
              variant="outline"
              disabled={props.isPending}
              onClick={props.onArchive}
            >
              <ArchiveIcon />
              Archive
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={props.onOpen}>
            <ExternalLinkIcon />
            Open
          </Button>
        </div>
      </div>
    </Card>
  );
}
