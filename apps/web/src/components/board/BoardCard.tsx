import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  BotIcon,
  EllipsisIcon,
  GitBranchIcon,
  PinIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, type MouseEvent as ReactMouseEvent } from "react";

import { formatWorkingDurationLabel, resolveWorkingStartedAt } from "../Sidebar.logic";
import {
  ChangeRequestStatusIcon,
  PrStatusTooltipContent,
  ThreadStatusLabel,
  prStatusIndicator,
  resolveThreadPr,
  terminalStatusFromRunningIds,
} from "../ThreadStatusIndicators";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import type { SidebarThreadSummary } from "../../types";
import { formatWorktreePathForDisplay } from "../../worktreeCleanup";
import { cn } from "~/lib/utils";
import type { BoardColumnId } from "./Board.logic";
import type { BoardCardActions } from "./boardActions";

export interface BoardCardProps {
  readonly thread: SidebarThreadSummary;
  readonly columnId: BoardColumnId;
  readonly projectTitle: string | null;
  readonly projectCwd: string | null;
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly isRemote: boolean;
  readonly isActiveThread: boolean;
  readonly nowMs: number;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly pinningSupported: boolean;
  readonly actions: BoardCardActions;
  readonly onChangeRequestState: (
    threadKey: string,
    state: "open" | "closed" | "merged" | null,
  ) => void;
}

export const BoardCard = memo(function BoardCard(props: BoardCardProps) {
  const { actions, onChangeRequestState, thread } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);

  // Draggable, not sortable: the board has no manual order to persist, so a
  // sortable list's reorder preview would promise something the next
  // partition immediately undoes.
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: threadKey,
    data: { threadKey, columnId: props.columnId },
  });

  // Shell data only. Board cards never open a thread-detail subscription:
  // each hydrated detail is a renderer-heap and server-load multiplier, and
  // a board shows far more rows at once than the sidebar's prewarm window.
  const gitCwd = thread.worktreePath ?? props.projectCwd;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({ environmentId: thread.environmentId, input: { cwd: gitCwd } })
      : null,
  );
  const pr = resolveThreadPr({ threadBranch: thread.branch, gitStatus: gitStatus.data });
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  // Report the PR state up: the board partitions with effectiveSettled, and a
  // merged or closed PR auto-settles a thread — data only cards have.
  const prState = pr?.state ?? null;
  useEffect(() => {
    onChangeRequestState(threadKey, prState);
  }, [onChangeRequestState, prState, threadKey]);
  useEffect(
    () => () => {
      onChangeRequestState(threadKey, null);
    },
    [onChangeRequestState, threadKey],
  );

  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const selectedModel = props.providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const statusPill = actions.resolveStatusPill(thread);
  const isPinned = thread.pinnedAt != null;
  const workingStartedAt = resolveWorkingStartedAt(thread);
  const workingLabel =
    props.columnId === "working" && workingStartedAt !== null
      ? formatWorkingDurationLabel(props.nowMs - Date.parse(workingStartedAt))
      : null;
  const planProgress = thread.planProgress ?? null;
  const fleetLabel =
    thread.backgroundLiveness === "working"
      ? "Subagents running"
      : thread.backgroundLiveness === "monitoring"
        ? "Watch loop running"
        : null;

  const openThread = useCallback(
    (event?: ReactMouseEvent) => {
      if (event?.defaultPrevented) return;
      actions.openThread(threadRef);
    },
    [actions, threadRef],
  );

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        "group/board-card relative rounded-lg border border-border/60 bg-card/40 text-left",
        "focus-within:border-border hover:border-border hover:bg-card/70",
        props.isActiveThread && "border-primary/50 bg-card/80",
        isDragging && "opacity-40",
      )}
      data-thread-key={threadKey}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={openThread}
        className="flex w-full cursor-pointer flex-col gap-1.5 px-2.5 py-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {isPinned ? (
            <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground/70" />
          ) : null}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] text-foreground",
              props.columnId === "working" && !props.isActiveThread && "opacity-75",
            )}
          >
            {thread.title}
          </span>
          {statusPill ? <ThreadStatusLabel status={statusPill} compact /> : null}
        </span>

        {planProgress ? (
          <span className="truncate text-[11px] text-muted-foreground/70">
            {planProgress.completedSteps}/{planProgress.totalSteps} · {planProgress.step}
          </span>
        ) : null}

        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/70">
          {props.projectCwd !== null ? (
            <ProjectFavicon
              environmentId={thread.environmentId}
              cwd={props.projectCwd}
              className="size-3 shrink-0"
            />
          ) : null}
          {props.projectTitle ? (
            <span className="min-w-0 max-w-[9rem] truncate">{props.projectTitle}</span>
          ) : null}
          {thread.branch ? (
            <span className="flex min-w-0 items-center gap-0.5">
              <GitBranchIcon className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 max-w-[8rem] truncate">{thread.branch}</span>
            </span>
          ) : null}
          {workingLabel ? <span className="tabular-nums">{workingLabel}</span> : null}
        </span>

        <span className="flex items-center gap-1.5">
          {prStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={prStatus.tooltip}
                    className={cn("inline-flex items-center", prStatus.colorClass)}
                  />
                }
              >
                <ChangeRequestStatusIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                <PrStatusTooltipContent status={prStatus} />
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {fleetLabel ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={fleetLabel}
                    className="inline-flex items-center text-muted-foreground/70"
                  />
                }
              >
                <BotIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{fleetLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {terminalStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={terminalStatus.label}
                    className={cn("inline-flex items-center", terminalStatus.colorClass)}
                  />
                }
              >
                <TerminalIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
            </Tooltip>
          ) : null}
          {thread.worktreePath ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={`Worktree: ${formatWorktreePathForDisplay(thread.worktreePath)}`}
                    className="inline-flex items-center text-muted-foreground/50"
                  />
                }
              >
                <span className="text-[10px]">wt</span>
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`Worktree: ${formatWorktreePathForDisplay(thread.worktreePath)}`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-1.5">
            {props.isRemote ? (
              <ServerIcon aria-hidden className="size-3 text-muted-foreground/60" />
            ) : null}
            <span className="truncate text-[10px] text-muted-foreground/60">{modelLabel}</span>
            {props.providerEntry ? (
              <ProviderInstanceIcon
                driverKind={props.providerEntry.driverKind}
                displayName={thread.session?.providerName ?? modelInstanceId}
                iconClassName="size-3"
                className="opacity-60"
              />
            ) : null}
          </span>
        </span>
      </button>

      <BoardCardMenu
        threadRef={threadRef}
        thread={thread}
        columnId={props.columnId}
        actions={actions}
        settlementSupported={props.settlementSupported}
        snoozeSupported={props.snoozeSupported}
        pinningSupported={props.pinningSupported}
      />
    </div>
  );
});

