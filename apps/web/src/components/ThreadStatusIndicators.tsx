import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import {
  IconCloud as CloudIcon,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconGitPullRequestConflict,
  IconGitPullRequestDraft,
  IconTerminal2 as TerminalIcon,
} from "@tabler/icons-react";
import { type MouseEvent as ReactMouseEvent, type ReactElement, useMemo } from "react";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useVcsStatus } from "../lib/vcsStatusState";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { useThreadRunningTerminalIds } from "../terminalSessionState";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export type PrStatusIcon = "open" | "draft" | "conflict" | "closed" | "merged";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
  icon: PrStatusIcon;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);
  const titleSuffix = `#${pr.number} ${presentation.shortName}`;

  if (pr.state === "open") {
    // Conflicts are the most urgent signal, then draft status, then a plain
    // open PR. We surface conflict/draft state regardless of provider so the
    // worktree-level icon stays informative.
    if (pr.hasConflicts) {
      return {
        label: `${presentation.shortName} has conflicts`,
        colorClass: "text-red-600 dark:text-red-400/90",
        tooltip: `${titleSuffix} has merge conflicts: ${pr.title}`,
        url: pr.url,
        icon: "conflict",
      };
    }
    if (pr.isDraft) {
      return {
        label: `${presentation.shortName} draft`,
        colorClass: "text-zinc-500 dark:text-zinc-400/80",
        tooltip: `${titleSuffix} draft: ${pr.title}`,
        url: pr.url,
        icon: "draft",
      };
    }
    return {
      label: `${presentation.shortName} open`,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `${titleSuffix} open: ${pr.title}`,
      url: pr.url,
      icon: "open",
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-red-600 dark:text-red-400/90",
      tooltip: `${titleSuffix} closed: ${pr.title}`,
      url: pr.url,
      icon: "closed",
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `${titleSuffix} merged: ${pr.title}`,
      url: pr.url,
      icon: "merged",
    };
  }
  return null;
}

const PR_STATUS_ICON_BY_KIND: Record<
  PrStatusIcon,
  (props: { className?: string | undefined }) => ReactElement
> = {
  open: (props) => <IconGitPullRequest {...props} />,
  draft: (props) => <IconGitPullRequestDraft {...props} />,
  conflict: (props) => <IconGitPullRequestConflict {...props} />,
  closed: (props) => <IconGitPullRequestClosed {...props} />,
  merged: (props) => <IconGitMerge {...props} />,
};

export function ChangeRequestStatusIcon({
  className,
  icon = "open",
}: {
  className?: string;
  icon?: PrStatusIcon;
}) {
  return PR_STATUS_ICON_BY_KIND[icon]({ className });
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
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

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span
        title={status.label}
        className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
      >
        <span
          className={`size-[9px] rounded-full ${status.dotClass} ${
            status.pulse ? "animate-pulse" : ""
          }`}
        />
        <span className="sr-only">{status.label}</span>
      </span>
    );
  }

  return (
    <span
      title={status.label}
      className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
          status.pulse ? "animate-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{status.label}</span>
    </span>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
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
  const gitStatus = useVcsStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
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
            <ChangeRequestStatusIcon className="size-3" icon={prStatus.icon} />
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Worktree-level PR status icon shown to the left of a worktree group label in
 * the sidebar. PR status is resolved once per worktree (all threads in a group
 * share the same branch/worktree) rather than per thread. Clicking opens the PR.
 */
export function SidebarWorktreePrStatus({
  environmentId,
  branch,
  worktreePath,
  projectCwd,
  onOpenPr,
}: {
  environmentId: EnvironmentId;
  branch: string | null;
  worktreePath: string | null;
  projectCwd: string | null;
  onOpenPr: (event: ReactMouseEvent<HTMLElement>, prUrl: string) => void;
}) {
  const gitCwd = worktreePath ?? projectCwd;
  const gitStatus = useVcsStatus({
    environmentId,
    cwd: branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);

  if (!prStatus) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={prStatus.tooltip}
            className={`inline-flex size-4 shrink-0 items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenPr(event, prStatus.url);
            }}
          >
            <ChangeRequestStatusIcon className="size-3" icon={prStatus.icon} />
          </button>
        }
      />
      <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
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
          className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
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
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
