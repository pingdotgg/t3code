import type { SidebarThreadRowProps } from "./SidebarThreadRow";

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  animateSidebarLayoutChanges,
  hasUnseenCompletion,
  resolveSidebarRowAccessibility,
  type SidebarDropVerb,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  shouldRecedeSidebarThread,
  resolveWorkingStartedAt,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
  setFileDragActive,
} from "../Sidebar.logic";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import {
  ThreadPullRequestBadgeControl,
  ThreadPullRequestsMiniList,
  ThreadWorktreeIndicator,
  prStatusIndicator,
  resolveThreadPullRequestBadge,
  terminalStatusFromRunningIds,
  type TerminalStatusIndicator,
  useLinkedThreadPullRequest,
  ThreadSearchPullRequestNumber,
} from "../ThreadStatusIndicators";
import { useThreadHasUnsentDraft } from "../../composerDraftStore";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { formatRelativeTimeLabel, parseTimestampDate } from "../../timestampFormat";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { makeWorkspaceFileDropHandlers } from "../chat/workspaceFileDrop";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "../Sidebar.snooze";
import {
  canSnooze,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
} from "@t3tools/client-runtime/state/thread-settled";
import { useDeadlinePassed } from "~/hooks/useDeadline";
import { cn } from "~/lib/utils";
import { CSS } from "@dnd-kit/utilities";import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  ClockIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  PinOffIcon,
  ShieldQuestionIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import type { SidebarThreadSummary } from "../../types";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { MiddleTruncate } from "../ui/middle-truncate";


// The fields thread rows show. Provider status pushes refresh `checkedAt`,
// status and auth on every provider; leaving those out keeps each
// environment's map, and every memoized row, stable across them.
export type SidebarProviderEntry = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "enabled"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "models"
>;


function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}


export function SidebarThreadTooltip({
  thread,
  project,
  projectDisplayName,
  environmentLabel,
  environmentMachine,
  providerEntry,
  providerEntryByInstanceId,
  showInstanceBadge,
  modelInstanceId,
  modelLabel,
  branchMismatch,
  terminalStatus,
  terminalProcessCount,
}: {
  thread: SidebarThreadSummary;
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntry: SidebarProviderEntry | null;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  showInstanceBadge: boolean;
  modelInstanceId: string;
  modelLabel: string;
  branchMismatch: {
    threadBranch: string;
    currentBranch: string;
  } | null;
  terminalStatus: TerminalStatusIndicator | null;
  terminalProcessCount: number;
}) {
  const driverKind = providerEntry?.driverKind ?? null;
  const previousProviderNames = thread.providerInstanceHistory
    .filter((instanceId) => instanceId !== modelInstanceId)
    .map((instanceId) => providerEntryByInstanceId.get(instanceId)?.displayName ?? instanceId);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  return (
    <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
      <ThreadHoverCard
        title={thread.title}
        footer={
          supportsMultiplePullRequests && thread.pullRequests.length > 0 ? (
            <div className="border-t border-border/60 pt-2 pl-0.5 text-xs text-muted-foreground">
              <ThreadPullRequestsMiniList pullRequests={thread.pullRequests} />
            </div>
          ) : null
        }
      >
        {projectDisplayName ? (
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectDisplayName}</div>
          </div>
        ) : null}
        {environmentLabel ? (
          <div className="flex min-w-0 items-center gap-2">
            <EnvironmentMachineIcon
              kind={environmentMachine}
              className="size-3 shrink-0 stroke-muted-foreground"
            />
            <div className="min-w-0 truncate text-foreground/75">{environmentLabel}</div>
          </div>
        ) : null}
        {thread.branch ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <MiddleTruncate value={thread.branch} className="flex" />
          </div>
        ) : null}
        {branchMismatch ? (
          <div className="flex min-w-0 items-start gap-2 text-warning">
            <CircleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 stroke-current" />
            <div className="min-w-0 flex-1 wrap-break-word">
              You're currently checked out on another branch.
            </div>
          </div>
        ) : null}
        {driverKind ? (
          <div className="flex min-w-0 items-center gap-2">
            <ProviderInstanceIcon
              driverKind={driverKind}
              displayName={
                providerEntry?.displayName ?? thread.runtime?.providerName ?? modelInstanceId
              }
              accentColor={providerEntry?.accentColor}
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
              showBadge={showInstanceBadge && providerEntry?.accentColor !== undefined}
              badgeContent="none"
              badgeClassName="h-2 min-w-2 px-0"
              iconClassName="size-3 shrink-0 grayscale opacity-60"
            />
            <div className="min-w-0 truncate text-foreground/75">
              {showInstanceBadge && providerEntry
                ? `${modelLabel} · ${providerEntry.displayName}`
                : modelLabel}
            </div>
          </div>
        ) : null}
        {previousProviderNames.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeftIcon className="size-3 shrink-0 stroke-muted-foreground" />
            <div className="min-w-0 truncate text-foreground/75">
              Handed off from {previousProviderNames.join(", ")}
            </div>
          </div>
        ) : null}
        {terminalStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            <TerminalIcon
              aria-hidden
              className={cn("size-3 shrink-0", terminalStatus.colorClass)}
            />
            <div className="min-w-0 truncate text-foreground/75">
              {terminalProcessLabel(terminalProcessCount)}
            </div>
          </div>
        ) : null}
        {thread.runtime?.lastError ? (
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              thread.runtime.lastErrorClass === "usage_limit" ? "text-warning" : "text-error",
            )}
          >
            <CircleAlertIcon className="size-3 shrink-0 stroke-current" />
            <div className="min-w-0 truncate">
              {thread.runtime.lastErrorClass === "usage_limit"
                ? "Usage limit reached"
                : "Error occurred"}
            </div>
          </div>
        ) : null}
      </ThreadHoverCard>
    </ThreadHoverCardPopup>
  );
}


