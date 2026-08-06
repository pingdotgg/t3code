import {
  ArchiveIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Clock3Icon,
  InboxIcon,
  PinIcon,
  RotateCcwIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { type CSSProperties, memo, useCallback, useEffect, useState } from "react";
import type { useSortable } from "@dnd-kit/sortable";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import { threadRaisedHandWhileSnoozed } from "@t3tools/client-runtime/state/thread-settled";

import { useGitStatus } from "../lib/gitStatusState";
import { openPullRequestLink } from "../lib/openPullRequestLink";
import type { ProviderInstanceEntry } from "../providerInstances";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "~/lib/utils";
import { hasUnseenCompletion, resolveThreadStatusPill } from "./Sidebar.logic";
import {
  compactSidebarTimeLabel,
  formatWorkingDurationLabel,
  resolveSidebarV2StatusLabel,
  resolveWorkingStartedAt,
  type SidebarV2Status,
} from "./SidebarV2.logic";
import { getSidebarThreadPrewarmKey } from "./SidebarThreadPrewarmer";
import { ProjectFavicon } from "./ProjectFavicon";
import {
  ThreadDetailsTooltip,
  terminalProcessLabel,
  useThreadEnvironmentLabel,
} from "./SidebarV2ThreadTooltip";
import {
  ThreadBrowserOpenStatus,
  ThreadStatusLabel,
  prStatusIndicator,
  resolveTerminalThreadRef,
  resolveThreadPr,
  terminalStatusFromRunningIds,
} from "./ThreadStatusIndicators";
import { Button } from "./ui/button";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

// Lifts the selected row off the sidebar surface. Kept as a plain shadow
// rather than a ring because the row already spends `ring` on focus-visible,
// and the dark variant needs its own value since a black shadow all but
// disappears against a dark sidebar.
//
// This lives on the menu *item* rather than the button inside it: card rows set
// `content-visibility:auto`, which implies paint containment and clips any
// descendant's outward shadow to the item's box. An element's own shadow is not
// clipped by its own containment, so the wrapper is the only surface that can
// render it. `rounded-lg` matches the button so the shadow traces the card.
const ACTIVE_ROW_ELEVATION =
  "rounded-lg shadow-[0_2px_5px_--theme(--color-black/12%)] dark:shadow-[0_2px_5px_--theme(--color-black/55%)]";

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
  /** Rolled up across the subtree while collapsed, so a parent never hides a
      nested chat's live work behind its own resting state. */
  readonly displayStatus: SidebarV2Status;
  readonly hasChildren: boolean;
  readonly isExpanded: boolean;
  readonly childCount: number;
  readonly onToggleExpanded: (thread: SidebarThreadSummary, isExpanded: boolean) => void;
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
    /** Omitted when a parent group surface owns the drag transform. */
    readonly style?: CSSProperties;
  };
}

