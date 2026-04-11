import { type EnvironmentId, type MessageId, type TurnId } from "@t3tools/contracts";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { clamp } from "effect/Number";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  historicalTimelineEntries: ReturnType<typeof deriveTimelineEntries>;
  liveTimelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso?: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  changedFilesExpandedByTurnId: Record<string, boolean>;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  onVirtualizerSnapshot?: (snapshot: {
    totalSize: number;
    measurements: ReadonlyArray<{
      id: string;
      kind: MessagesTimelineRow["kind"];
      index: number;
      size: number;
      start: number;
      end: number;
    }>;
  }) => void;
}

export const TimelineEmptyState = memo(function TimelineEmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-muted-foreground/30">Send a message to start the conversation.</p>
    </div>
  );
});

export const HistoricalMessagesTimelineSection = memo(function HistoricalMessagesTimelineSection({
  scrollContainer,
  historicalTimelineEntries,
  turnDiffSummaryByAssistantMessageId,
  expandedWorkGroups,
  onToggleWorkGroup,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  onVirtualizerSnapshot,
}: Pick<
  MessagesTimelineProps,
  | "scrollContainer"
  | "historicalTimelineEntries"
  | "turnDiffSummaryByAssistantMessageId"
  | "expandedWorkGroups"
  | "onToggleWorkGroup"
  | "changedFilesExpandedByTurnId"
  | "onSetChangedFilesExpanded"
  | "onOpenTurnDiff"
  | "revertTurnCountByUserMessageId"
  | "onRevertUserMessage"
  | "isRevertingCheckpoint"
  | "onImageExpand"
  | "activeThreadEnvironmentId"
  | "markdownCwd"
  | "resolvedTheme"
  | "timestampFormat"
  | "workspaceRoot"
  | "onVirtualizerSnapshot"
>) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, []);

  const historicalRawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries: historicalTimelineEntries,
        completionDividerBeforeEntryId: null,
        isWorking: false,
        activeTurnStartedAt: null,
      }),
    [historicalTimelineEntries],
  );
  const historicalRows = useStableTimelineRows(historicalRawRows);

  const virtualizedRowCount = clamp(historicalRows.length, {
    minimum: 0,
    maximum: historicalRows.length,
  });
  const virtualMeasurementScopeKey =
    timelineWidthPx === null ? "width:unknown" : `width:${Math.round(timelineWidthPx)}`;

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Scope cached row measurements to the current timeline width so offscreen
    // rows do not keep stale heights after wrapping changes.
    getItemKey: (index: number) => {
      const rowId = historicalRows[index]?.id ?? String(index);
      return `${virtualMeasurementScopeKey}:${rowId}`;
    },
    estimateSize: (index: number) => {
      const row = historicalRows[index];
      if (!row) return 96;
      return estimateMessagesTimelineRowHeight(row, {
        expandedWorkGroups,
        timelineWidthPx,
        turnDiffSummaryByAssistantMessageId,
      });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const itemIntersectsViewport =
        item.end > scrollOffset && item.start < scrollOffset + viewportHeight;
      if (itemIntersectsViewport) {
        return false;
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (!onVirtualizerSnapshot) {
      return;
    }
    onVirtualizerSnapshot({
      totalSize: rowVirtualizer.getTotalSize(),
      measurements: rowVirtualizer.measurementsCache
        .slice(0, virtualizedRowCount)
        .flatMap((measurement) => {
          const row = historicalRows[measurement.index];
          if (!row) {
            return [];
          }
          return [
            {
              id: row.id,
              kind: row.kind,
              index: measurement.index,
              size: measurement.size,
              start: measurement.start,
              end: measurement.end,
            },
          ];
        }),
    });
  }, [historicalRows, onVirtualizerSnapshot, rowVirtualizer, virtualizedRowCount]);

  const virtualRows = useStableVirtualRows(rowVirtualizer.getVirtualItems());

  const renderHistoricalRowContent = useCallback(
    (row: TimelineRow) => {
      const turnDiffSummary =
        row.kind === "message" && row.message.role === "assistant"
          ? (turnDiffSummaryByAssistantMessageId.get(row.message.id) ?? null)
          : null;

      return (
        <TimelineRowItem
          row={row}
          completionSummary={null}
          turnDiffSummary={turnDiffSummary}
          isExpandedWorkGroup={row.kind === "work" ? (expandedWorkGroups[row.id] ?? false) : false}
          changedFilesExpanded={
            turnDiffSummary ? (changedFilesExpandedByTurnId[turnDiffSummary.turnId] ?? true) : true
          }
          canRevertAgentWork={
            row.kind === "message" && row.message.role === "user"
              ? revertTurnCountByUserMessageId.has(row.message.id)
              : false
          }
          activeTurnInProgress={false}
          activeTurnId={null}
          isWorking={false}
          isRevertingCheckpoint={isRevertingCheckpoint}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          markdownCwd={markdownCwd}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          nowIso={undefined}
          onToggleWorkGroup={onToggleWorkGroup}
          onSetChangedFilesExpanded={onSetChangedFilesExpanded}
          onOpenTurnDiff={onOpenTurnDiff}
          onRevertUserMessage={onRevertUserMessage}
          onImageExpand={onImageExpand}
          onTimelineImageLoad={onTimelineImageLoad}
        />
      );
    },
    [
      activeThreadEnvironmentId,
      changedFilesExpandedByTurnId,
      expandedWorkGroups,
      isRevertingCheckpoint,
      markdownCwd,
      onImageExpand,
      onOpenTurnDiff,
      onRevertUserMessage,
      onSetChangedFilesExpanded,
      onTimelineImageLoad,
      onToggleWorkGroup,
      resolvedTheme,
      revertTurnCountByUserMessageId,
      timestampFormat,
      turnDiffSummaryByAssistantMessageId,
      workspaceRoot,
    ],
  );

  return (
    <div ref={timelineRootRef} data-timeline-root="true" className="w-full overflow-x-hidden">
      {virtualizedRowCount > 0 && (
        <HistoricalTimelineRows
          rows={historicalRows}
          virtualRows={virtualRows}
          totalSize={rowVirtualizer.getTotalSize()}
          measureElement={rowVirtualizer.measureElement}
          renderRowContent={renderHistoricalRowContent}
        />
      )}
    </div>
  );
});

