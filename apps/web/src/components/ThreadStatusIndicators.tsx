import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { GitStatusResult, ThreadId } from "@t3tools/contracts";
import {
  AppWindowIcon,
  CheckIcon,
  CloudIcon,
  GitPullRequestIcon,
  PlayIcon,
  TerminalIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useGitStatus } from "../lib/gitStatusState";
import { cn } from "../lib/utils";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadBrowserOpen } from "../rightPanelStore";
import { useUiStateStore } from "../uiStateStore";
import { formatWorkingDurationLabel, resolveWorkingStartedAt } from "./SidebarV2.logic";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** Static glyph nodes — avoid re-allocating Lucide elements on every row render. */
const WORKING_BADGE_ICON = (
  <span
    aria-hidden="true"
    className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white dark:bg-sky-400"
  >
    <PlayIcon className="size-2 fill-current" />
  </span>
);

const DONE_BADGE_ICON = (
  <span
    aria-hidden="true"
    className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white dark:bg-emerald-400"
  >
    <CheckIcon className="size-2.5 stroke-[3]" />
  </span>
);

// Self-ticking so only this span re-renders each second, not the whole row.
const WorkingDuration = memo(function WorkingDuration({
  startedAt,
}: {
  readonly startedAt: string | null;
}) {
  const startedMs = startedAt !== null ? Date.parse(startedAt) : Number.NaN;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (Number.isNaN(startedMs)) return undefined;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [startedMs]);
  if (Number.isNaN(startedMs)) return null;
  return (
    <span className="font-mono tabular-nums">
      {formatWorkingDurationLabel(Date.now() - startedMs)}
    </span>
  );
});

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
  number: number;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface BrowserStatusIndicator {
  label: "Browser open";
  colorClass: string;
}

export function browserStatusIndicator(isOpen: boolean): BrowserStatusIndicator | null {
  if (!isOpen) return null;
  return {
    label: "Browser open",
    colorClass: "text-sky-600 dark:text-sky-300/90",
  };
}

export type ThreadPr = GitStatusResult["pr"];

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
      number: pr.number,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
      number: pr.number,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
      number: pr.number,
    };
  }
  return null;
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: GitStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.branch !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function resolveTerminalThreadRef(thread: SidebarThreadSummary) {
  return scopeThreadRef(thread.environmentId, thread.virtualAgentRun?.parentThreadId ?? thread.id);
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  // Corner badges own the full row treatment; compact contexts still need a
  // quiet marker so rolled-up "show more" / palette rows stay scannable.
  if (compact || status.presentation === "dot" || status.presentation === "corner-badge") {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        <span
          className={`${compact ? "size-[7px]" : "size-[5px]"} rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 ${status.colorClass}`}
      style={{ fontSize: "var(--app-sidebar-font-size)" }}
    >
      <span
        className={`size-[5px] rounded-full ${status.dotClass} ${
          status.pulse ? "animate-status-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{status.label}</span>
    </span>
  );
}

/**
 * Top-right Working/Done badge for sidebar v1 rows. Opacity-only CSS pulse on
 * Working (3s); Done stays static. Duration ticks in an isolated child so the
 * parent row does not re-render every second.
 */
export const ThreadStatusCornerBadge = memo(function ThreadStatusCornerBadge({
  status,
  thread,
}: {
  readonly status: ThreadStatusPill;
  readonly thread: Pick<SidebarThreadSummary, "latestTurn" | "session" | "createdAt">;
}) {
  if (status.presentation !== "corner-badge") {
    return null;
  }

  const isWorking = status.label === "Working";
  const label = isWorking ? "Working" : "Done";

  return (
    <span
      role="status"
      aria-label={status.label}
      title={status.label}
      data-status-corner-badge=""
      // Paint-contain the animated node so native vibrancy rows don't ghost
      // neighboring pixels when opacity pulses (see scars.md).
      className={cn(
        "pointer-events-none absolute top-1 right-1 z-[1] inline-flex items-center gap-1 font-medium",
        "[contain:paint] [transform:translateZ(0)]",
        status.colorClass,
        isWorking && "animate-status-badge-pulse motion-reduce:animate-none",
      )}
      style={{ fontSize: "var(--app-sidebar-meta-font-size)" }}
    >
      <span aria-hidden="true" className="inline-flex items-center gap-1">
        {isWorking ? WORKING_BADGE_ICON : DONE_BADGE_ICON}
        <span>{label}</span>
        {isWorking ? <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} /> : null}
      </span>
    </span>
  );
});

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the PR state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!prStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <GitPullRequestIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
/**
 * Browser-open marker shown after a sidebar thread title. Uses the thread's own
 * right-panel state (not the terminal parent override) so nested chats keep an
 * independent browser indicator.
 */
export function ThreadBrowserOpenStatus({
  environmentId,
  threadId,
}: {
  environmentId: SidebarThreadSummary["environmentId"];
  threadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const browserOpen = useThreadBrowserOpen(threadRef);
  const browserStatus = browserStatusIndicator(browserOpen);

  if (!browserStatus) {
    return null;
  }

  return (
    <span
      role="img"
      aria-label={browserStatus.label}
      title={browserStatus.label}
      className={`inline-flex shrink-0 items-center justify-center ${browserStatus.colorClass}`}
    >
      <AppWindowIcon className="size-3" />
    </span>
  );
}

export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = resolveTerminalThreadRef(thread);
  const browserThreadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const browserOpen = useThreadBrowserOpen(browserThreadRef);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteEnvSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? remoteEnvSavedLabel ?? "Remote")
    : null;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const browserStatus = browserStatusIndicator(browserOpen);

  if (!terminalStatus && !browserStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {browserStatus ? (
        <span
          role="img"
          aria-label={browserStatus.label}
          title={browserStatus.label}
          className={`inline-flex items-center justify-center ${browserStatus.colorClass}`}
        >
          <AppWindowIcon className="size-3" />
        </span>
      ) : null}
      {terminalStatus ? (
        <span
          role="img"
          aria-label={terminalStatus.label}
          title={terminalStatus.label}
          className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
        >
          <TerminalIcon
            className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
          />
        </span>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