function fourHoursFromNow(): string {
  return new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString();
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
  displayStatus,
  hasChildren,
  isExpanded,
  childCount,
  onToggleExpanded,
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
  const { isRemote, environmentLabel } = useThreadEnvironmentLabel(thread);

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

  const statusLabel = resolveSidebarV2StatusLabel({
    status: displayStatus,
    unseenCompletion: hasUnseenCompletion({ ...thread, lastVisitedAt }),
  });
  const pill = resolveThreadStatusPill({ thread });

  const handleOpen = useCallback(() => onOpen(thread), [onOpen, thread]);
  const handleToggleExpanded = useCallback(
    (event: React.SyntheticEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onToggleExpanded(thread, isExpanded);
    },
    [isExpanded, onToggleExpanded, thread],
  );
  const handleToggleExpandedPointerDown = useCallback((event: React.PointerEvent) => {
    event.stopPropagation();
  }, []);
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
    <div className="absolute right-2 top-2 hidden items-center gap-0.5 group-hover/thread:flex group-focus-within/thread:flex [&>button]:transition-none">
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

  // Branch, terminals, PR and the remote marker share the third line; with
  // none of them the line is pure blank height.
  const hasMetadataLine =
    thread.branch !== null || terminalIcon !== null || prStatus !== null || isRemote;

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

  // Native button so keyboard users can expand/collapse without opening the
  // thread. The card surface is a role="button" div (not a <button>) specifically
  // so this control and the PR badge can be independent focus targets.
  const expandToggle = hasChildren ? (
    <button
      aria-expanded={isExpanded}
      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${thread.title}`}
      className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      onClick={handleToggleExpanded}
      onPointerDown={handleToggleExpandedPointerDown}
      title={`${isExpanded ? "Collapse" : "Expand"} ${childCount} nested chat${
        childCount === 1 ? "" : "s"
      }`}
      type="button"
    >
      <ChevronRightIcon
        className={cn("size-3 transition-transform duration-150", isExpanded && "rotate-90")}
      />
    </button>
  ) : null;

  if (variant === "slim") {
    return (
      <SidebarMenuItem
        className={cn("group/thread", active && ACTIVE_ROW_ELEVATION)}
        data-thread-prewarm-key={prewarmThreadKey}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuButton
                className="h-auto min-h-0 items-start px-2.5 py-[calc(var(--app-sidebar-row-padding-y)*0.75)] text-[length:var(--app-sidebar-font-size)] transition-none"
                isActive={active}
                onClick={handleOpen}
                onKeyDown={handleRowKeyDown}
                // Same reason as the card variant: the expand chevron is its
                // own control and may not be nested inside a native <button>.
                render={<div role="button" tabIndex={0} />}
              />
            }
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
              <span className="flex min-w-0 items-center gap-1.5">
                {expandToggle}
                {pill ? (
                  <ThreadStatusLabel compact status={pill} />
                ) : (
                  <InboxIcon className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-[length:var(--app-sidebar-title-font-size)] font-medium text-foreground">
                  {thread.title}
                </span>
                <ThreadBrowserOpenStatus
                  environmentId={thread.environmentId}
                  threadId={thread.id}
                />
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-sidebar-meta-font-size)] font-normal text-muted-foreground">
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
        "group/thread [contain-intrinsic-size:auto_4rem] [content-visibility:auto]",
        active && ACTIVE_ROW_ELEVATION,
        // Group-level drag surfaces already dim the wrapper; keep row-level
        // opacity only when this item owns the transform.
        sortable?.style !== undefined && sortable.isDragging && "z-20 opacity-80",
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
              className="h-auto min-h-0 items-stretch gap-0 px-2.5 py-[var(--app-sidebar-row-padding-y)] text-[length:var(--app-sidebar-font-size)] transition-none"
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
          <span className="flex w-full min-w-0 flex-col justify-center gap-1 leading-snug">
            <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-sidebar-meta-font-size)] font-normal">
              <ProjectFavicon
                className="size-3 shrink-0"
                cwd={projectCwd ?? ""}
                environmentId={thread.environmentId}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground/85">
                {projectName}
              </span>
              {/* Status at rest, settle/snooze on hover: the label hides rather
                than unmounting so the header line never reflows, and it swaps
                instantly so the row feels immediate under the pointer. */}
              <span className="ml-auto shrink-0 group-hover/thread:invisible group-focus-within/thread:invisible">
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
            <span className="flex min-w-0 items-center gap-1.5">
              {expandToggle}
              <span className="min-w-0 flex-1 truncate text-[length:var(--app-sidebar-title-font-size)] font-medium text-foreground">
                {thread.title}
              </span>
              <ThreadBrowserOpenStatus environmentId={thread.environmentId} threadId={thread.id} />
            </span>
            {/* The metadata line earns its row only when it has something to
                say: a branchless thread with no PR or terminal would otherwise
                reserve blank height on every card. */}
            {hasMetadataLine ? (
              <span className="flex min-w-0 items-center gap-1.5 text-[length:var(--app-sidebar-meta-font-size)] font-normal text-muted-foreground/75">
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
                      "shrink-0 cursor-pointer font-mono transition-none hover:underline",
                      prStatus.colorClass,
                    )}
                    onClick={handlePrClick}
                    type="button"
                  >
                    #{pr.number}
                  </button>
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