export const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";

export function useSidebarThreadRowState1(props: SidebarThreadRowProps) {
  const { thread, onThreadClick, onAcknowledgeWoke, onContextMenu, isRenaming, onStartRename, onThreadActivate, onFileDropThreads, onSettle, onActionSweepStart, variantAction, onUnsettle, onUnsnooze, onUnpin, onSnooze, openPullRequestsInRightPanel } = props;
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    const threadKey = scopedThreadKey(threadRef);
    const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
    const { leaseLiveStatus, rowRef: leaseRowRef } = useSidebarRowSubscriptionLease(props.isActive);
    const { revealRef } = props;
    const rowRef = (row: HTMLElement | null) => {
      if (row !== null) revealRef?.(row, threadKey);
      return leaseRowRef(row);
    };
    const isRegeneratingTitle = thread.titleRegeneration != null;
    const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
    const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
    const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
    const openPrLink = useOpenPrLink();
    const runningTerminalIds = useThreadRunningTerminalIds({
      environmentId: thread.environmentId,
      threadId: thread.id,
    });
    const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
    const terminalProcessCount = runningTerminalIds.length;
    const hasUnsentDraft = useThreadHasUnsentDraft(threadRef) && !props.isRouteThread;
    const handleDiscardDraftClick = (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      discardComposerDraft(threadRef);
    };

    const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
    const linkedPullRequestStatus = useLinkedThreadPullRequest(
      thread.environmentId,
      thread.linkedPullRequest,
      leaseLiveStatus,
      thread.pullRequests,
      thread.branchPullRequest,
    );
    const gitStatus = useEnvironmentQuery(
      leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
        ? vcsEnvironment.status({
            environmentId: thread.environmentId,
            input: { cwd: gitCwd, includeRemote: false },
          })
        : null,
    );
    const visibleGitStatus = useRetainedValue(
      JSON.stringify([thread.environmentId, gitCwd]),
      gitStatus.data,
    );
    const pr = linkedPullRequestStatus?.pr ?? null;
    const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
    const currentLinkedPr = supportsMultiplePullRequests
      ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
      : null;

    const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
    const status = resolveSidebarThreadStatus(thread);
    const lastVisitedDate = lastVisitedAt === undefined ? null : parseTimestampDate(lastVisitedAt);
    const wokeAtDate = props.wokeAt === null ? null : parseTimestampDate(props.wokeAt);
    const isWoke =
      wokeAtDate !== null &&
      (lastVisitedDate === null || lastVisitedDate < wokeAtDate) &&
      thread.settledOverride !== "settled";
    const shouldRecede = shouldRecedeSidebarThread({
      status,
      isUnread,
      isWoke,
      isActive: props.isActive,
      isSelected,
    });
    const topStatus =
      status === "working"
        ? {
            label: thread.goal?.status === "active" ? "Goal" : "Working",
            icon: "working" as const,
            className: "text-info-foreground",
          }
        : status === "waiting"
          ? {
              label: "Waiting",
              icon: "waiting" as const,
              className: "text-muted-foreground",
            }
          : status === "approval"
            ? {
                label: "Approval",
                icon: "approval" as const,
                className: "text-warning-foreground",
              }
            : status === "input"
              ? {
                  label: "Input",
                  icon: "input" as const,
                  className: "text-indigo-600 dark:text-indigo-300",
                }
              : status === "request"
                ? {
                    label: "Request",
                    icon: "request" as const,
                    className: "text-guest-foreground",
                  }
                : status === "limited"
                  ? {
                      label: "Limited",
                      icon: "failed" as const,
                      className: "text-warning-foreground",
                    }
                  : status === "failed"
                    ? {
                        label: "Failed",
                        icon: "failed" as const,
                        className: "text-error-foreground",
                      }
                    : isWoke
                      ? {
                          label: "Woke",
                          icon: "woke" as const,
                          className: "text-warning-foreground",
                        }
                      : isUnread
                        ? {
                            label: "Done",
                            icon: "done" as const,
                            className: "text-success-foreground",
                          }
                        : null;
    const isWokeStatus = topStatus?.icon === "woke";

    const branchMismatch = resolveLocalCheckoutBranchMismatch({
      effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
      activeWorktreePath: thread.worktreePath,
      activeThreadBranch: thread.branch,
      currentGitBranch: visibleGitStatus?.refName ?? null,
    });
    const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);

    const modelInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
    const showInstanceBadge =
      providerEntry !== null &&
      shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
    const selectedModel = providerEntry?.models.find(
      (model) => model.slug === thread.modelSelection.model,
    );
    const modelLabel = selectedModel
      ? getTriggerDisplayModelName(selectedModel, providerEntry?.driverKind)
      : thread.modelSelection.model;

    const isRemote = thread.environmentId !== props.currentEnvironmentId;
    const showsScratchMachine = !thread.branch && props.scratchMachineLabel !== null;

    const detailsTooltip = (
      <SidebarThreadTooltip
        thread={thread}
        project={props.project}
        projectDisplayName={props.projectDisplayName}
        environmentLabel={props.environmentLabel}
        environmentMachine={props.environmentMachine}
        providerEntry={providerEntry}
        providerEntryByInstanceId={props.providerEntryByInstanceId}
        showInstanceBadge={showInstanceBadge}
        modelInstanceId={modelInstanceId}
        modelLabel={modelLabel}
        branchMismatch={branchMismatch}
        terminalStatus={terminalStatus}
        terminalProcessCount={terminalProcessCount}
      />
    );

    const handleClick = (event: ReactMouseEvent) => {
      onThreadClick(event, threadRef);
    };
    const handleAcknowledgeWokeClick = (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (props.wokeAt === null) return;
      onAcknowledgeWoke(threadRef, props.wokeAt);
    };
    const handleContextMenu = (event: ReactMouseEvent) => {
      event.preventDefault();
      onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    };
    const handleKeyDown = (event: ReactKeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (
        event.key === "F2" &&
        !isRenaming &&
        readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        event.preventDefault();
        onStartRename(threadRef, thread.title);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onThreadActivate(threadRef);
    };
    const handleDoubleClick = (event: ReactMouseEvent) => {
      if (
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) ||
        isRenaming ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      if ((event.target as HTMLElement).closest("button, a, input")) return;
      event.preventDefault();
      onStartRename(threadRef, thread.title);
    };
    const [isFileDragOver, setIsFileDragOver] = useState(false);
    const fileDropHandlers = onFileDropThreads
      ? makeWorkspaceFileDropHandlers({
          setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
          addFiles: (files) => {
            onFileDropThreads(threadRef, files);
          },
          addFolders: () => {},
        })
      : null;
    const handleSettleClick = (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSettle(threadRef);
    };
    const handleActionPointerDown = (event: ReactPointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.stopPropagation();
      onActionSweepStart(threadRef, variantAction, event.nativeEvent);
    };
    const handleUnsettleClick = (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsettle(threadRef);
    };
    const handleUnsnoozeClick = (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnsnooze(threadRef);
    };
    const handleUnpinClick = (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onUnpin(threadRef);
    };
    const handleSnoozePreset = (preset: Pick<SnoozePreset, "snoozedUntil">) => {
      onSnooze(threadRef, preset);
    };
    const [snoozeMenuOpenRaw, setSnoozeMenuOpen] = useState(false);
    // The React Compiler caches render results on their inputs, so a clock read
    // here would stay frozen until `thread` changes and a queued-turn gate would
    // never reopen. The gate's clock is state, reset with the thread.
    const [snoozeGateClock, setSnoozeGateClock] = useState(() => ({
      thread,
      now: new Date().toISOString(),
    }));
    if (snoozeGateClock.thread !== thread) {
      // oxlint-disable-next-line react/purity -- Reseeds the snooze gate clock only in the render-phase adjustment that runs when the thread changes.
      setSnoozeGateClock({ thread, now: new Date().toISOString() });
    }
    const snoozeGateNow = snoozeGateClock.now;
    const snoozeGateExpiryMs = hasQueuedTurnStart(thread, { now: snoozeGateNow })
      ? Date.parse(thread.latestUserMessageAt ?? "") + QUEUED_TURN_START_GRACE_MS
      : Number.NaN;
    // A gate still closed past its expiry is held by runtime status, not time,
    // so no clock tick can open it.
    const snoozeGateOpensAt =
      Number.isFinite(snoozeGateExpiryMs) && snoozeGateExpiryMs > Date.parse(snoozeGateNow)
        ? snoozeGateExpiryMs + 50
        : null;
    const snoozeGateOpened = useDeadlinePassed(snoozeGateOpensAt);
    if (snoozeGateOpened && snoozeGateOpensAt !== null) {
      setSnoozeGateClock({ thread, now: new Date(snoozeGateOpensAt).toISOString() });
    }
    const showSnoozeButton =
      canOperateThread && props.snoozeSupported && canSnooze(thread, { now: snoozeGateNow });
    // Closing here, not just masking, keeps the menu from reopening when the button returns.
    if (snoozeMenuOpenRaw && !showSnoozeButton) setSnoozeMenuOpen(false);
    const snoozeMenuOpen = snoozeMenuOpenRaw && showSnoozeButton;
    const jumpHintLabel = snoozeMenuOpen ? null : props.jumpLabel;
    const handlePrClick = (event: ReactMouseEvent<HTMLElement>, targetUrl?: string) => {
      const url = targetUrl ?? pr?.url ?? currentLinkedPr?.url;
      if (!url) return;
      const showInRightPanel = targetUrl !== undefined || openPullRequestsInRightPanel;
      const openedInRightPanel = openPrLink(event, url, showInRightPanel ? threadRef : undefined);
      if (openedInRightPanel && showInRightPanel && !props.isRouteThread) {
        onThreadActivate(threadRef);
      }
    };

    const rowSurfaceClassName = cn(
      "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      variantAction === "unsettle" &&
        !props.isActive &&
        "[&:not(:hover):not(:focus-within)_*]:text-secondary-label",
      props.isActive
        ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
        : isSelected || props.sweepAction !== null
          ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
          : hasUnsentDraft
            ? cn(draftSurfaceClassName, "text-sidebar-foreground")
            : shouldRecede
              ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
      shouldRecede &&
        status === "working" &&
        "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
      isFileDragOver && "ring-1 ring-inset ring-primary/70",
      isFileDragOver && !props.isActive && !isSelected && "bg-sidebar-row-hover",
      props.sortable?.isDragging &&
        "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
    );
    const sortable = props.sortable;
    const sortableRootProps = sortable
      ? {
          ref: sortable.setNodeRef,
          style: {
            transform: CSS.Translate.toString(sortable.transform),
            transition: sortable.transition,
            // A zero-height boundary also makes dnd-kit scale the source to
            // zero. Only projected peers use scaleY as a visibility sentinel.
            visibility:
              !sortable.isDragging && sortable.transform?.scaleY === 0
                ? ("hidden" as const)
                : undefined,
          },
          ...sortable.listeners,
        }
      : {};
    const destinationVerb = sortable?.isDragging
      ? props.dropVerb
      : props.sweepAction === "unsnooze"
        ? "wake"
        : props.sweepAction;

  return { threadRef, threadKey, canOperateThread, rowRef, isRegeneratingTitle, runningTerminalIds, hasUnsentDraft, handleDiscardDraftClick, pr, supportsMultiplePullRequests, currentLinkedPr, isUnread, status, isWoke, shouldRecede, topStatus, isWokeStatus, prStatus, isRemote, showsScratchMachine, detailsTooltip, handleClick, handleAcknowledgeWokeClick, handleContextMenu, handleKeyDown, handleDoubleClick, fileDropHandlers, handleSettleClick, handleActionPointerDown, handleUnsettleClick, handleUnsnoozeClick, handleUnpinClick, handleSnoozePreset, setSnoozeMenuOpen, showSnoozeButton, snoozeMenuOpen, jumpHintLabel, handlePrClick, rowSurfaceClassName, sortable, sortableRootProps, destinationVerb };
}