function BoardCardMenu(props: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: SidebarThreadSummary;
  readonly columnId: BoardColumnId;
  readonly actions: BoardCardActions;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly pinningSupported: boolean;
}) {
  const { actions, columnId, thread, threadRef } = props;
  const isPinned = thread.pinnedAt != null;
  const isSettled = columnId === "done";
  const isSnoozed = columnId === "snoozed";
  const snoozePresets = actions.resolveSnoozePresets();

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Thread actions"
            onClick={(event) => event.stopPropagation()}
            className={cn(
              "absolute top-1.5 right-1.5 inline-flex size-5 cursor-pointer items-center justify-center",
              "rounded-md text-muted-foreground/60 opacity-0 hover:bg-accent hover:text-foreground",
              "group-hover/board-card:opacity-100 focus-visible:opacity-100",
            )}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-52">
        <MenuItem onClick={() => actions.openThread(threadRef)}>Open thread</MenuItem>
        {props.pinningSupported ? (
          <MenuItem
            onClick={() =>
              isPinned ? actions.unpinThread(threadRef) : actions.pinThread(threadRef)
            }
          >
            {isPinned ? "Unpin thread" : "Pin thread"}
          </MenuItem>
        ) : null}
        {props.settlementSupported ? (
          <MenuItem
            onClick={() =>
              isSettled ? actions.unsettleThread(threadRef) : actions.settleThread(threadRef)
            }
          >
            {isSettled ? "Un-settle thread" : "Mark done"}
          </MenuItem>
        ) : null}
        {props.snoozeSupported ? (
          isSnoozed ? (
            <MenuItem onClick={() => actions.unsnoozeThread(threadRef)}>Wake thread</MenuItem>
          ) : (
            snoozePresets.map((preset) => (
              <MenuItem
                key={preset.id}
                onClick={() => actions.snoozeThread(threadRef, preset.snoozedUntil)}
              >
                {`Snooze · ${preset.label} (${preset.whenLabel})`}
              </MenuItem>
            ))
          )
        ) : null}
        <MenuSeparator />
        <MenuItem onClick={() => actions.archiveThread(threadRef)}>Archive thread</MenuItem>
        <MenuItem onClick={() => actions.deleteThread(threadRef)}>Delete thread</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
