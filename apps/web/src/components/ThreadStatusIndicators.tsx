import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@forma/client-runtime";
import type { GitStatusResult } from "@forma/contracts";
import {
  CheckCheckIcon,
  CircleAlertIcon,
  CircleQuestionMarkIcon,
  CloudIcon,
  FileTextIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useGitStatus } from "../lib/gitStatusState";
import { cn } from "../lib/utils";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { PixelGridLoader } from "./ui/pixel-grid-loader";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  icon: LucideIcon;
  toneClass: string;
  tooltip: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  toneClass: string;
  pulse: boolean;
}

export type ThreadPr = GitStatusResult["pr"];

const THREAD_STATUS_ICON_BY_GLYPH: Record<
  Exclude<ThreadStatusPill["glyph"], "grid">,
  LucideIcon
> = {
  "circle-alert": CircleAlertIcon,
  "circle-question-mark": CircleQuestionMarkIcon,
  "file-text": FileTextIcon,
  "check-check": CheckCheckIcon,
};

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      icon: GitPullRequestIcon,
      toneClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      icon: GitPullRequestClosedIcon,
      toneClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      icon: GitMergeIcon,
      toneClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
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
    toneClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function getSidebarIndicatorClassName(input: {
  toneClass: string;
  className?: string | undefined;
}) {
  return cn(
    "inline-flex size-4 shrink-0 items-center justify-center",
    input.toneClass,
    input.className,
  );
}

export function SidebarStatusGlyph({
  status,
  compact = false,
  className,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        compact ? "size-3.5" : "size-3",
        className,
      )}
      data-slot="sidebar-status-glyph"
      data-status-glyph={status.glyph}
    >
      {status.glyph === "grid" ? (
        <PixelGridLoader variant="sidebar" className="text-current" />
      ) : (
        (() => {
          const Icon = THREAD_STATUS_ICON_BY_GLYPH[status.glyph];
          return <Icon className="size-3" strokeWidth={2.25} />;
        })()
      )}
    </span>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
  className,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={getSidebarIndicatorClassName({
          toneClass: status.toneClass,
          className,
        })}
      >
        <SidebarStatusGlyph compact status={status} />
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span title={status.label} className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        className={getSidebarIndicatorClassName({
          toneClass: status.toneClass,
        })}
      >
        <SidebarStatusGlyph status={status} />
      </span>
      <span
        className={cn("text-ui-2xs hidden font-medium tracking-tight md:inline", status.toneClass)}
      >
        {status.label}
      </span>
    </span>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the PR state icon (if present) and the
 * thread status glyph, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({
  thread,
  compact = false,
}: {
  thread: SidebarThreadSummary;
  compact?: boolean;
}) {
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
    <span className={cn("inline-flex shrink-0 items-center", compact ? "gap-1" : "gap-1.5")}>
      {prStatus
        ? (() => {
            const PrIcon = prStatus.icon;

            return (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      aria-label={prStatus.tooltip}
                      className={getSidebarIndicatorClassName({
                        toneClass: prStatus.toneClass,
                      })}
                    />
                  }
                >
                  <PrIcon className="size-3" strokeWidth={2.25} />
                </TooltipTrigger>
                <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
              </Tooltip>
            );
          })()
        : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} compact={compact} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
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

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <span
          role="img"
          aria-label={terminalStatus.label}
          title={terminalStatus.label}
          className={getSidebarIndicatorClassName({
            toneClass: terminalStatus.toneClass,
          })}
        >
          <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
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
            <CloudIcon className="size-3 text-muted-foreground/60" strokeWidth={2.25} />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
