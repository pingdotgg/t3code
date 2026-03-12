import { type MessageId, type TurnId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  measureElement as measureVirtualElement,
  type VirtualItem,
  useVirtualizer,
} from "@tanstack/react-virtual";
import { deriveTimelineEntries, formatElapsed, formatTimestamp } from "../../session-logic";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../chat-scroll";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  DatabaseIcon,
  EyeIcon,
  FileIcon,
  FolderIcon,
  HammerIcon,
  type LucideIcon,
  SearchIcon,
  SquarePenIcon,
  TargetIcon,
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
import { computeMessageDurationStart } from "./MessagesTimeline.logic";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import { basenameOfPath } from "../../vscode-icons";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;
const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 8;

interface MessagesTimelineProps {
  hasMessages: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
  enableCodexToolCallUi: boolean;
  expandedWorkGroups: Record<string, boolean>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  hasMessages,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  enableCodexToolCallUi,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  workspaceRoot,
}: MessagesTimelineProps) {
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
  }, [hasMessages, isWorking]);

  const rows = useMemo<TimelineRow[]>(() => {
    const nextRows: TimelineRow[] = [];
    const durationStartByMessageId = computeMessageDurationStart(
      timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
    );

    for (let index = 0; index < timelineEntries.length; index += 1) {
      const timelineEntry = timelineEntries[index];
      if (!timelineEntry) {
        continue;
      }

      if (timelineEntry.kind === "work") {
        const groupedEntries = [timelineEntry.entry];
        let cursor = index + 1;
        while (cursor < timelineEntries.length) {
          const nextEntry = timelineEntries[cursor];
          if (!nextEntry || nextEntry.kind !== "work") break;
          groupedEntries.push(nextEntry.entry);
          cursor += 1;
        }
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        });
        index = cursor - 1;
        continue;
      }

      if (timelineEntry.kind === "proposed-plan") {
        nextRows.push({
          kind: "proposed-plan",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          proposedPlan: timelineEntry.proposedPlan,
        });
        continue;
      }

      nextRows.push({
        kind: "message",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        durationStart:
          durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
        showCompletionDivider:
          timelineEntry.message.role === "assistant" &&
          completionDividerBeforeEntryId === timelineEntry.id,
      });
    }

    if (isWorking) {
      nextRows.push({
        kind: "working",
        id: "working-indicator-row",
        createdAt: activeTurnStartedAt,
      });
    }

    return nextRows;
  }, [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt]);

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

  const renderRowContent = (row: TimelineRow) => (
    <div
      className="pb-4"
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" &&
        (() => {
          const groupId = row.id;
          const groupedEntries = row.groupedEntries;
          const isExpanded = expandedWorkGroups[groupId] ?? false;
          const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
          const visibleEntries =
            hasOverflow && !isExpanded
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
                  {hasOverflow && (
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
              <div className="space-y-0.5">
                {enableCodexToolCallUi
                  ? visibleEntries.map((workEntry, workEntryIndex) =>
                      isRichToolWorkEntry(workEntry) ? (
                        <ToolWorkEntryRow
                          key={`work-row:${workEntry.id}`}
                          workEntry={workEntry}
                          workEntryIndex={workEntryIndex}
                        />
                      ) : (
                        <SimpleWorkEntryRow
                          key={`work-row:${workEntry.id}`}
                          workEntry={workEntry}
                          workEntryIndex={workEntryIndex}
                        />
                      ),
                    )
                  : visibleEntries.map((workEntry) => (
                      <div
                        key={`work-row:${workEntry.id}`}
                        className="flex items-start gap-2 py-0.5"
                      >
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
                        <div className="min-w-0 flex-1 py-[2px]">
                          <p
                            className={`text-[11px] leading-relaxed ${workToneClass(workEntry.tone)}`}
                          >
                            {workEntry.label}
                          </p>
                          {workEntry.command && (
                            <pre className="mt-1 overflow-x-auto rounded-md border border-border/70 bg-background/80 px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground/80">
                              {workEntry.command}
                            </pre>
                          )}
                          {workEntry.changedFiles && workEntry.changedFiles.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {workEntry.changedFiles.slice(0, 6).map((filePath) => (
                                <span
                                  key={`${workEntry.id}:${filePath}`}
                                  className="rounded-md border border-border/70 bg-background/65 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/85"
                                  title={filePath}
                                >
                                  {filePath}
                                </span>
                              ))}
                              {workEntry.changedFiles.length > 6 && (
                                <span className="px-1 text-[10px] text-muted-foreground/65">
                                  +{workEntry.changedFiles.length - 6} more
                                </span>
                              )}
                            </div>
                          )}
                          {workEntry.detail &&
                            (!workEntry.command || workEntry.detail !== workEntry.command) && (
                              <p
                                className="mt-1 text-[11px] leading-relaxed text-muted-foreground/75"
                                title={workEntry.detail}
                              >
                                {workEntry.detail}
                              </p>
                            )}
                        </div>
                      </div>
                    ))}
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const canRevertAgentWork = revertTurnCountByUserMessageId.has(row.message.id);
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
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
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {row.message.text && (
                  <pre className="whitespace-pre-wrap wrap-break-word font-mono text-sm leading-relaxed text-foreground">
                    {row.message.text}
                  </pre>
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {row.message.text && <MessageCopyButton text={row.message.text} />}
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
                    {formatTimestamp(row.message.createdAt)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
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
                <ChatMarkdown
                  text={messageText}
                  cwd={markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
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
                  )}
                </p>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
          />
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

  if (!hasMessages && !isWorking) {
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

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineProposedPlan = Extract<TimelineEntry, { kind: "proposed-plan" }>["proposedPlan"];
type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];
type TimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: TimelineWorkEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: TimelineMessage;
      durationStart: string;
      showCompletionDivider: boolean;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: TimelineProposedPlan;
    }
  | { kind: "working"; id: string; createdAt: string | null };

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

function formatMessageMeta(createdAt: string, duration: string | null): string {
  if (!duration) return formatTimestamp(createdAt);
  return `${formatTimestamp(createdAt)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): { icon: LucideIcon; className: string } {
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

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  const haystack = [
    workEntry.label,
    workEntry.toolTitle,
    workEntry.detail,
    workEntry.output,
    workEntry.command,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("report_intent") || haystack.includes("intent logged")) {
    return TargetIcon;
  }
  if (
    haystack.includes("bash") ||
    haystack.includes("read_bash") ||
    haystack.includes("write_bash") ||
    haystack.includes("stop_bash") ||
    haystack.includes("list_bash")
  ) {
    return TerminalIcon;
  }
  if (haystack.includes("sql")) return DatabaseIcon;
  if (haystack.includes("view")) return EyeIcon;
  if (haystack.includes("apply_patch")) return SquarePenIcon;
  if (haystack.includes("rg") || haystack.includes("glob") || haystack.includes("search")) {
    return SearchIcon;
  }
  if (haystack.includes("skill")) return ZapIcon;
  if (haystack.includes("ask_user") || haystack.includes("approval")) return BotIcon;
  if (haystack.includes("edit") || haystack.includes("patch")) return WrenchIcon;
  if (haystack.includes("file")) return FileIcon;
  if (haystack.includes("task")) return HammerIcon;
  if (haystack.includes("store_memory")) return FolderIcon;

  switch (workEntry.itemType) {
    case "command_execution":
      return TerminalIcon;
    case "file_change":
      return SquarePenIcon;
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
    case "web_search":
      return SearchIcon;
    case "image_view":
      return EyeIcon;
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

function stripToolCompletionSuffix(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(stripToolCompletionSuffix(workEntry.label));
  }

  if (workEntry.toolStatus === "failed") {
    return capitalizePhrase(`${workEntry.toolTitle} failed`);
  }
  if (workEntry.toolStatus === "declined") {
    return capitalizePhrase(`${workEntry.toolTitle} declined`);
  }
  if (workEntry.toolStatus === "inProgress" || workEntry.activityKind === "tool.updated") {
    return capitalizePhrase(`${workEntry.toolTitle} running`);
  }
  if (workEntry.activityKind === "tool.started") {
    return capitalizePhrase(`${workEntry.toolTitle} started`);
  }
  return capitalizePhrase(workEntry.toolTitle);
}

function primaryWorkEntryPath(workEntry: TimelineWorkEntry): string | null {
  const [firstPath] = workEntry.changedFiles ?? [];
  return firstPath ?? null;
}

function summarizeToolOutput(value: string, limit = 96): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, limit - 3))}...`;
}

function collapsedToolWorkEntryPreview(
  workEntry: TimelineWorkEntry,
  primaryPath: string | null,
): string | null {
  if (workEntry.itemType === "command_execution" || workEntry.requestKind === "command") {
    if (workEntry.output) {
      return summarizeToolOutput(workEntry.output);
    }
    if (workEntry.command) {
      return workEntry.command;
    }
  }
  if (primaryPath) {
    return primaryPath;
  }
  if (workEntry.command) {
    return workEntry.command;
  }
  if (workEntry.output) {
    return summarizeToolOutput(workEntry.output);
  }
  if (workEntry.detail) {
    return summarizeToolOutput(workEntry.detail);
  }
  return null;
}

function isRichToolWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return workEntry.activityKind === "tool.completed" || workEntry.activityKind === "tool.updated";
}

const ToolWorkEntryRow = memo(function ToolWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workEntryIndex: number;
}) {
  const { workEntry, workEntryIndex } = props;
  const [open, setOpen] = useState(false);
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const primaryPath = !workEntry.command ? primaryWorkEntryPath(workEntry) : null;
  const additionalPaths =
    workEntry.changedFiles?.slice(primaryPath ? 1 : 0, primaryPath ? 4 : 4) ?? [];
  const hiddenPathCount =
    (workEntry.changedFiles?.length ?? 0) - additionalPaths.length - (primaryPath ? 1 : 0);
  const preview = collapsedToolWorkEntryPreview(workEntry, primaryPath);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasExpandedDetails = Boolean(
    workEntry.command ||
    primaryPath ||
    additionalPaths.length > 0 ||
    workEntry.output ||
    typeof workEntry.exitCode === "number",
  );

  const summaryRow = (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-1 py-1 transition-colors duration-150",
        hasExpandedDetails ? "hover:bg-accent/25" : "",
      )}
    >
      <ChevronRightIcon
        className={cn(
          "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150",
          !hasExpandedDetails && "opacity-0",
          open && "rotate-90",
        )}
      />
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
          <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>{heading}</span>
          {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
        </p>
      </div>
    </div>
  );

  const expandedDetails = (
    <div className="mt-1 space-y-1.5 pl-10">
      {workEntry.command && (
        <div
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/55 bg-background/55 px-2 py-1"
          title={workEntry.command}
        >
          <TerminalIcon className="size-3 shrink-0 text-muted-foreground/65" />
          <span className="truncate font-mono text-[10px] text-foreground/78">
            {workEntry.command}
          </span>
        </div>
      )}

      {!workEntry.command && primaryPath && (
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge
            variant="outline"
            size="sm"
            className="max-w-32 shrink-0 truncate px-1.5 py-0 text-[10px]"
          >
            {basenameOfPath(primaryPath)}
          </Badge>
          <span
            className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/70"
            title={primaryPath}
          >
            {primaryPath}
          </span>
        </div>
      )}

      {additionalPaths.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {additionalPaths.map((filePath) => (
            <span
              key={`${workEntry.id}:${filePath}`}
              className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
              title={filePath}
            >
              {filePath}
            </span>
          ))}
          {hiddenPathCount > 0 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">+{hiddenPathCount}</span>
          )}
        </div>
      )}

      {workEntry.output && (
        <div className="rounded-md border border-border/55 bg-background/75 px-2.5 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-foreground/78">
            {workEntry.output}
          </pre>
        </div>
      )}

      {typeof workEntry.exitCode === "number" && (
        <div className="text-[9px] font-mono uppercase tracking-[0.12em] text-muted-foreground/55">
          {workEntry.exitCode === 0 ? "Exited successfully" : `Exit ${workEntry.exitCode}`}
        </div>
      )}
    </div>
  );

  if (!hasExpandedDetails) {
    return (
      <div
        className="animate-in fade-in slide-in-from-bottom-1 rounded-lg duration-200"
        style={{
          animationDelay: `${Math.min(workEntryIndex, 4) * 40}ms`,
        }}
      >
        {summaryRow}
      </div>
    );
  }

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 rounded-lg duration-200"
      style={{
        animationDelay: `${Math.min(workEntryIndex, 4) * 40}ms`,
      }}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="block w-full text-left">{summaryRow}</CollapsibleTrigger>
        <CollapsibleContent>{expandedDetails}</CollapsibleContent>
      </Collapsible>
    </div>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workEntryIndex: number;
}) {
  const { workEntry, workEntryIndex } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const preview = workEntryPreview(workEntry);
  const displayText = preview ? `${workEntry.label} - ${preview}` : workEntry.label;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-1 rounded-lg px-1 py-1 duration-200"
      style={{
        animationDelay: `${Math.min(workEntryIndex, 4) * 40}ms`,
      }}
    >
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden animate-in fade-in duration-300">
          <p
            className={cn(
              "truncate text-[11px] leading-5",
              workToneClass(workEntry.tone),
              preview ? "text-muted-foreground/70" : "",
            )}
            title={displayText}
          >
            <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
              {workEntry.label}
            </span>
            {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
          </p>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="animate-in fade-in slide-in-from-bottom-1 mt-1 flex flex-wrap gap-1 pl-6 duration-200">
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
