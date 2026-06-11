import {
  type EnvironmentId,
  type MessageId,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata, Hunk } from "@pierre/diffs/types";
import {
  deriveTimelineEntries,
  formatDuration,
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import {
  formatSubagentDuration,
  formatTerminalSubagentStatusDuration,
  LiveSubagentDuration,
  subagentStatusToneClass,
} from "../../subagentDisplay";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  MessageCircleIcon,
  MinusIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  getRenderableCommandOutputLines,
  hasRenderableCommandOutput,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useStore } from "../../store";
import { formatChatTimestampTooltip, formatShortTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import {
  buildReviewCommentRenderablePatch,
  parseReviewCommentMessageSegments,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import { ThreadConversationWidthContainer } from "./ThreadConversationWidth";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onToggleTurnFold: (turnId: TurnId) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  activeTurnInProgress: boolean;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const COMMAND_OUTPUT_TAIL_LINES = 40;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  latestTurn: TimelineLatestTurn | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
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
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  latestTurn,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
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
  skills = EMPTY_TIMELINE_SKILLS,
  onIsAtEndChange,
}: MessagesTimelineProps) {
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());

  // Toggling a fold inserts/removes rows between the fold row and the final
  // message — everything above the trigger is unchanged, so the trigger stays
  // put as long as the list doesn't re-anchor. maintainScrollAtEnd would do
  // exactly that (pin the bottom content when row data changes while scrolled
  // to the end), yanking the trigger out of view. Suppress it for the frames
  // in which the toggle's data change and item measurements settle.
  const [foldToggleSettling, setFoldToggleSettling] = useState(false);
  const onToggleTurnFold = useCallback((turnId: TurnId) => {
    setFoldToggleSettling(true);
    setExpandedTurnIds((existing) => {
      const next = new Set(existing);
      if (next.has(turnId)) {
        next.delete(turnId);
      } else {
        next.add(turnId);
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (!foldToggleSettling) {
      return;
    }
    let secondFrameId: number | null = null;
    const firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        setFoldToggleSettling(false);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrameId);
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
      }
    };
  }, [foldToggleSettling]);

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const previousLatestTurnRef = useRef(latestTurn);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        expandedTurnIds,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      latestTurn,
      expandedTurnIds,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
      onToggleTurnFold,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      activeTurnInProgress,
    }),
    [activeTurnInProgress, isRevertingCheckpoint, isWorking],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <ThreadConversationWidthContainer
        className="w-full min-w-0 overflow-x-clip"
        data-timeline-root="true"
      >
        <TimelineRowContent row={item} />
      </ThreadConversationWidthContainer>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <LegendList<MessagesTimelineRow>
          ref={listRef}
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={90}
          initialScrollAtEnd
          maintainScrollAtEnd={!foldToggleSettling}
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition
          onScroll={handleScroll}
          className="scrollbar-gutter-both h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
          ListHeaderComponent={TIMELINE_LIST_HEADER}
          ListFooterComponent={TIMELINE_LIST_FOOTER}
        />
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        row.kind === "message" && row.message.role === "assistant" && !row.showAssistantMeta
          ? "pb-2"
          : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection groupedEntries={row.groupedEntries} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages = row.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3">
        {userImages.length > 0 && (
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
                      ctx.onImageExpand(preview);
                    }}
                  >
                    <img
                      src={image.previewUrl}
                      alt={image.name}
                      className="block h-auto max-h-[220px] w-full object-cover"
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
        )}
        <CollapsibleUserMessageBody
          text={displayedUserMessage.visibleText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
              {formatShortTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </TooltipTrigger>
            <TooltipPopup>
              {formatChatTimestampTooltip(row.message.createdAt, ctx.timestampFormat)}
            </TooltipPopup>
          </Tooltip>
          <div className="flex items-center gap-0.5">
            {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} variant="ghost" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={() => ctx.onRevertUserMessage(messageId)}
            aria-label="Revert to this message"
          />
        }
      >
        <Undo2Icon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">Revert to this message</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex items-center gap-1 px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        <ChatMarkdown
          text={messageText}
          cwd={ctx.markdownCwd}
          isStreaming={Boolean(row.message.streaming)}
          skills={ctx.skills}
        />
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          routeThreadKey={ctx.routeThreadKey}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {row.showAssistantMeta ? (
          <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <AssistantCopyButton row={row} />
            {!row.message.streaming && (
              <Tooltip>
                <TooltipTrigger
                  render={<p className="text-muted-foreground text-xs tabular-nums" />}
                >
                  {formatShortTimestamp(
                    row.message.completedAt ?? row.message.createdAt,
                    ctx.timestampFormat,
                  )}
                </TooltipTrigger>
                <TooltipPopup>
                  {formatChatTimestampTooltip(
                    row.message.completedAt ?? row.message.createdAt,
                    ctx.timestampFormat,
                  )}
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 tabular-nums">
        <span className="inline-flex items-center gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
          <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
        </span>
        <span>
          {row.createdAt ? (
            <>
              Working for <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            "Working..."
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return (
    <span ref={textRef} className="tabular-nums">
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Collapsed state shows the earliest chunk so "Show more" only appends rows downward. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry)),
    [groupedEntries],
  );
  const hasOverflow = nonEmptyEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? nonEmptyEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : nonEmptyEntries;
  const hiddenCount = nonEmptyEntries.length - visibleEntries.length;
  const onlyToolEntries = nonEmptyEntries.every((entry) => workLogEntryIsToolLike(entry));
  const headerTitle = onlyToolEntries
    ? nonEmptyEntries.length === 1
      ? "1 tool call"
      : `${nonEmptyEntries.length} tool calls`
    : "work log";

  if (nonEmptyEntries.length === 0) return null;

  return (
    <div className="rounded-2xl border border-input bg-background p-2 pt-3 shadow-xs/5 not-dark:bg-clip-padding dark:bg-input/32">
      <div className="mb-2 flex items-center justify-between gap-2 px-2">
        <p className="font-medium text-foreground text-xs">{headerTitle}</p>
        {hasOverflow && (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs transition-colors duration-150 hover:text-foreground/80"
            onClick={() => setIsExpanded((v) => !v)}
          >
            {isExpanded ? (
              <>
                Show less
                <ChevronUpIcon className="size-3.5 shrink-0 opacity-80" />
              </>
            ) : (
              <>
                Show {hiddenCount} more
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-80" />
              </>
            )}
          </button>
        )}
      </div>
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </div>
  );
});

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const allDirectoriesExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="sticky top-2 z-10 mb-1.5 flex items-center justify-between gap-2 bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:content-['']">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
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
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
            markdownCwd={props.markdownCwd}
          />
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  markdownCwd: string | undefined;
}) {
  const renderInlineMarkdownSegment = (text: string, key: string) => {
    const leadingWhitespace = /^\s+/.exec(text)?.[0] ?? "";
    const textWithoutLeadingWhitespace = text.slice(leadingWhitespace.length);
    const trailingWhitespace = /\s+$/.exec(textWithoutLeadingWhitespace)?.[0] ?? "";
    const content = textWithoutLeadingWhitespace.slice(
      0,
      textWithoutLeadingWhitespace.length - trailingWhitespace.length,
    );

    return (
      <Fragment key={key}>
        {leadingWhitespace ? <span aria-hidden="true">{leadingWhitespace}</span> : null}
        {content ? (
          <ChatMarkdown
            text={content}
            cwd={props.markdownCwd}
            skills={props.skills}
            className="text-foreground"
            lineBreaks
          />
        ) : null}
        {trailingWhitespace ? <span aria-hidden="true">{trailingWhitespace}</span> : null}
      </Fragment>
    );
  };

  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-sm leading-relaxed text-foreground">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="wrap-break-word">
                <ChatMarkdown
                  text={segment.text.trim()}
                  cwd={props.markdownCwd}
                  skills={props.skills}
                  className="text-foreground"
                  lineBreaks
                />
              </div>
            ) : null
          ) : (
            <UserMessageReviewCommentCard key={segment.comment.id} comment={segment.comment} />
          ),
        )}
      </div>
    );
  }

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
            renderInlineMarkdownSegment(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
            ),
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
            renderInlineMarkdownSegment(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
            ),
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
      inlineNodes.push(
        <ChatMarkdown
          key="user-message-terminal-context-inline-text"
          text={props.text}
          cwd={props.markdownCwd}
          skills={props.skills}
          className="text-foreground"
          lineBreaks
        />,
      );
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
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      skills={props.skills}
      className="text-foreground"
      lineBreaks
    />
  );
});