export const LiveMessagesTimelineSection = memo(function LiveMessagesTimelineSection({
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  liveTimelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
}: Pick<
  MessagesTimelineProps,
  | "isWorking"
  | "activeTurnInProgress"
  | "activeTurnId"
  | "activeTurnStartedAt"
  | "liveTimelineEntries"
  | "completionDividerBeforeEntryId"
  | "completionSummary"
  | "turnDiffSummaryByAssistantMessageId"
  | "nowIso"
  | "expandedWorkGroups"
  | "onToggleWorkGroup"
  | "changedFilesExpandedByTurnId"
  | "onSetChangedFilesExpanded"
  | "onOpenTurnDiff"
  | "revertTurnCountByUserMessageId"
  | "onRevertUserMessage"
  | "isRevertingCheckpoint"
  | "onImageExpand"
  | "activeThreadEnvironmentId"
  | "markdownCwd"
  | "resolvedTheme"
  | "timestampFormat"
  | "workspaceRoot"
>) {
  const liveRawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries: liveTimelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
      }),
    [activeTurnStartedAt, completionDividerBeforeEntryId, isWorking, liveTimelineEntries],
  );
  const liveRows = useStableTimelineRows(liveRawRows);

  const renderLiveRowContent = useCallback(
    (row: TimelineRow) => {
      const turnDiffSummary =
        row.kind === "message" && row.message.role === "assistant"
          ? (turnDiffSummaryByAssistantMessageId.get(row.message.id) ?? null)
          : null;

      return (
        <TimelineRowItem
          row={row}
          completionSummary={completionSummary}
          turnDiffSummary={turnDiffSummary}
          isExpandedWorkGroup={row.kind === "work" ? (expandedWorkGroups[row.id] ?? false) : false}
          changedFilesExpanded={
            turnDiffSummary ? (changedFilesExpandedByTurnId[turnDiffSummary.turnId] ?? true) : true
          }
          canRevertAgentWork={
            row.kind === "message" && row.message.role === "user"
              ? revertTurnCountByUserMessageId.has(row.message.id)
              : false
          }
          activeTurnInProgress={activeTurnInProgress}
          activeTurnId={activeTurnId}
          isWorking={isWorking}
          isRevertingCheckpoint={isRevertingCheckpoint}
          activeThreadEnvironmentId={activeThreadEnvironmentId}
          markdownCwd={markdownCwd}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          nowIso={nowIso}
          onToggleWorkGroup={onToggleWorkGroup}
          onSetChangedFilesExpanded={onSetChangedFilesExpanded}
          onOpenTurnDiff={onOpenTurnDiff}
          onRevertUserMessage={onRevertUserMessage}
          onImageExpand={onImageExpand}
          onTimelineImageLoad={() => {}}
        />
      );
    },
    [
      activeThreadEnvironmentId,
      activeTurnId,
      activeTurnInProgress,
      changedFilesExpandedByTurnId,
      completionSummary,
      expandedWorkGroups,
      isRevertingCheckpoint,
      isWorking,
      markdownCwd,
      nowIso,
      onImageExpand,
      onOpenTurnDiff,
      onRevertUserMessage,
      onSetChangedFilesExpanded,
      onToggleWorkGroup,
      resolvedTheme,
      revertTurnCountByUserMessageId,
      timestampFormat,
      turnDiffSummaryByAssistantMessageId,
      workspaceRoot,
    ],
  );

  return <LiveTimelineRows rows={liveRows} renderRowContent={renderLiveRowContent} />;
});

