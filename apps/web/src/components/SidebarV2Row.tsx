import {
  ArchiveIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  Clock3Icon,
  GitBranchIcon,
  InboxIcon,
  PinIcon,
  RotateCcwIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { type CSSProperties, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { useSortable } from "@dnd-kit/sortable";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { threadRaisedHandWhileSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useGitStatus } from "../lib/gitStatusState";
import { sanitizeThreadErrorMessage } from "../rpc/transportError";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import type { ProviderInstanceEntry } from "../providerInstances";
import { type AppState, selectLatestTurnDiffSummaryByRef, useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "~/lib/utils";
import { hasUnseenCompletion, resolveThreadStatusPill } from "./Sidebar.logic";
import {
  compactSidebarTimeLabel,
  formatWorkingDurationLabel,
  latestTurnDiffStats,
  resolveSidebarV2Status,
  resolveSidebarV2StatusLabel,
  resolveWorkingStartedAt,
} from "./SidebarV2.logic";
import { getSidebarThreadPrewarmKey } from "./SidebarThreadPrewarmer";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  ThreadStatusLabel,
  prStatusIndicator,
  resolveTerminalThreadRef,
  resolveThreadPr,
  terminalStatusFromRunningIds,
} from "./ThreadStatusIndicators";
import { Button } from "./ui/button";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface SidebarV2RowProps {
  readonly thread: SidebarThreadSummary;
  readonly projectName: string;
  readonly projectCwd: string | null;
  /** Card rows carry the full three-line layout; snoozed and settled shelves
      stay on the single-line variant so history stays scannable. */
  readonly variant: "card" | "slim";
  readonly active: boolean;
  readonly pinned: boolean;
  readonly snoozed: boolean;
  readonly settled: boolean;
  // Resolved by the parent against its clock so a ticking `now` never reaches
  // row props and defeats memoization.
  readonly settleBlocked: boolean;
  readonly snoozeBlocked: boolean;
  // False on environments whose server predates thread.settle/unsettle. The
  // affordance hides entirely rather than failing on click, so one stale
  // environment degrades only its own rows.
  readonly settlementSupported: boolean;
  // Same contract for thread.snooze/unsnooze.
  readonly snoozeSupported: boolean;
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly onDismissAgentRun: (thread: SidebarThreadSummary) => void;
  readonly onOpen: (thread: SidebarThreadSummary) => void;
  readonly onSetPinned: (thread: SidebarThreadSummary, pinned: boolean) => void;
  readonly onSettle: (thread: SidebarThreadSummary) => void;
  readonly onUnsettle: (thread: SidebarThreadSummary) => void;
  readonly onSnooze: (thread: SidebarThreadSummary, until: string) => void;
  readonly onUnsnooze: (thread: SidebarThreadSummary) => void;
  readonly sortable?: {
    readonly attributes: ReturnType<typeof useSortable>["attributes"];
    readonly isDragging: boolean;
    readonly listeners: ReturnType<typeof useSortable>["listeners"];
    readonly setNodeRef: ReturnType<typeof useSortable>["setNodeRef"];
    readonly style: CSSProperties;
  };
}

function fourHoursFromNow(): string {
  return new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString();
}

function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

// Self-ticking so only this span re-renders each second, not the whole row.
function WorkingDuration({ startedAt }: { readonly startedAt: string | null }) {
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
}

function ThreadDetailsTooltip({
  thread,
  projectName,
  projectCwd,
  environmentLabel,
  providerEntry,
  terminalProcessCount,
}: {
  readonly thread: SidebarThreadSummary;
  readonly projectName: string;
  readonly projectCwd: string | null;
  readonly environmentLabel: string | null;
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? thread.session?.provider ?? null;
  // Transport drops are connection noise, not a thread failure; the same
  // sanitizer the chat surface uses keeps them out of the tooltip.
  const sessionError = sanitizeThreadErrorMessage(thread.session?.lastError);
  return (
    <TooltipPopup align="start" className="max-w-80 whitespace-normal text-left" side="right">
      <div className="flex min-w-0 max-w-80 flex-col gap-2 px-0.5 py-1.5">
        <div className="min-w-0 truncate text-xs font-medium leading-none text-foreground">
          {thread.title}
        </div>
        <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <ProjectFavicon
              className="size-3 shrink-0"
              cwd={projectCwd ?? ""}
              environmentId={thread.environmentId}
            />
            <div className="min-w-0 truncate text-foreground/75">{projectName}</div>
          </div>
          {projectCwd ? (
            <div className="min-w-0 truncate pl-5 text-foreground/60">
              {thread.worktreePath ?? projectCwd}
            </div>
          ) : null}
          {environmentLabel ? (
            <div className="flex min-w-0 items-center gap-2">
              <ServerIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
            </div>
          ) : null}
          {thread.branch ? (
            <div className="flex min-w-0 items-center gap-2">
              <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">{thread.branch}</div>
            </div>
          ) : null}
          {driverKind ? (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderInstanceIcon
                displayName={providerEntry?.displayName ?? driverKind}
                driverKind={driverKind}
                iconClassName="size-3 shrink-0 grayscale opacity-60"
              />
              <div className="min-w-0 truncate text-foreground/75">
                {providerEntry?.displayName ?? driverKind}
              </div>
            </div>
          ) : null}
          {terminalProcessCount > 0 ? (
            <div className="flex min-w-0 items-center gap-2">
              <TerminalIcon className="size-3 shrink-0 stroke-muted-foreground" />
              <div className="min-w-0 truncate text-foreground/75">
                {terminalProcessLabel(terminalProcessCount)}
              </div>
            </div>
          ) : null}
          {sessionError ? (
            <div className="flex min-w-0 items-start gap-2 text-red-600 dark:text-red-400">
              <CircleAlertIcon className="mt-0.5 size-3 shrink-0 stroke-current" />
              <div className="min-w-0 flex-1 wrap-break-word">{sessionError}</div>
            </div>
          ) : null}
        </div>
      </div>
    </TooltipPopup>
  );
}

export const SidebarV2Row = memo(function SidebarV2Row({
  thread,
  projectName,
  projectCwd,
  variant,
  active,
  pinned,
  snoozed,
  settled,
  settleBlocked,
  snoozeBlocked,
  settlementSupported,
  snoozeSupported,
  providerEntry,
  onDismissAgentRun,
  onOpen,
  onSetPinned,
  onSettle,
  onUnsettle,
  onSnooze,
  onUnsnooze,
  sortable,
}: SidebarV2RowProps) {
  const prewarmThreadKey = getSidebarThreadPrewarmKey(thread);
  const raisedHand = threadRaisedHandWhileSnoozed(thread);
  const lastVisitedAt = useUiStateStore(
    (state) =>
      state.threadLastVisitedAtById[
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
      ],
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemote = primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteRuntimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const remoteSavedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  const environmentLabel = isRemote ? (remoteRuntimeLabel ?? remoteSavedLabel ?? "Remote") : null;

  const terminalRef = resolveTerminalThreadRef(thread);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, terminalRef).runningTerminalIds,
  );
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  const gitCwd = thread.worktreePath ?? projectCwd;
  // Gated on the branch, not the worktree: resolveThreadPr yields null without
  // one, so a branchless worktree row would pay for a status query it can
  // never render.
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch !== null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr);

  const latestTurnDiff = useStore(
    useMemo(
      () => (state: AppState) =>
        selectLatestTurnDiffSummaryByRef(state, scopeThreadRef(thread.environmentId, thread.id)),
      [thread.environmentId, thread.id],
    ),
  );
  const diff = useMemo(() => latestTurnDiffStats(latestTurnDiff), [latestTurnDiff]);

  const status = resolveSidebarV2Status(thread);
  const statusLabel = resolveSidebarV2StatusLabel({
    status,
    unseenCompletion: hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
  const pill = resolveThreadStatusPill({ thread });

  const handleOpen = useCallback(() => onOpen(thread), [onOpen, thread]);
  const agentRun = thread.virtualAgentRun;
  const isVirtualAgentRun = agentRun !== undefined;
  const dismissibleAgentRun = agentRun !== undefined && agentRun.status !== "running";
  const handleDismissAgentRun = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (dismissibleAgentRun) {
        onDismissAgentRun(thread);
      }
    },
    [dismissibleAgentRun, onDismissAgentRun, thread],
  );
  const handleSnooze = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onSnooze(thread, fourHoursFromNow());
    },
    [onSnooze, thread],
  );
  const handleUnsnooze = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onUnsnooze(thread);
    },
    [onUnsnooze, thread],
  );
  const handleSettleToggle = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (settled) {
        onUnsettle(thread);
      } else {
        onSettle(thread);
      }
    },
    [onSettle, onUnsettle, settled, thread],
  );
  const handlePinnedToggle = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onSetPinned(thread, !pinned);
    },
    [onSetPinned, pinned, thread],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (prStatus) openPullRequestLink(event, prStatus.url);
    },
    [prStatus],
  );

  // A role="button" div is not natively activatable, so the card surface
  // restores keyboard activation itself — and only for its own key events, so
  // Enter on the nested PR badge does not also open the thread.
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onOpen(thread);
    },
    [onOpen, thread],
  );

  const hoverActions = (
    <div className="absolute right-2 top-1.5 hidden items-center gap-0.5 group-hover/thread:flex group-focus-within/thread:flex">
      {!isVirtualAgentRun ? (
        <Button
          aria-label={`${pinned ? "Unpin" : "Pin"} ${thread.title}`}
          aria-pressed={pinned}
          onClick={handlePinnedToggle}
          size="icon-xs"
          title={pinned ? "Unpin thread" : "Pin thread"}
          variant="ghost"
        >
          <PinIcon className={pinned ? "fill-current" : undefined} />
        </Button>
      ) : null}
      {dismissibleAgentRun ? (
        <Button
          aria-label={`Archive ${thread.title}`}
          onClick={handleDismissAgentRun}
          size="icon-xs"
          title="Archive run"
          variant="ghost"
        >
          <ArchiveIcon />
        </Button>
      ) : isVirtualAgentRun ? null : snoozed ? (
        snoozeSupported ? (
          <Button
            aria-label={`Wake ${thread.title}`}
            onClick={handleUnsnooze}
            size="icon-xs"
            title="Wake now"
            variant="ghost"
          >
            <RotateCcwIcon />
          </Button>
        ) : null
      ) : (
        <>
          {snoozeSupported ? (
            <Button
              aria-label={`Snooze ${thread.title} for four hours`}
              disabled={snoozeBlocked}
              onClick={handleSnooze}
              size="icon-xs"
              title={
                snoozeBlocked ? "Cannot snooze work that is waiting on you" : "Snooze for 4 hours"
              }
              variant="ghost"
            >
              <Clock3Icon />
            </Button>
          ) : null}
          {settlementSupported ? (
            <Button
              aria-label={settled ? `Reopen ${thread.title}` : `Settle ${thread.title}`}
              disabled={settleBlocked}
              onClick={handleSettleToggle}
              size="icon-xs"
              title={
                settled
                  ? "Reopen thread"
                  : settleBlocked
                    ? "Cannot settle a thread with active or pending work"
                    : "Settle thread"
              }
              variant="ghost"
            >
              {settled ? <RotateCcwIcon /> : <CheckCircle2Icon />}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );

  const terminalIcon = terminalStatus ? (
    <span
      aria-label={terminalProcessLabel(runningTerminalIds.length)}
      className={cn("inline-flex shrink-0 items-center gap-0.5", terminalStatus.colorClass)}
      role="img"
    >
      <TerminalIcon className={cn("size-3", terminalStatus.pulse && "animate-status-pulse")} />
      {runningTerminalIds.length > 1 ? (
        <span className="tabular-nums">{runningTerminalIds.length}</span>
      ) : null}
    </span>
  ) : null;

  // Branch, terminals, PR, diff and the remote marker share the third line;
  // with none of them the line is pure blank height.
  const hasMetadataLine =
    thread.branch !== null ||
    terminalIcon !== null ||
    prStatus !== null ||
    diff !== null ||
    isRemote;

  const tooltip = (
    <ThreadDetailsTooltip
      environmentLabel={environmentLabel}
      projectCwd={projectCwd}
      projectName={projectName}
      providerEntry={providerEntry}
      terminalProcessCount={runningTerminalIds.length}
      thread={thread}
    />
  );

  if (variant === "slim") {
    return (
      <SidebarMenuItem className="group/thread" data-thread-prewarm-key={prewarmThreadKey}>
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                className="h-auto min-h-0 items-start px-2 py-1 text-[length:var(--app-sidebar-font-size)]"
                isActive={active}
                onClick={handleOpen}
              />
            }
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
              <span className="flex min-w-0 items-center gap-1.5">
                {pill ? (
                  <ThreadStatusLabel compact status={pill} />
                ) : (
                  <InboxIcon className="size-3.5 shrink-0" />
                )}
                <span className="truncate font-medium">{thread.title}</span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-sidebar-meta-font-size)] text-muted-foreground">
                <span className="truncate">{projectName}</span>
                <span className="shrink-0 tabular-nums">
                  {compactSidebarTimeLabel(
                    formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt),
                  )}
                </span>
                {snoozed && thread.snoozedUntil ? (
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {formatRelativeTimeUntilLabel(thread.snoozedUntil)}
                  </span>
                ) : null}
                {raisedHand ? (
                  <span className="ml-auto shrink-0 text-amber-600">Needs attention</span>
                ) : null}
              </span>
            </span>
          </TooltipTrigger>
          {tooltip}
        </Tooltip>
        {hoverActions}
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      {...sortable?.attributes}
      {...sortable?.listeners}
      className={cn(
        "group/thread [contain-intrinsic-size:auto_3.5rem] [content-visibility:auto]",
        sortable?.isDragging && "z-20 opacity-80",
      )}
      data-thread-prewarm-key={prewarmThreadKey}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              // Height is padding-driven rather than fixed so the row tracks
              // the UI density scale and the sidebar font-size setting instead
              // of locking every user to one hard-coded card height.
              className="h-auto min-h-0 items-stretch gap-0 px-2 py-1 text-[length:var(--app-sidebar-font-size)]"
              isActive={active}
              onClick={handleOpen}
              onKeyDown={handleRowKeyDown}
              // A native <button> may not contain focusable descendants, and
              // the card's PR badge is its own control. Rendering the surface
              // as a role="button" div keeps both as independent focus targets.
              render={<div role="button" tabIndex={0} />}
            />
          }
        >
          {/* One wrapper child: SidebarMenuButton truncates its LAST direct
              child, which would clip the metadata line's flex row. */}
          <span className="flex w-full min-w-0 flex-col justify-center gap-0.5 leading-tight">
            <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-sidebar-meta-font-size)]">
              <ProjectFavicon
                className="size-3.5 shrink-0"
                cwd={projectCwd ?? ""}
                environmentId={thread.environmentId}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground/85">
                {projectName}
              </span>
              {/* Status at rest, settle/snooze on hover: the label fades rather
                than unmounting so the header line never reflows. */}
              <span className="ml-auto shrink-0 transition-opacity group-hover/thread:opacity-0 group-focus-within/thread:opacity-0">
                {statusLabel ? (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 font-medium",
                      statusLabel.className,
                    )}
                  >
                    <span role="status">{statusLabel.label}</span>
                    {statusLabel.showElapsed ? (
                      <span aria-hidden="true">
                        <WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="tabular-nums text-muted-foreground/65">
                    {compactSidebarTimeLabel(
                      formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt),
                    )}
                  </span>
                )}
              </span>
            </span>
            <span className="flex min-w-0">
              <span className="min-w-0 flex-1 truncate font-medium">{thread.title}</span>
            </span>
            {/* The metadata line earns its row only when it has something to
                say: a branchless thread with no PR, diff or terminal would
                otherwise reserve blank height on every card. */}
            {hasMetadataLine ? (
              <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-sidebar-meta-font-size)] text-muted-foreground/75">
                {thread.branch ? (
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap">{thread.branch}</span>
                ) : (
                  <span className="flex-1" />
                )}
                {terminalIcon}
                {prStatus && pr ? (
                  <button
                    aria-label={prStatus.tooltip}
                    className={cn(
                      "shrink-0 cursor-pointer font-mono hover:underline",
                      prStatus.colorClass,
                    )}
                    onClick={handlePrClick}
                    type="button"
                  >
                    #{pr.number}
                  </button>
                ) : null}
                {diff ? (
                  <span className="shrink-0 font-mono tabular-nums">
                    <span className="text-emerald-600 dark:text-emerald-400">
                      +{diff.insertions}
                    </span>{" "}
                    <span className="text-red-600 dark:text-red-400">-{diff.deletions}</span>
                  </span>
                ) : null}
                {isRemote ? (
                  <ServerIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
                ) : null}
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        {tooltip}
      </Tooltip>
      {hoverActions}
    </SidebarMenuItem>
  );
});