function UserMessageReviewCommentCard({ comment }: { comment: ReviewCommentContext }) {
  const ctx = use(TimelineRowCtx);
  const renderablePatch = getRenderablePatch(
    buildReviewCommentRenderablePatch(comment),
    `review-comment:${comment.id}`,
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-background/70 p-3">
      <div className="space-y-1">
        <div className="text-xs font-medium text-foreground">
          {formatWorkspaceRelativePath(comment.filePath, ctx.workspaceRoot)}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {comment.sectionTitle} · {comment.rangeLabel}
        </div>
      </div>
      {comment.text.length > 0 && (
        <div className="whitespace-pre-wrap wrap-break-word text-sm">
          <SkillInlineText text={comment.text} skills={ctx.skills} />
        </div>
      )}
      {renderablePatch?.kind === "files" &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs">
          {renderablePatch.text}
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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

function formatWorkingTimerNow(startIso: string): string {
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

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
      className: "text-muted-foreground",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "detail"
    | "command"
    | "changedFiles"
    | "itemType"
    | "output"
    | "subagentPrompt"
    | "subagentChildren"
  >,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if ((workEntry.subagentChildren?.length ?? 0) > 0) return null;
  if (workEntry.itemType === "collab_agent_tool_call") {
    const { prompt, output } = resolveSubagentDisplayParts(workEntry);
    return prompt ?? output;
  }
  if (workEntry.subagentPrompt) return workEntry.subagentPrompt;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
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

function buildToolCallExpandedBody(workEntry: TimelineWorkEntry): string | null {
  const blocks: string[] = [];
  if (workEntry.detail?.trim()) {
    blocks.push(workEntry.detail.trim());
  }
  const raw = workEntryRawCommand(workEntry);
  if (raw?.trim()) {
    blocks.push(`Full command\n${raw.trim()}`);
  } else if (workEntry.command?.trim()) {
    blocks.push(`Command\n${workEntry.command.trim()}`);
  }
  if (blocks.length === 0) {
    return null;
  }
  return blocks.join("\n\n");
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (
    workEntry.sourceActivityKind === "user-input.requested" ||
    workEntry.sourceActivityKind === "user-input.resolved"
  ) {
    return MessageCircleIcon;
  }
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

function ToolDetailBlock(props: {
  title: string;
  children: ReactNode;
  mono?: boolean;
  tone?: "default" | "error";
}) {
  return (
    <div className="space-y-1">
      <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55">
        {props.title}
      </p>
      <div
        className={cn(
          "max-h-80 overflow-auto rounded-md border border-border/55 bg-background/80 px-2 py-1.5 text-[11px] leading-5 text-foreground/78",
          props.mono && "font-mono whitespace-pre-wrap wrap-break-word",
          props.tone === "error" &&
            "border-rose-500/20 bg-rose-500/5 text-rose-800 dark:text-rose-200",
        )}
      >
        {props.children}
      </div>
    </div>
  );
}

function normalizedSubagentText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function resolveSubagentDisplayParts(
  workEntry: Pick<TimelineWorkEntry, "output" | "subagentPrompt">,
): {
  prompt: string | null;
  output: string | null;
} {
  const prompt = workEntry.subagentPrompt?.trim() ?? "";
  const output = workEntry.output?.trim() ?? "";
  if (!prompt) {
    return { prompt: null, output: output || null };
  }
  if (!output) {
    return { prompt, output: null };
  }

  const normalizedPrompt = normalizedSubagentText(prompt).toLowerCase();
  const normalizedOutput = normalizedSubagentText(output).toLowerCase();
  const redundantPrompt =
    normalizedPrompt === normalizedOutput ||
    normalizedPrompt.startsWith(normalizedOutput) ||
    normalizedOutput.startsWith(normalizedPrompt);

  return {
    prompt: redundantPrompt ? null : prompt,
    output,
  };
}

function hasExpandableWorkEntryDetails(workEntry: TimelineWorkEntry): boolean {
  if (hasCommandWorkEntryDetails(workEntry) || hasFileChangeWorkEntryDetails(workEntry)) {
    return true;
  }
  if (workEntry.itemType === "collab_agent_tool_call") {
    if ((workEntry.subagentChildren?.length ?? 0) > 0) {
      return false;
    }
    const { prompt, output } = resolveSubagentDisplayParts(workEntry);
    return Boolean(prompt || output);
  }
  return buildToolCallExpandedBody(workEntry) !== null;
}

function ToolEntryDetails({ workEntry }: { workEntry: TimelineWorkEntry }) {
  const showCommandDetails = hasCommandWorkEntryDetails(workEntry);
  const showFileChangeDetails = hasFileChangeWorkEntryDetails(workEntry);
  const supplementalDetails =
    showCommandDetails || showFileChangeDetails
      ? buildSupplementalToolDetailBody(workEntry)
      : null;
  if (showCommandDetails || showFileChangeDetails) {
    return (
      <>
        {showCommandDetails && <CommandEntryDetails workEntry={workEntry} />}
        {showFileChangeDetails && <FileChangeEntryDetails workEntry={workEntry} />}
        {supplementalDetails ? <GenericToolEntryDetails value={supplementalDetails} /> : null}
      </>
    );
  }

  const { prompt, output } =
    workEntry.itemType === "collab_agent_tool_call"
      ? resolveSubagentDisplayParts(workEntry)
      : { prompt: null, output: null };
  if (!prompt && !output) {
    const genericDetails = buildToolCallExpandedBody(workEntry);
    return genericDetails ? <GenericToolEntryDetails value={genericDetails} /> : null;
  }
  return (
    <div className="mt-2 ms-7 space-y-2 border-s border-border/45 ps-3 pt-0.5">
      {prompt && (
        <ToolDetailBlock title="Prompt" mono>
          {prompt}
        </ToolDetailBlock>
      )}
      {output && (
        <ToolDetailBlock title="Output" mono>
          {output}
        </ToolDetailBlock>
      )}
    </div>
  );
}

function buildSupplementalToolDetailBody(workEntry: TimelineWorkEntry): string | null {
  const detail = workEntry.detail?.trim();
  if (!detail) {
    return null;
  }
  const command = workEntry.command?.trim();
  const rawCommand = workEntry.rawCommand?.trim();
  if (detail === command || detail === rawCommand) {
    return null;
  }
  return detail;
}

function hasCommandWorkEntryDetails(workEntry: TimelineWorkEntry): boolean {
  if (!hasCommandWorkEntryMetadata(workEntry)) {
    return false;
  }
  if (workEntry.itemType === "command_execution" || workEntry.requestKind === "command") {
    return true;
  }
  if (
    workEntry.itemType === "file_change" ||
    workEntry.itemType === "collab_agent_tool_call" ||
    workEntry.requestKind === "file-change"
  ) {
    return false;
  }
  if (workEntry.itemType || workEntry.requestKind) {
    return workEntry.itemType === "dynamic_tool_call" || workEntry.itemType === "mcp_tool_call";
  }
  return hasCommandWorkEntryCommand(workEntry);
}

function hasCommandWorkEntryMetadata(workEntry: TimelineWorkEntry): boolean {
  return Boolean(
    workEntry.command ||
    workEntry.rawCommand ||
    workEntry.output ||
    workEntry.stdout ||
    workEntry.stderr ||
    workEntry.exitCode !== undefined ||
    workEntry.durationMs !== undefined,
  );
}

function hasCommandWorkEntryCommand(workEntry: TimelineWorkEntry): boolean {
  return Boolean(workEntry.command || workEntry.rawCommand);
}

function hasFileChangeWorkEntryDetails(workEntry: TimelineWorkEntry): boolean {
  if (workEntry.itemType === "file_change" || workEntry.requestKind === "file-change") {
    return Boolean(workEntry.patch || (workEntry.changedFiles?.length ?? 0) > 0);
  }
  if (workEntry.itemType === "collab_agent_tool_call") {
    return false;
  }
  return Boolean(workEntry.patch || (workEntry.changedFiles?.length ?? 0) > 0);
}

function CommandEntryDetails({ workEntry }: { workEntry: TimelineWorkEntry }) {
  const command = workEntry.command ?? workEntry.rawCommand ?? null;
  const rawCommand =
    workEntry.rawCommand && workEntry.rawCommand !== command ? workEntry.rawCommand : null;
  const hasStreamOutput =
    hasRenderableCommandOutput(workEntry.stdout) || hasRenderableCommandOutput(workEntry.stderr);

  return (
    <div className="mt-2 ms-7 space-y-2 border-s border-border/45 ps-3 pt-0.5">
      {command && (
        <ToolDetailBlock title="Command" mono>
          {command}
        </ToolDetailBlock>
      )}
      {rawCommand && <CollapsedRawCommandBlock value={rawCommand} />}
      <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5">
          Exit code {workEntry.exitCode ?? "unknown"}
        </span>
        <span className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5">
          Duration{" "}
          {workEntry.durationMs !== undefined ? formatDuration(workEntry.durationMs) : "unknown"}
        </span>
      </div>
      {hasRenderableCommandOutput(workEntry.stdout) ? (
        <CommandOutputBlock title="Stdout" value={workEntry.stdout} />
      ) : null}
      {hasRenderableCommandOutput(workEntry.stderr) ? (
        <CommandOutputBlock title="Stderr" value={workEntry.stderr} tone="error" />
      ) : null}
      {!hasStreamOutput && hasRenderableCommandOutput(workEntry.output) ? (
        <CommandOutputBlock title="Output" value={workEntry.output} />
      ) : null}
    </div>
  );
}

function CollapsedRawCommandBlock({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55 transition-colors hover:text-foreground/75 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span>Raw command</span>
        <span className="normal-case tracking-normal">({expanded ? "hide" : "show"})</span>
      </button>
      {expanded ? (
        <div className="max-h-80 overflow-auto rounded-md border border-border/55 bg-background/80 px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre-wrap wrap-break-word text-foreground/78">
          {value}
        </div>
      ) : null}
    </div>
  );
}

function CommandOutputBlock(props: { title: string; value: string; tone?: "default" | "error" }) {
  const [showFull, setShowFull] = useState(false);
  const lines = useMemo(() => getRenderableCommandOutputLines(props.value), [props.value]);
  const isTruncated = lines.length > COMMAND_OUTPUT_TAIL_LINES;
  const toggleLabel = `${showFull ? "Collapse" : "Expand"} ${props.title}`;
  const visibleValue =
    showFull || !isTruncated
      ? lines.join("\n")
      : lines.slice(-COMMAND_OUTPUT_TAIL_LINES).join("\n");
  const suffix = isTruncated
    ? showFull
      ? `${lines.length.toLocaleString()} lines`
      : `last ${COMMAND_OUTPUT_TAIL_LINES} of ${lines.length.toLocaleString()} lines`
    : `${lines.length.toLocaleString()} line${lines.length === 1 ? "" : "s"}`;

  return (
    <div className="space-y-1">
      <button
        type="button"
        className={cn(
          "flex items-center gap-1 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/55 transition-colors focus-visible:outline-2 focus-visible:outline-ring",
          isTruncated ? "cursor-pointer hover:text-foreground/75" : "cursor-default",
        )}
        disabled={!isTruncated}
        aria-expanded={isTruncated ? showFull : undefined}
        aria-label={isTruncated ? toggleLabel : `${props.title} output`}
        onClick={() => {
          if (isTruncated) {
            setShowFull((value) => !value);
          }
        }}
      >
        <span>{props.title}</span>
        <span className="normal-case tracking-normal">({suffix})</span>
      </button>
      <button
        type="button"
        className={cn(
          "block max-h-80 w-full overflow-auto rounded-md border border-border/55 bg-background/80 px-2 py-1.5 text-left font-mono text-[11px] leading-5 whitespace-pre-wrap wrap-break-word text-foreground/78",
          props.tone === "error" &&
            "border-rose-500/20 bg-rose-500/5 text-rose-800 dark:text-rose-200",
          isTruncated ? "cursor-pointer" : "cursor-default",
        )}
        disabled={!isTruncated}
        aria-expanded={isTruncated ? showFull : undefined}
        aria-label={isTruncated ? toggleLabel : `${props.title} output`}
        onClick={() => {
          if (isTruncated) {
            setShowFull((value) => !value);
          }
        }}
      >
        {visibleValue}
      </button>
    </div>
  );
}

function FileChangeEntryDetails({ workEntry }: { workEntry: TimelineWorkEntry }) {
  const ctx = use(TimelineRowCtx);
  const renderablePatch = getRenderablePatch(
    workEntry.patch,
    `tool-file-change:${workEntry.id}:${ctx.resolvedTheme}`,
  );
  const hasInlineDiff = renderablePatch?.kind === "files";

  return (
    <div className="mt-2 ms-7 space-y-2 border-s border-border/45 ps-3 pt-0.5">
      {!hasInlineDiff && (workEntry.changedFiles?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          {workEntry.changedFiles?.map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, ctx.workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:expanded-file:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
        </div>
      )}
      {hasInlineDiff &&
        renderablePatch.files.map((fileDiff) => (
          <FileDiff
            key={resolveFileDiffPath(fileDiff)}
            fileDiff={fileDiff}
            renderCustomHeader={(renderedFileDiff) => (
              <InlineFileDiffHeader
                fileDiff={renderedFileDiff}
                changedFiles={workEntry.changedFiles}
                workspaceRoot={ctx.workspaceRoot}
              />
            )}
            options={{
              collapsed: false,
              diffStyle: "unified",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
            }}
          />
        ))}
      {renderablePatch?.kind === "raw" && (
        <ToolDetailBlock title={renderablePatch.reason} mono>
          {renderablePatch.text}
        </ToolDetailBlock>
      )}
    </div>
  );
}

function GenericToolEntryDetails({ value }: { value: string }) {
  return (
    <div className="mt-2 ms-7 border-s border-border/45 ps-3 pt-0.5">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
        {value}
      </pre>
    </div>
  );
}

function InlineFileDiffHeader({
  fileDiff,
  changedFiles,
  workspaceRoot,
}: {
  fileDiff: FileDiffMetadata;
  changedFiles: ReadonlyArray<string> | undefined;
  workspaceRoot: string | undefined;
}) {
  const displayPath = resolveInlineFileDiffDisplayPath(fileDiff, changedFiles, workspaceRoot);
  const additions = countDiffHunkChangedLines(fileDiff.hunks, "additionLines");
  const deletions = countDiffHunkChangedLines(fileDiff.hunks, "deletionLines");

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/55 bg-background/80 px-2 py-1 text-[11px]">
      <span className="min-w-0 truncate font-mono text-foreground/85" title={displayPath}>
        {displayPath}
      </span>
      <span className="shrink-0">
        <DiffStatLabel additions={additions} deletions={deletions} />
      </span>
    </div>
  );
}

function resolveInlineFileDiffDisplayPath(
  fileDiff: FileDiffMetadata,
  changedFiles: ReadonlyArray<string> | undefined,
  workspaceRoot: string | undefined,
): string {
  const rawPath = resolveFileDiffPath(fileDiff);
  const normalizedRawPath = rawPath.replace(/\\/gu, "/");
  const matchedChangedFile = changedFiles?.find((filePath) => {
    const normalizedChangedFile = filePath.replace(/\\/gu, "/");
    return (
      normalizedChangedFile === normalizedRawPath ||
      normalizedChangedFile.endsWith(`/${normalizedRawPath}`) ||
      normalizedRawPath.endsWith(`/${normalizedChangedFile.replace(/^\/+/u, "")}`)
    );
  });

  return formatWorkspaceRelativePath(matchedChangedFile ?? rawPath, workspaceRoot);
}

function countDiffHunkChangedLines(
  hunks: ReadonlyArray<Hunk>,
  lineCountKey: "additionLines" | "deletionLines",
): number {
  let count = 0;
  for (const hunk of hunks) {
    count += hunk[lineCountKey];
  }
  return count;
}

const stopRowToggle = (e: { stopPropagation: () => void }) => e.stopPropagation();

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const activity = use(TimelineRowActivityCtx);
  const [expanded, setExpanded] = useState(false);
  if (workEntry.itemType === "collab_agent_tool_call" && workEntry.subagentChildren?.length) {
    return <SubagentWorkEntryRows workEntry={workEntry} />;
  }
  const iconConfig = workToneIcon(workEntry.tone);
  const showWarningIndicator = workEntry.sourceActivityKind === "runtime.warning";
  const EntryIcon = showWarningIndicator ? XIcon : workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const canExpand = hasExpandableWorkEntryDetails(workEntry);
  const toggleExpanded = useCallback(() => {
    if (!canExpand) {
      return;
    }
    setExpanded((value) => !value);
  }, [canExpand]);
  const showFailedIndicator = workEntryIndicatesToolFailure(workEntry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (workEntry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(workEntry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : workEntry.tone === "tool" || showFailedIndicator
          ? "text-muted-foreground"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground";
  const turnSettled = !activity.activeTurnInProgress;
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(workEntry);
  const showSuccessIndicator =
    workEntryIndicatesToolSuccess(workEntry) ||
    (turnSettled && workEntryIndicatesToolNeutralStatus(workEntry));
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-expanded": expanded,
        "aria-label": expanded ? `Collapse ${heading}` : `Expand ${heading}`,
        onClick: toggleExpanded,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleExpanded();
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border border-transparent px-2 py-2 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
      )}
      data-tool-entry-expanded={expanded ? "true" : "false"}
      {...rowToggleProps}
    >
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <EntryIcon className="block size-3.5 shrink-0" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0 flex-1 overflow-hidden">
            {rawCommand ? (
              <div className="max-w-full">
                <Tooltip>
                  <TooltipTrigger
                    closeDelay={0}
                    delay={75}
                    render={
                      <p
                        className="flex min-w-0 w-full items-center gap-2 text-xs leading-5"
                        aria-label={displayText}
                      />
                    }
                  >
                    <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
                    {preview && (
                      <span className="min-w-0 flex-1 cursor-default truncate text-muted-foreground transition-colors hover:text-muted-foreground/90 focus-visible:text-muted-foreground/90">
                        {preview}
                      </span>
                    )}
                  </TooltipTrigger>
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
              </div>
            ) : (
              <Tooltip>
                <TooltipTrigger className="block min-w-0 w-full text-left" aria-label={displayText}>
                  <p className="flex min-w-0 w-full items-center gap-2 text-[11px] leading-5">
                    <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
                    {preview && (
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {preview}
                      </span>
                    )}
                  </p>
                </TooltipTrigger>
                <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                  <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                    {displayText}
                  </p>
                </TooltipPopup>
              </Tooltip>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <span
              className="flex size-5 shrink-0 items-center justify-center"
              aria-hidden={!canExpand}
            >
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground opacity-80 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span className="flex size-5 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-5 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3.5 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-5 items-center justify-center" />}
                  >
                    <span className="inline-flex size-5 items-center justify-center text-muted-foreground">
                      <CheckIcon
                        className="block size-3.5 shrink-0 stroke-current"
                        stroke="currentColor"
                        aria-hidden
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="flex size-5 items-center justify-center" />}
                  >
                    <MinusIcon
                      className="block size-3.5 shrink-0 text-muted-foreground opacity-80"
                      aria-hidden
                    />
                  </TooltipTrigger>
                  <TooltipPopup>Empty</TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div
          className="mt-1 flex flex-wrap gap-1"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <Tooltip key={`${workEntry.id}:${filePath}`}>
                <TooltipTrigger
                  render={
                    <span
                      className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                      aria-label={displayPath}
                    />
                  }
                >
                  {displayPath}
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-[min(40rem,calc(100vw-2rem))]">
                  <span className="font-mono text-[11px] whitespace-nowrap">{displayPath}</span>
                </TooltipPopup>
              </Tooltip>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
      {canExpand && expanded ? (
        <div onClick={stopRowToggle} onPointerDown={stopRowToggle}>
          <ToolEntryDetails workEntry={workEntry} />
        </div>
      ) : null}
    </div>
  );
});

const SubagentWorkEntryRows = memo(function SubagentWorkEntryRows({
  workEntry,
}: {
  workEntry: TimelineWorkEntry;
}) {
  return (
    <div className="space-y-1 py-0.5">
      {workEntry.subagentChildren?.map((child) => (
        <SubagentWorkEntryButton
          key={`${workEntry.id}:subagent:${child.threadId}`}
          parentCreatedAt={workEntry.createdAt}
          threadId={child.threadId}
          {...((child.titleSeed ?? workEntry.subagentPrompt ?? workEntry.detail)
            ? { titleSeed: child.titleSeed ?? workEntry.subagentPrompt ?? workEntry.detail }
            : {})}
        />
      ))}
    </div>
  );
});

const SubagentWorkEntryButton = memo(function SubagentWorkEntryButton(props: {
  parentCreatedAt: string;
  threadId: ThreadId;
  titleSeed?: string;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  const childShell = useStore(
    useCallback(
      (state) =>
        state.environmentStateById[ctx.activeThreadEnvironmentId]?.threadShellById[props.threadId],
      [ctx.activeThreadEnvironmentId, props.threadId],
    ),
  );
  const relation =
    childShell?.parentRelation?.kind === "subagent" ? childShell.parentRelation : null;
  const rawTitle = childShell?.title?.trim();
  const title = rawTitle && rawTitle !== "Subagent" ? rawTitle : null;
  const displayTitle = title ? `Subagent - ${title}` : "Subagent";
  const status = relation?.status ?? null;
  const startedAt = relation?.startedAt ?? props.parentCreatedAt;
  const completedAt = relation?.completedAt ?? null;
  const statusDurationLabel =
    status === "running" ? (
      <LiveSubagentDuration startedAt={startedAt} />
    ) : (
      formatTerminalSubagentStatusDuration(status, formatSubagentDuration(startedAt, completedAt))
    );

  const openChildThread = useCallback(() => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(ctx.activeThreadEnvironmentId, props.threadId)),
    });
  }, [ctx.activeThreadEnvironmentId, navigate, props.threadId]);

  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-background/55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={openChildThread}
      title={`Open ${displayTitle}`}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border",
          subagentStatusToneClass(status),
        )}
        aria-hidden="true"
      >
        <BotIcon className="size-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground/82">
          {displayTitle}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground/62">
          {statusDurationLabel}
        </span>
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-foreground/75" />
    </button>
  );
});
