import type { SidebarThreadRowProps } from "./SidebarThreadRow";
import { useSidebarThreadRowState1 } from "./useSidebarThreadRowState1";

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
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
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

import { useRightPanelStore } from "../../rightPanelStore";
import { InlineButton } from "../ui/button";
import { ThreadTerminalStatusButton } from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MiddleTruncate } from "../ui/middle-truncate";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { resolveSettledThreadTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  memo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { SidebarThreadSummary } from "../../types";
import {
  formatWorkingDurationLabel,
  resolveThreadProviderStack,
} from "@t3tools/client-runtime/state/models";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel, parseTimestampDate } from "../../timestampFormat";
import { Kbd } from "../ui/kbd";


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

function compactSidebarTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}


// Subscribes to the minute tick itself, so only the label re-renders each
// minute. The minute is passed as the clock so it is the formatter's input.
export function RelativeTimeLabel(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  return props.timestamp === null
    ? null
    : compactSidebarTimeLabel(
        formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`)),
      );
}


export function threadTimeTimestamp(thread: SidebarThreadSummary): string {
  return thread.latestUserMessageAt ?? thread.updatedAt;
}


function JumpHintBadge(props: { label: string }) {
  return (
    <Kbd aria-hidden data-jump-hint>
      {props.label}
    </Kbd>
  );
}


const JUMP_HINT_SLOT_CLASS_NAME =
  "[&>:not([data-jump-hint])]:invisible [&>:not([data-jump-hint])]:absolute";


function SidebarProviderStack(props: {
  thread: SidebarThreadSummary;
  providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
}) {
  const stack = resolveThreadProviderStack(props.thread);
  const currentInstanceId = stack[stack.length - 1]!;
  const currentEntry = props.providerEntryByInstanceId.get(currentInstanceId) ?? null;
  if (currentEntry === null) return null;
  const showInstanceBadge = shouldShowInstanceBadge(
    currentEntry,
    props.providerEntryByInstanceId.values(),
  );
  const current = (
    <ProviderInstanceIcon
      driverKind={currentEntry.driverKind}
      displayName={currentEntry.displayName}
      accentColor={currentEntry.accentColor}
      acpRegistryAgentId={currentEntry.acpRegistryAgentId}
      acpRegistryIconUrl={currentEntry.acpRegistryIconUrl}
      showBadge={showInstanceBadge}
      size="compact"
      iconClassName="opacity-60"
    />
  );
  if (stack.length === 1) {
    return <span className="inline-flex shrink-0 items-center">{current}</span>;
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {stack.slice(0, -1).map((instanceId) => {
        const entry = props.providerEntryByInstanceId.get(instanceId);
        if (entry === undefined) return null;
        return (
          <ProviderInstanceIcon
            key={instanceId}
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
            iconClassName="size-3 opacity-35 grayscale"
          />
        );
      })}
      <span className="relative z-10 inline-flex items-center">{current}</span>
    </span>
  );
}

export const draftPenClassName = "size-3 shrink-0 text-warning-foreground";

const dropVerbBadge: Record<SidebarDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  settle: (
    <>
      <CircleCheckIcon aria-hidden className="size-3" />
      Settle
    </>
  ),
  unsettle: (
    <>
      <Undo2Icon aria-hidden className="size-3" />
      Un-settle
    </>
  ),
  wake: (
    <>
      <AlarmClockOffIcon aria-hidden className="size-3" />
      Wake
    </>
  ),
};


const TOP_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const;


function TopStatusIcon(props: { icon: keyof typeof TOP_STATUS_ICONS; className: string }) {
  const Icon = TOP_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}


// Mounted only while renaming, so each rename starts uncommitted.
function ThreadRenameInput(props: {
  title: string;
  onTitleChange: (title: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={props.title}
      dir="auto"
      aria-label="Thread title"
      onChange={(event) => props.onTitleChange(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}


function latestRunDiff(
  thread: SidebarThreadSummary,
): { insertions: number; deletions: number } | null {
  void thread;
  return null;
}

export function useSidebarThreadRowState2(props: SidebarThreadRowProps, params: {
  s1: ReturnType<typeof useSidebarThreadRowState1>,
  }) {
  const { s1 } = params;
  const { thread, isRenaming, renamingTitle, onRenameTitleChange, onCommitRename, onCancelRename, variant, onThreadActivate, onContextMenu, variantAction } = props;
  const { destinationVerb, topStatus, threadRef, shouldRecede, status, isUnread, isWoke, isRegeneratingTitle, supportsMultiplePullRequests, pr, currentLinkedPr, prStatus, handlePrClick, runningTerminalIds, hasUnsentDraft, sortable, canOperateThread, handleUnpinClick, isRemote, showsScratchMachine, threadKey, sortableRootProps, fileDropHandlers, rowRef, rowSurfaceClassName, handleClick, handleDoubleClick, handleKeyDown, handleContextMenu, jumpHintLabel, isWokeStatus, handleAcknowledgeWokeClick, handleUnsnoozeClick, handleActionPointerDown, handleUnsettleClick, handleSettleClick, detailsTooltip } = s1;
    const dragDestination =
      destinationVerb !== null ? (
        <span
          role="status"
          className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
        >
          {dropVerbBadge[destinationVerb]}
        </span>
      ) : null;

    const accessibility = resolveSidebarRowAccessibility({
      title: thread.title,
      statusLabel: topStatus?.label ?? null,
      projectDisplayName: props.projectDisplayName,
      isActive: props.isActive,
    });

    const title = isRenaming ? (
      <ThreadRenameInput
        title={renamingTitle}
        onTitleChange={onRenameTitleChange}
        onCommit={() => onCommitRename(threadRef, renamingTitle, thread.title)}
        onCancel={onCancelRename}
      />
    ) : (
      <span
        aria-hidden
        className={cn(
          "min-w-0 flex-1 text-start text-sm transition-opacity motion-reduce:transition-none",
          shouldRecede ? "font-normal" : "font-medium",
          variant !== "slim"
            ? cn(
                "truncate",
                shouldRecede
                  ? "text-foreground/75 group-hover/sidebar-row:text-foreground group-focus-visible/sidebar-row:text-foreground"
                  : status === "failed" && !isUnread && !isWoke
                    ? "text-foreground/95"
                    : "text-foreground",
              )
            : cn(
                "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
                shouldRecede
                  ? "text-secondary-label"
                  : props.isActive || isWoke || status === "input" || status === "request"
                    ? "text-foreground"
                    : isUnread
                      ? "text-muted-foreground"
                      : "text-secondary-label/70",
              ),
          isRegeneratingTitle && "opacity-55",
        )}
        dir={textDirection(thread.title)}
      >
        {thread.title}
      </span>
    );
    const accessibleTitle = isRenaming ? null : <span className="sr-only">{thread.title}</span>;

    const prBadgeShape = supportsMultiplePullRequests
      ? resolveThreadPullRequestBadge(thread.pullRequests)
      : null;
    const handlePrListClick = () => {
      useRightPanelStore.getState().open(threadRef, "pull-requests");
      if (!props.isRouteThread) onThreadActivate(threadRef);
    };
    const prBadge =
      prBadgeShape?.kind === "stack" || pr || currentLinkedPr ? (
        <ThreadPullRequestBadgeControl
          render={<InlineButton />}
          badge={prBadgeShape}
          pullRequests={thread.pullRequests}
          number={pr?.number ?? currentLinkedPr?.number}
          url={pr?.url ?? currentLinkedPr?.url}
          status={prStatus}
          onOpenList={handlePrListClick}
          onOpenPullRequest={handlePrClick}
        />
      ) : null;
    const terminalStatusIcon = (
      <ThreadTerminalStatusButton
        threadRef={threadRef}
        terminalIds={runningTerminalIds}
        onThreadActivate={onThreadActivate}
      />
    );
    const draftIndicator = hasUnsentDraft ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              role="img"
              aria-label="Unsent draft"
              data-testid={`sidebar-draft-indicator-${thread.id}`}
              className="inline-flex shrink-0 items-center"
            />
          }
        >
          <SquarePenIcon aria-hidden className={draftPenClassName} />
        </TooltipTrigger>
        <TooltipPopup side="top">Unsent draft</TooltipPopup>
      </Tooltip>
    ) : null;
    const showPin =
      props.isPinned && (!sortable?.isDragging || (props.dragOverPinned && props.dropVerb === null));
    const pinIndicator = showPin ? (
      props.pinningSupported && canOperateThread && !sortable?.isDragging ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Unpin thread"
                onClick={handleUnpinClick}
                className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <PinIcon
              aria-hidden
              className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
            />
            <PinOffIcon
              aria-hidden
              className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
            />
          </TooltipTrigger>
          <TooltipPopup>Unpin thread</TooltipPopup>
        </Tooltip>
      ) : (
        <PinIcon
          aria-label="Pinned"
          role="img"
          className="size-3 shrink-0 text-muted-foreground/65"
        />
      )
    ) : null;

    const remoteMachineIcon =
      isRemote && !showsScratchMachine ? (
        <span className="inline-flex shrink-0 items-center text-sidebar-muted-foreground/70">
          <EnvironmentMachineIcon aria-hidden kind={props.environmentMachine} className="size-3.5" />
        </span>
      ) : null;
    const diff = latestRunDiff(thread);
    // Only the trailing icons would remain, so the row moves them to the title line instead.
    const metaLineEmpty =
      !thread.branch &&
      !showsScratchMachine &&
      prBadge === null &&
      diff === null &&
      runningTerminalIds.length === 0;
    const metaLine = metaLineEmpty ? null : (
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs">
        {thread.branch ? (
          <>
            <ThreadWorktreeIndicator thread={thread} />
            <span className="flex min-w-0 flex-1">
              <MiddleTruncate value={thread.branch} showTitle={false} />
            </span>
          </>
        ) : showsScratchMachine ? (
          <>
            <EnvironmentMachineIcon
              aria-hidden
              kind={props.environmentMachine}
              className="size-3 shrink-0"
            />
            <span className="min-w-0 flex-1 truncate">{props.scratchMachineLabel}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {terminalStatusIcon}
        {prBadge}
        {diff ? (
          <span className="shrink-0 font-mono">
            <span className="text-diff-addition-foreground">+{formatDiffCount(diff.insertions)}</span>{" "}
            <span className="text-diff-deletion-foreground">−{formatDiffCount(diff.deletions)}</span>
          </span>
        ) : null}
        <span
          aria-hidden
          className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
        >
          {remoteMachineIcon}
          <SidebarProviderStack
            thread={thread}
            providerEntryByInstanceId={props.providerEntryByInstanceId}
          />
        </span>
      </div>
    );
    const titleLineIcons = metaLineEmpty ? (
      <span aria-hidden className="inline-flex shrink-0 items-center gap-1">
        {remoteMachineIcon}
        <SidebarProviderStack
          thread={thread}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
        />
      </span>
    ) : null;


  return { dragDestination, accessibility, title, accessibleTitle, draftIndicator, pinIndicator, metaLineEmpty, metaLine, titleLineIcons };
}