export const MessagesTimeline = memo(function MessagesTimeline(props: MessagesTimelineProps) {
  if (!props.hasMessages && !props.isWorking) {
    return <TimelineEmptyState />;
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden">
      <HistoricalMessagesTimelineSection
        scrollContainer={props.scrollContainer}
        historicalTimelineEntries={props.historicalTimelineEntries}
        turnDiffSummaryByAssistantMessageId={props.turnDiffSummaryByAssistantMessageId}
        expandedWorkGroups={props.expandedWorkGroups}
        onToggleWorkGroup={props.onToggleWorkGroup}
        changedFilesExpandedByTurnId={props.changedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={props.onSetChangedFilesExpanded}
        onOpenTurnDiff={props.onOpenTurnDiff}
        revertTurnCountByUserMessageId={props.revertTurnCountByUserMessageId}
        onRevertUserMessage={props.onRevertUserMessage}
        isRevertingCheckpoint={props.isRevertingCheckpoint}
        onImageExpand={props.onImageExpand}
        activeThreadEnvironmentId={props.activeThreadEnvironmentId}
        markdownCwd={props.markdownCwd}
        resolvedTheme={props.resolvedTheme}
        timestampFormat={props.timestampFormat}
        workspaceRoot={props.workspaceRoot}
        {...(props.onVirtualizerSnapshot
          ? { onVirtualizerSnapshot: props.onVirtualizerSnapshot }
          : {})}
      />
      <LiveMessagesTimelineSection
        isWorking={props.isWorking}
        activeTurnInProgress={props.activeTurnInProgress}
        activeTurnStartedAt={props.activeTurnStartedAt}
        liveTimelineEntries={props.liveTimelineEntries}
        completionDividerBeforeEntryId={props.completionDividerBeforeEntryId}
        completionSummary={props.completionSummary}
        turnDiffSummaryByAssistantMessageId={props.turnDiffSummaryByAssistantMessageId}
        expandedWorkGroups={props.expandedWorkGroups}
        onToggleWorkGroup={props.onToggleWorkGroup}
        changedFilesExpandedByTurnId={props.changedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={props.onSetChangedFilesExpanded}
        onOpenTurnDiff={props.onOpenTurnDiff}
        revertTurnCountByUserMessageId={props.revertTurnCountByUserMessageId}
        onRevertUserMessage={props.onRevertUserMessage}
        isRevertingCheckpoint={props.isRevertingCheckpoint}
        onImageExpand={props.onImageExpand}
        activeThreadEnvironmentId={props.activeThreadEnvironmentId}
        markdownCwd={props.markdownCwd}
        resolvedTheme={props.resolvedTheme}
        timestampFormat={props.timestampFormat}
        workspaceRoot={props.workspaceRoot}
        {...(props.nowIso !== undefined ? { nowIso: props.nowIso } : {})}
        {...(props.activeTurnId !== undefined ? { activeTurnId: props.activeTurnId } : {})}
      />
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const HistoricalTimelineRows = memo(function HistoricalTimelineRows(props: {
  rows: ReadonlyArray<TimelineRow>;
  virtualRows: ReadonlyArray<VirtualItem>;
  totalSize: number;
  measureElement: (element: Element | null) => void;
  renderRowContent: (row: TimelineRow) => ReactNode;
}) {
  if (props.rows.length === 0) {
    return null;
  }

  return (
    <div className="relative" style={{ height: `${props.totalSize}px` }}>
      {props.virtualRows.map((virtualRow) => {
        const row = props.rows[virtualRow.index];
        if (!row) return null;

        return (
          <div
            key={`virtual-row:${row.id}`}
            data-index={virtualRow.index}
            data-virtual-row-id={row.id}
            data-virtual-row-kind={row.kind}
            data-virtual-row-size={virtualRow.size}
            data-virtual-row-start={virtualRow.start}
            ref={props.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {props.renderRowContent(row)}
          </div>
        );
      })}
    </div>
  );
});

const LiveTimelineRows = memo(function LiveTimelineRows(props: {
  rows: ReadonlyArray<TimelineRow>;
  renderRowContent: (row: TimelineRow) => ReactNode;
}) {
  return props.rows.map((row) => (
    <div key={`non-virtual-row:${row.id}`}>{props.renderRowContent(row)}</div>
  ));
});

function useStableTimelineRows(rows: ReadonlyArray<TimelineRow>): ReadonlyArray<TimelineRow> {
  const previousRowsRef = useRef<ReadonlyArray<TimelineRow>>([]);
  const stabilizedRows = rows.map((row, index) => {
    const previousRow = previousRowsRef.current[index];
    return canReuseTimelineRow(previousRow, row) ? previousRow : row;
  });

  previousRowsRef.current = stabilizedRows;
  return stabilizedRows;
}

function useStableVirtualRows(rows: ReadonlyArray<VirtualItem>): ReadonlyArray<VirtualItem> {
  const previousRowsRef = useRef<ReadonlyArray<VirtualItem>>([]);
  const previousRows = previousRowsRef.current;
  const hasSameRows =
    previousRows.length === rows.length &&
    previousRows.every((row, index) => {
      const candidate = rows[index];
      return (
        candidate !== undefined &&
        row.index === candidate.index &&
        row.start === candidate.start &&
        row.end === candidate.end &&
        row.size === candidate.size &&
        row.key === candidate.key
      );
    });

  if (hasSameRows) {
    return previousRows;
  }

  previousRowsRef.current = rows;
  return rows;
}

function canReuseTimelineRow(
  previous: TimelineRow | undefined,
  next: TimelineRow,
): previous is TimelineRow {
  if (!previous || previous.kind !== next.kind || previous.id !== next.id) {
    return false;
  }

  switch (next.kind) {
    case "message": {
      const previousMessageRow = previous as Extract<TimelineRow, { kind: "message" }>;
      const nextMessageRow = next as Extract<TimelineRow, { kind: "message" }>;
      return (
        previousMessageRow.message === nextMessageRow.message &&
        previousMessageRow.durationStart === nextMessageRow.durationStart &&
        previousMessageRow.showCompletionDivider === nextMessageRow.showCompletionDivider &&
        previousMessageRow.showAssistantCopyButton === nextMessageRow.showAssistantCopyButton
      );
    }
    case "proposed-plan": {
      const previousProposedPlanRow = previous as Extract<TimelineRow, { kind: "proposed-plan" }>;
      const nextProposedPlanRow = next as Extract<TimelineRow, { kind: "proposed-plan" }>;
      return previousProposedPlanRow.proposedPlan === nextProposedPlanRow.proposedPlan;
    }
    case "working": {
      const previousWorkingRow = previous as Extract<TimelineRow, { kind: "working" }>;
      const nextWorkingRow = next as Extract<TimelineRow, { kind: "working" }>;
      return previousWorkingRow.createdAt === nextWorkingRow.createdAt;
    }
    case "work": {
      const previousWorkRow = previous as Extract<TimelineRow, { kind: "work" }>;
      const nextWorkRow = next as Extract<TimelineRow, { kind: "work" }>;
      return workEntriesEqual(previousWorkRow.groupedEntries, nextWorkRow.groupedEntries);
    }
  }
}

interface TimelineRowItemProps {
  row: TimelineRow;
  completionSummary: string | null;
  turnDiffSummary: TurnDiffSummary | null;
  isExpandedWorkGroup: boolean;
  changedFilesExpanded: boolean;
  canRevertAgentWork: boolean;
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  nowIso: string | undefined;
  onToggleWorkGroup: (groupId: string) => void;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onTimelineImageLoad: () => void;
}

const TimelineRowItem = memo(function TimelineRowItem(props: TimelineRowItemProps) {
  const { row } = props;

  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? (
        <WorkGroupRow
          row={row}
          isExpanded={props.isExpandedWorkGroup}
          onToggleWorkGroup={props.onToggleWorkGroup}
        />
      ) : null}

      {row.kind === "message" && row.message.role === "user" ? (
        <UserMessageRow
          row={row}
          canRevertAgentWork={props.canRevertAgentWork}
          isRevertingCheckpoint={props.isRevertingCheckpoint}
          isWorking={props.isWorking}
          onRevertUserMessage={props.onRevertUserMessage}
          onImageExpand={props.onImageExpand}
          onTimelineImageLoad={props.onTimelineImageLoad}
          timestampFormat={props.timestampFormat}
        />
      ) : null}

      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantMessageRow
          row={row}
          completionSummary={props.completionSummary}
          turnDiffSummary={props.turnDiffSummary}
          changedFilesExpanded={props.changedFilesExpanded}
          activeTurnInProgress={props.activeTurnInProgress}
          activeTurnId={props.activeTurnId}
          markdownCwd={props.markdownCwd}
          resolvedTheme={props.resolvedTheme}
          timestampFormat={props.timestampFormat}
          nowIso={props.nowIso}
          onSetChangedFilesExpanded={props.onSetChangedFilesExpanded}
          onOpenTurnDiff={props.onOpenTurnDiff}
        />
      ) : null}

      {row.kind === "proposed-plan" ? (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={props.activeThreadEnvironmentId}
            cwd={props.markdownCwd}
            workspaceRoot={props.workspaceRoot}
          />
        </div>
      ) : null}

      {row.kind === "working" ? (
        <div className="py-0.5 pl-1.5">
          <LiveWorkingStatus createdAt={row.createdAt} nowIsoOverride={props.nowIso} />
        </div>
      ) : null}
    </div>
  );
}, areTimelineRowItemPropsEqual);

const WorkGroupRow = memo(function WorkGroupRow(props: {
  row: Extract<TimelineRow, { kind: "work" }>;
  isExpanded: boolean;
  onToggleWorkGroup: (groupId: string) => void;
}) {
  const groupedEntries = props.row.groupedEntries;
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !props.isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader ? (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {groupLabel} ({groupedEntries.length})
          </p>
          {hasOverflow ? (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => props.onToggleWorkGroup(props.row.id)}
            >
              {props.isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow key={`work-row:${workEntry.id}`} workEntry={workEntry} />
        ))}
      </div>
    </div>
  );
});

const UserMessageRow = memo(function UserMessageRow(props: {
  row: Extract<TimelineRow, { kind: "message" }>;
  canRevertAgentWork: boolean;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onTimelineImageLoad: () => void;
  timestampFormat: TimestampFormat;
}) {
  const userImages = props.row.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(props.row.message.text);
  const terminalContexts = displayedUserMessage.contexts;

  return (
    <div className="flex justify-end">
      <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
        {userImages.length > 0 ? (
          <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
            {userImages.map((image: NonNullable<TimelineMessage["attachments"]>[number]) => (
              <div
                key={image.id}
                className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
              >
                {image.previewUrl ? (
                  <button
                    type="button"
                    className="h-full w-full cursor-zoom-in"
                    aria-label={`Preview ${image.name}`}
                    onClick={() => {
                      const preview = buildExpandedImagePreview(userImages, image.id);
                      if (!preview) return;
                      props.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
                      onLoad={props.onTimelineImageLoad}
                      onError={props.onTimelineImageLoad}
                    />
                  </button>
                ) : (
                  <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                    {image.name}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : null}
        {displayedUserMessage.visibleText.trim().length > 0 || terminalContexts.length > 0 ? (
          <UserMessageBody
            text={displayedUserMessage.visibleText}
            terminalContexts={terminalContexts}
          />
        ) : null}
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
            {displayedUserMessage.copyText ? (
              <MessageCopyButton text={displayedUserMessage.copyText} />
            ) : null}
            {props.canRevertAgentWork ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={props.isRevertingCheckpoint || props.isWorking}
                onClick={() => props.onRevertUserMessage(props.row.message.id)}
                title="Revert to this message"
              >
                <Undo2Icon className="size-3" />
              </Button>
            ) : null}
          </div>
          <p className="text-right text-xs text-muted-foreground/50">
            {formatTimestamp(props.row.message.createdAt, props.timestampFormat)}
          </p>
        </div>
      </div>
    </div>
  );
});

const AssistantMessageRow = memo(function AssistantMessageRow(props: {
  row: Extract<TimelineRow, { kind: "message" }>;
  completionSummary: string | null;
  turnDiffSummary: TurnDiffSummary | null;
  changedFilesExpanded: boolean;
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  nowIso: string | undefined;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const messageText =
    props.row.message.text || (props.row.message.streaming ? "" : "(empty response)");
  const assistantTurnStillInProgress =
    props.activeTurnInProgress &&
    props.activeTurnId !== null &&
    props.activeTurnId !== undefined &&
    props.row.message.turnId === props.activeTurnId;
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: props.row.message.text ?? null,
    showCopyButton: props.row.showAssistantCopyButton,
    streaming: props.row.message.streaming || assistantTurnStillInProgress,
  });

  return (
    <>
      {props.row.showCompletionDivider ? (
        <div className="my-3 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
            {props.completionSummary ? `Response • ${props.completionSummary}` : "Response"}
          </span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div className="min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={props.markdownCwd}
          isStreaming={Boolean(props.row.message.streaming)}
        />
        {props.turnDiffSummary && props.turnDiffSummary.files.length > 0 ? (
          <ChangedFilesSummaryCard
            turnDiffSummary={props.turnDiffSummary}
            allDirectoriesExpanded={props.changedFilesExpanded}
            resolvedTheme={props.resolvedTheme}
            onOpenTurnDiff={props.onOpenTurnDiff}
            onSetChangedFilesExpanded={props.onSetChangedFilesExpanded}
          />
        ) : null}
        <div className="mt-1.5 flex items-center gap-2">
          {props.row.message.streaming ? (
            <LiveAssistantMessageMeta
              createdAt={props.row.message.createdAt}
              durationStart={props.row.durationStart}
              nowIsoOverride={props.nowIso}
              timestampFormat={props.timestampFormat}
            />
          ) : (
            <p className="text-xs text-muted-foreground/50">
              {formatMessageMeta(
                props.row.message.createdAt,
                formatElapsed(props.row.durationStart, props.row.message.completedAt),
                props.timestampFormat,
              )}
            </p>
          )}
          {assistantCopyState.visible ? (
            <div className="flex items-center opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100">
              <MessageCopyButton
                text={assistantCopyState.text ?? ""}
                size="icon-xs"
                variant="outline"
                className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
              />
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
});

const ChangedFilesSummaryCard = memo(function ChangedFilesSummaryCard(props: {
  turnDiffSummary: TurnDiffSummary;
  allDirectoriesExpanded: boolean;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onSetChangedFilesExpanded: (turnId: TurnId, expanded: boolean) => void;
}) {
  const checkpointFiles = props.turnDiffSummary.files;
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({String(checkpointFiles.length)})</span>
          {hasNonZeroStat(summaryStat) ? (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          ) : null}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() =>
              props.onSetChangedFilesExpanded(
                props.turnDiffSummary.turnId,
                !props.allDirectoriesExpanded,
              )
            }
          >
            {props.allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() =>
              props.onOpenTurnDiff(props.turnDiffSummary.turnId, checkpointFiles[0]?.path)
            }
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${props.turnDiffSummary.turnId}`}
        turnId={props.turnDiffSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={props.allDirectoriesExpanded}
        resolvedTheme={props.resolvedTheme}
        onOpenTurnDiff={props.onOpenTurnDiff}
      />
    </div>
  );
});

function areTimelineRowItemPropsEqual(
  previous: Readonly<TimelineRowItemProps>,
  next: Readonly<TimelineRowItemProps>,
): boolean {
  if (previous.row.kind !== next.row.kind || previous.row.id !== next.row.id) {
    return false;
  }

  if (previous.row.kind === "work" && next.row.kind === "work") {
    return (
      previous.isExpandedWorkGroup === next.isExpandedWorkGroup &&
      workEntriesEqual(previous.row.groupedEntries, next.row.groupedEntries)
    );
  }

  if (
    previous.row.kind === "message" &&
    next.row.kind === "message" &&
    previous.row.message.role === "user" &&
    next.row.message.role === "user"
  ) {
    return (
      previous.row.message === next.row.message &&
      previous.canRevertAgentWork === next.canRevertAgentWork &&
      previous.isRevertingCheckpoint === next.isRevertingCheckpoint &&
      previous.isWorking === next.isWorking &&
      previous.timestampFormat === next.timestampFormat
    );
  }

  if (
    previous.row.kind === "message" &&
    next.row.kind === "message" &&
    previous.row.message.role === "assistant" &&
    next.row.message.role === "assistant"
  ) {
    return (
      previous.row.message === next.row.message &&
      previous.row.showCompletionDivider === next.row.showCompletionDivider &&
      previous.completionSummary === next.completionSummary &&
      previous.turnDiffSummary === next.turnDiffSummary &&
      previous.changedFilesExpanded === next.changedFilesExpanded &&
      previous.activeTurnInProgress === next.activeTurnInProgress &&
      previous.activeTurnId === next.activeTurnId &&
      previous.markdownCwd === next.markdownCwd &&
      previous.resolvedTheme === next.resolvedTheme &&
      previous.timestampFormat === next.timestampFormat &&
      previous.nowIso === next.nowIso
    );
  }

  if (previous.row.kind === "proposed-plan" && next.row.kind === "proposed-plan") {
    return (
      previous.row.proposedPlan === next.row.proposedPlan &&
      previous.activeThreadEnvironmentId === next.activeThreadEnvironmentId &&
      previous.markdownCwd === next.markdownCwd &&
      previous.workspaceRoot === next.workspaceRoot
    );
  }

  if (previous.row.kind === "working" && next.row.kind === "working") {
    return previous.row.createdAt === next.row.createdAt && previous.nowIso === next.nowIso;
  }

  return false;
}

function workEntriesEqual(
  previous: ReadonlyArray<TimelineWorkEntry>,
  next: ReadonlyArray<TimelineWorkEntry>,
): boolean {
  return previous.length === next.length && previous.every((entry, index) => entry === next[index]);
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function useNowIso(enabled: boolean, nowIsoOverride?: string): string | null {
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled || nowIsoOverride) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [enabled, nowIsoOverride]);

  if (!enabled) {
    return nowIsoOverride ?? null;
  }

  return nowIsoOverride ?? new Date(nowTick).toISOString();
}

const LiveAssistantMessageMeta = memo(function LiveAssistantMessageMeta(props: {
  createdAt: string;
  durationStart: string | null;
  nowIsoOverride: string | undefined;
  timestampFormat: TimestampFormat;
}) {
  const nowIso = useNowIso(true, props.nowIsoOverride);
  const duration =
    props.durationStart && nowIso ? formatElapsed(props.durationStart, nowIso) : null;

  return (
    <p className="text-xs text-muted-foreground/50">
      {formatMessageMeta(props.createdAt, duration, props.timestampFormat)}
    </p>
  );
});

const LiveWorkingStatus = memo(function LiveWorkingStatus(props: {
  createdAt: string | null;
  nowIsoOverride: string | undefined;
}) {
  const nowIso = useNowIso(Boolean(props.createdAt), props.nowIsoOverride);
  const label =
    props.createdAt && nowIso
      ? `Working for ${formatWorkingTimer(props.createdAt, nowIso) ?? "0s"}`
      : "Working...";

  return (
    <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
      <span className="inline-flex items-center gap-[3px]">
        <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
        <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
        <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
      </span>
      <span>{label}</span>
    </div>
  );
});

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {props.text}
    </div>
  );
});

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  return workEntry.changedFiles!.length === 1
    ? firstPath
    : `${firstPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
}) {
  const { workEntry } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry);
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="max-w-full">
            <p
              className={cn(
                "truncate text-xs leading-5",
                workToneClass(workEntry.tone),
                preview ? "text-muted-foreground/70" : "",
              )}
              title={rawCommand ? undefined : displayText}
            >
              <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                {heading}
              </span>
              {preview &&
                (rawCommand ? (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                ) : (
                  <span className="text-muted-foreground/55"> - {preview}</span>
                ))}
            </p>
          </div>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
