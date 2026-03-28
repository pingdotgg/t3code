import { type MessageId, type TurnId } from "@t3tools/contracts";
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
import { formatElapsed } from "../../session-logic";
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
import { estimateTimelineMessageHeight } from "../timelineHeight";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  renderableWorkEntryChangedFiles,
  renderableWorkEntryHeading,
  renderableWorkEntryPreview,
  type TimelineRow,
  type TimelineWorkEntry,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
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
import { renderHighlightedText } from "./threadSearchHighlight";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

interface MessagesTimelineProps {
  rows: ReadonlyArray<TimelineRow>;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  activeSearchRowId: string | null;
  matchedSearchRowIds: ReadonlySet<string>;
  searchQuery: string;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  rows,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  activeSearchRowId,
  matchedSearchRowIds,
  searchQuery,
}: MessagesTimelineProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);
  const isWorking = rows.some((row) => row.kind === "working");
  const hasRows = rows.some((row) => row.kind !== "working");

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
  }, [hasRows, isWorking]);

  const firstUnvirtualizedRowIndex = useMemo(() => {
    const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
    if (!activeTurnInProgress) return firstTailRowIndex;

    const turnStartedAtMs =
      typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
    let firstCurrentTurnRowIndex = -1;
    if (!Number.isNaN(turnStartedAtMs)) {
      firstCurrentTurnRowIndex = rows.findIndex((row) => {
        if (row.kind === "working") return true;
        if (!row.createdAt) return false;
        const rowCreatedAtMs = Date.parse(row.createdAt);
        return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
      });
    }

    if (firstCurrentTurnRowIndex < 0) {
      firstCurrentTurnRowIndex = rows.findIndex(
        (row) => row.kind === "message" && row.message.streaming,
      );
    }

    if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

    for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
      const previousRow = rows[index];
      if (!previousRow || previousRow.kind !== "message") continue;
      if (previousRow.message.role === "user") {
        return Math.min(index, firstTailRowIndex);
      }
      if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
        break;
      }
    }

    return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
  }, [activeTurnInProgress, activeTurnStartedAt, rows]);

  const virtualizedRowCount = clamp(firstUnvirtualizedRowIndex, {
    minimum: 0,
    maximum: rows.length,
  });

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Use stable row ids so virtual measurements do not leak across thread switches.
    getItemKey: (index: number) => rows[index]?.id ?? index,
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      if (row.kind === "work") return 112;
      if (row.kind === "proposed-plan") return estimateTimelineProposedPlanHeight(row.proposedPlan);
      if (row.kind === "working") return 40;
      return estimateTimelineMessageHeight(row.message, { timelineWidthPx });
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
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
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

  const rowIndexById = useMemo(
    () => new Map(rows.map((row, index) => [row.id, index] as const)),
    [rows],
  );

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);
  const [allDirectoriesExpandedByTurnId, setAllDirectoriesExpandedByTurnId] = useState<
    Record<string, boolean>
  >({});
  const onToggleAllDirectories = useCallback((turnId: TurnId) => {
    setAllDirectoriesExpandedByTurnId((current) => ({
      ...current,
      [turnId]: !(current[turnId] ?? true),
    }));
  }, []);

  useEffect(() => {
    if (!activeSearchRowId || !scrollContainer) {
      return;
    }

    const rowIndex = rowIndexById.get(activeSearchRowId);
    if (rowIndex === undefined) {
      return;
    }

    if (rowIndex < virtualizedRowCount) {
      rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
    }

    let frame = 0;
    let attempts = 0;
    const scrollMatchedRowIntoView = () => {
      const target = Array.from(
        timelineRootRef.current?.querySelectorAll<HTMLElement>("[data-timeline-row-id]") ?? [],
      ).find((element) => element.dataset.timelineRowId === activeSearchRowId);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "auto" });
        return;
      }
      if (attempts >= 8) {
        return;
      }
      attempts += 1;
      frame = window.requestAnimationFrame(scrollMatchedRowIntoView);
    };

    frame = window.requestAnimationFrame(scrollMatchedRowIntoView);
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeSearchRowId, rowIndexById, rowVirtualizer, scrollContainer, virtualizedRowCount]);

  const renderRowContent = (row: TimelineRow) => {
    const rowSearchState =
      activeSearchRowId === row.id ? "active" : matchedSearchRowIds.has(row.id) ? "matched" : null;
    const rowSearchQuery = rowSearchState ? searchQuery : "";
    const rowSearchActive = rowSearchState === "active";

    return (
      <div
        className="pb-4"
        data-timeline-row-id={row.id}
        data-timeline-row-kind={row.kind}
        data-message-id={row.kind === "message" ? row.message.id : undefined}
        data-message-role={row.kind === "message" ? row.message.role : undefined}
        data-search-match-state={rowSearchState ?? undefined}
      >
        {row.kind === "work" &&
          (() => {
            const groupId = row.id;
            const groupedEntries = row.groupedEntries;
            const isExpanded = expandedWorkGroups[groupId] ?? false;
            const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
            const searchExpanded =
              rowSearchState !== null && rowSearchQuery.trim().length > 0 && hasOverflow;
            const visibleEntries =
              hasOverflow && !isExpanded && !searchExpanded
                ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
                : groupedEntries;
            const hiddenCount = groupedEntries.length - visibleEntries.length;
            const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
            const showHeader = hasOverflow || !onlyToolEntries;
            const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

            return (
              <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
                {showHeader && (
                  <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
                    <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
                      {groupLabel} ({groupedEntries.length})
                    </p>
                    {hasOverflow && !searchExpanded && (
                      <button
                        type="button"
                        className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
                        onClick={() => onToggleWorkGroup(groupId)}
                      >
                        {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-0.5" data-thread-search-content="true">
                  {visibleEntries.map((workEntry) => (
                    <SimpleWorkEntryRow
                      key={`work-row:${workEntry.id}`}
                      workEntry={workEntry}
                      searchQuery={rowSearchQuery}
                      searchActive={rowSearchActive}
                    />
                  ))}
                </div>
              </div>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "user" &&
          (() => {
            const userImages = row.message.attachments ?? [];
            const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
            const terminalContexts = displayedUserMessage.contexts;
            const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
            return (
              <div className="flex justify-end">
                <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                  <div data-thread-search-content="true">
                    {userImages.length > 0 && (
                      <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                        {userImages.map(
                          (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
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
                                    onImageExpand(preview);
                                  }}
                                >
                                  <img
                                    src={image.previewUrl}
                                    alt={image.name}
                                    className="h-full max-h-[220px] w-full object-cover"
                                    onLoad={onTimelineImageLoad}
                                    onError={onTimelineImageLoad}
                                  />
                                </button>
                              ) : (
                                <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                                  {renderHighlightedText(
                                    image.name,
                                    rowSearchQuery,
                                    `user-image-name:${row.id}:${image.id}`,
                                    { active: rowSearchActive },
                                  )}
                                </div>
                              )}
                            </div>
                          ),
                        )}
                      </div>
                    )}
                    {(displayedUserMessage.visibleText.trim().length > 0 ||
                      terminalContexts.length > 0) && (
                      <UserMessageBody
                        text={displayedUserMessage.visibleText}
                        terminalContexts={terminalContexts}
                        searchQuery={rowSearchQuery}
                        searchActive={rowSearchActive}
                      />
                    )}
                  </div>
                  <div className="mt-1.5 flex items-center justify-end gap-2">
                    <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                      {displayedUserMessage.copyText && (
                        <MessageCopyButton text={displayedUserMessage.copyText} />
                      )}
                      {canRevertAgentWork && (
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={isRevertingCheckpoint || isWorking}
                          onClick={() => onRevertUserMessage(row.message.id)}
                          title="Revert to this message"
                        >
                          <Undo2Icon className="size-3" />
                        </Button>
                      )}
                    </div>
                    <p className="text-right text-[10px] text-muted-foreground/30">
                      {formatTimestamp(row.message.createdAt, timestampFormat)}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}

        {row.kind === "message" &&
          row.message.role === "assistant" &&
          (() => {
            const messageText =
              row.message.text || (row.message.streaming ? "" : "(empty response)");
            return (
              <>
                {row.showCompletionDivider && (
                  <div className="my-3 flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                      {completionSummary ? `Response • ${completionSummary}` : "Response"}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div className="min-w-0 px-1 py-0.5">
                  <div data-thread-search-content="true">
                    <ChatMarkdown
                      text={messageText}
                      cwd={markdownCwd}
                      isStreaming={Boolean(row.message.streaming)}
                      searchQuery={rowSearchQuery}
                      searchActive={rowSearchActive}
                    />
                  </div>
                  {(() => {
                    const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                    if (!turnSummary) return null;
                    const checkpointFiles = turnSummary.files;
                    if (checkpointFiles.length === 0) return null;
                    const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                    const changedFileCountLabel = String(checkpointFiles.length);
                    const allDirectoriesExpanded =
                      allDirectoriesExpandedByTurnId[turnSummary.turnId] ?? true;
                    return (
                      <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
                            <span>Changed files ({changedFileCountLabel})</span>
                            {hasNonZeroStat(summaryStat) && (
                              <>
                                <span className="mx-1">•</span>
                                <DiffStatLabel
                                  additions={summaryStat.additions}
                                  deletions={summaryStat.deletions}
                                />
                              </>
                            )}
                          </p>
                          <div className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() => onToggleAllDirectories(turnSummary.turnId)}
                            >
                              {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() =>
                                onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)
                              }
                            >
                              View diff
                            </Button>
                          </div>
                        </div>
                        <ChangedFilesTree
                          key={`changed-files-tree:${turnSummary.turnId}`}
                          turnId={turnSummary.turnId}
                          files={checkpointFiles}
                          allDirectoriesExpanded={allDirectoriesExpanded}
                          resolvedTheme={resolvedTheme}
                          onOpenTurnDiff={onOpenTurnDiff}
                        />
                      </div>
                    );
                  })()}
                  <p className="mt-1.5 text-[10px] text-muted-foreground/30">
                    {formatMessageMeta(
                      row.message.createdAt,
                      row.message.streaming
                        ? formatElapsed(row.durationStart, nowIso)
                        : formatElapsed(row.durationStart, row.message.completedAt),
                      timestampFormat,
                    )}
                  </p>
                </div>
              </>
            );
          })()}

        {row.kind === "proposed-plan" && (
          <div className="min-w-0 px-1 py-0.5">
            <div data-thread-search-content="true">
              <ProposedPlanCard
                planMarkdown={row.proposedPlan.planMarkdown}
                cwd={markdownCwd}
                workspaceRoot={workspaceRoot}
                searchQuery={rowSearchQuery}
                searchActive={rowSearchActive}
              />
            </div>
          </div>
        )}

        {row.kind === "working" && (
          <div className="py-0.5 pl-1.5">
            <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
              <span className="inline-flex items-center gap-[3px]">
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
              </span>
              <span>
                {row.createdAt
                  ? `Working for ${formatWorkingTimer(row.createdAt, nowIso) ?? "0s"}`
                  : "Working..."}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (!hasRows && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {virtualRows.map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index];
            if (!row) return null;

            return (
              <div
                key={`virtual-row:${row.id}`}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderRowContent(row)}
              </div>
            );
          })}
        </div>
      )}

      {nonVirtualizedRows.map((row) => (
        <div key={`non-virtual-row:${row.id}`}>{renderRowContent(row)}</div>
      ))}
    </div>
  );
});

type TimelineMessage = Extract<TimelineRow, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineRow, { kind: "proposed-plan" }>["proposedPlan"];

function estimateTimelineProposedPlanHeight(proposedPlan: TimelineProposedPlan): number {
  const estimatedLines = Math.max(1, Math.ceil(proposedPlan.planMarkdown.length / 72));
  return 120 + Math.min(estimatedLines * 22, 880);
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

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: {
    context: ParsedTerminalContextEntry;
    searchQuery: string;
    searchActive: boolean;
  }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return (
      <TerminalContextInlineChip
        label={props.context.header}
        tooltipText={tooltipText}
        searchQuery={props.searchQuery}
        searchActive={props.searchActive}
      />
    );
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  searchQuery: string;
  searchActive: boolean;
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
              {renderHighlightedText(
                props.text.slice(cursor, matchIndex),
                props.searchQuery,
                `user-terminal-before:${context.header}:${cursor}`,
                { active: props.searchActive },
              )}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
            searchQuery={props.searchQuery}
            searchActive={props.searchActive}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {renderHighlightedText(
                props.text.slice(cursor),
                props.searchQuery,
                `user-terminal-rest:${cursor}`,
                { active: props.searchActive },
              )}
            </span>,
          );
        }

        return (
          <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
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
          searchQuery={props.searchQuery}
          searchActive={props.searchActive}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          {renderHighlightedText(props.text, props.searchQuery, "user-terminal-inline-text", {
            active: props.searchActive,
          })}
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="wrap-break-word whitespace-pre-wrap font-mono text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
      {renderHighlightedText(props.text, props.searchQuery, "user-message-body", {
        active: props.searchActive,
      })}
    </pre>
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

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  searchQuery: string;
  searchActive: boolean;
}) {
  const { workEntry, searchActive, searchQuery } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = renderableWorkEntryHeading(workEntry);
  const preview = renderableWorkEntryPreview(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const visibleChangedFiles = renderableWorkEntryChangedFiles(workEntry);

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <p
            className={cn(
              "truncate text-[11px] leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground/70" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
              {renderHighlightedText(heading, searchQuery, `work-heading:${workEntry.id}`, {
                active: searchActive,
              })}
            </span>
            {preview && (
              <span className="text-muted-foreground/55">
                {" - "}
                {renderHighlightedText(preview, searchQuery, `work-preview:${workEntry.id}`, {
                  active: searchActive,
                })}
              </span>
            )}
          </p>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {visibleChangedFiles.map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {renderHighlightedText(
                filePath,
                searchQuery,
                `work-file:${workEntry.id}:${filePath}`,
                {
                  active: searchActive,
                },
              )}
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
