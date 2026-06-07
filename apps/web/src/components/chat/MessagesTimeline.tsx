import {
  type EnvironmentId,
  type MessageId,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  INLINE_DIFF_RENDER_UNSAFE_CSS,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { useCheckpointDiff } from "../../lib/checkpointDiffState";
import ChatMarkdown from "../ChatMarkdown";
import {
  IconAlertCircle as CircleAlertIcon,
  IconArrowBackUp as Undo2Icon,
  IconCheck as CheckIcon,
  IconChevronDown as ChevronDownIcon,
  IconChevronRight as ChevronRightIcon,
  IconPencil as SquarePenIcon,
  IconSearch as SearchIcon,
  IconTerminal2 as TerminalIcon,
  IconTool as WrenchIcon,
  type Icon as TablerIcon,
} from "@tabler/icons-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type TimelineActivityEntry,
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
import { formatTimestamp } from "../../timestampFormat";

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
import {
  deriveWorkActivityDisplayEntries,
  type WorkActivityCategory,
  type WorkActivitySummary,
} from "./workActivitySummary";

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
  activeThreadId: ThreadId;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
type DiffThemeType = "light" | "dark";

function TimelineMessageCopyButton({ text }: { text: string }) {
  return (
    <MessageCopyButton
      text={text}
      size="icon-xs"
      variant="ghost"
      className="text-muted-foreground/60 hover:text-foreground"
    />
  );
}

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  completionSummaryTurnId?: TurnId | null;
  completionSummaryStartedAt?: string | null;
  completionSummaryCompletedAt?: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
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
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  completionSummaryTurnId,
  completionSummaryStartedAt,
  completionSummaryCompletedAt,
  turnDiffSummaryByAssistantMessageId,
  turnDiffSummaryByTurnId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  activeThreadId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  onIsAtEndChange,
}: MessagesTimelineProps) {
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        completionSummary,
        completionSummaryTurnId: completionSummaryTurnId ?? null,
        completionSummaryStartedAt: completionSummaryStartedAt ?? null,
        completionSummaryCompletedAt: completionSummaryCompletedAt ?? null,
        isWorking,
        activeTurnInProgress,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      completionSummaryTurnId,
      completionSummaryStartedAt,
      completionSummaryCompletedAt,
      isWorking,
      activeTurnInProgress,
      activeTurnId,
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
      activeThreadId,
      turnDiffSummaryByTurnId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      activeThreadId,
      turnDiffSummaryByTurnId,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
    }),
    [isRevertingCheckpoint, isWorking],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
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
          maintainScrollAtEnd
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition
          onScroll={handleScroll}
          className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
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
type TimelineRow = MessagesTimelineRow;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
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
        <WorkGroupSection
          rowId={row.id}
          groupedEntries={row.groupedEntries}
          completionSummary={row.completionSummary}
          activeStartedAt={row.activeStartedAt}
        />
      ) : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
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
    <div className="group/user flex justify-end">
      <div className="max-w-[80%]">
        <div className="relative rounded-2xl rounded-br-md bg-secondary px-4 py-3">
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
          />
        </div>
        <div className="mt-1 flex min-h-6 items-center justify-end gap-2 pr-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/user:opacity-100">
          <p className="text-right text-xs text-muted-foreground/55">
            {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
          </p>
          {displayedUserMessage.copyText && (
            <TimelineMessageCopyButton text={displayedUserMessage.copyText} />
          )}
          {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
        </div>
      </div>
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="text-muted-foreground/60 hover:text-foreground"
      aria-label="Revert to this message"
      disabled={activity.isRevertingCheckpoint || activity.isWorking}
      onClick={() => ctx.onRevertUserMessage(messageId)}
      title="Revert to this message"
    >
      <Undo2Icon className="size-3" />
    </Button>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");

  return (
    <div className="group/assistant-message min-w-0 px-1 py-0.5">
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
      <div
        className={cn(
          "mt-1.5 flex min-h-5 items-center gap-2 transition-opacity duration-150",
          row.message.streaming
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-hover/assistant-message:opacity-100",
        )}
      >
        <p className="text-[10px] text-muted-foreground/30">
          {row.message.streaming ? (
            <LiveMessageMeta
              createdAt={row.message.createdAt}
              durationStart={row.durationStart}
              timestampFormat={ctx.timestampFormat}
            />
          ) : (
            formatMessageMeta(
              row.message.createdAt,
              formatElapsed(row.durationStart, row.message.completedAt),
              ctx.timestampFormat,
            )
          )}
        </p>
        <AssistantCopyButton row={row} />
      </div>
    </div>
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

  return <TimelineMessageCopyButton text={assistantCopyState.text ?? ""} />;
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

  return <span ref={textRef}>{initialText}</span>;
}

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
        );
      }
    };
    updateText();
    if (!durationStart) {
      return;
    }
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt, durationStart, timestampFormat]);

  return <span ref={textRef}>{initialText}</span>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Owns its own expand/collapse state so toggling re-renders only this row.
 *  State resets on unmount which is fine — work groups start collapsed. */
const WorkGroupSection = memo(function WorkGroupSection({
  rowId,
  groupedEntries,
  completionSummary,
  activeStartedAt,
}: {
  rowId: string;
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  completionSummary: string | null;
  activeStartedAt: string | null;
}) {
  const { routeThreadKey, workspaceRoot } = use(TimelineRowCtx);
  const isExpanded = useUiStateStore(
    (store) => store.threadWorkGroupExpandedById[routeThreadKey]?.[rowId] ?? false,
  );
  const setWorkGroupExpanded = useUiStateStore((store) => store.setThreadWorkGroupExpanded);
  const groupLabel = formatWorkGroupSummary(groupedEntries, completionSummary);
  const isActive = activeStartedAt !== null;
  const visibleEntries = groupedEntries.filter(
    (entry) => entry.kind !== "work" || entry.workEntry.hidden !== true,
  );
  const displayEntries = useMemo(
    () => deriveWorkActivityDisplayEntries(visibleEntries, workspaceRoot),
    [visibleEntries, workspaceRoot],
  );
  const showExpandedEntries = isActive || isExpanded;

  return (
    <div className="my-2" data-work-group-expanded={showExpandedEntries ? "true" : "false"}>
      {isActive ? (
        <div className="flex w-full items-center gap-2 py-1 text-left">
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground/70">
            {activeStartedAt ? (
              <>
                Working for <WorkingTimer createdAt={activeStartedAt} />
              </>
            ) : (
              "Working..."
            )}
          </span>
          <span className="h-px min-w-8 flex-1 bg-border/65" />
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={isExpanded}
          className="group flex w-full cursor-pointer items-center gap-2 py-1 text-left"
          data-scroll-anchor-ignore
          onClick={() => setWorkGroupExpanded(routeThreadKey, rowId, !isExpanded)}
        >
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground/70 transition-colors group-hover:text-muted-foreground">
            {groupLabel}
            <ChevronRightIcon
              className={cn(
                "size-4 transition-transform duration-150",
                isExpanded ? "rotate-90" : null,
              )}
            />
          </span>
          <span className="h-px min-w-8 flex-1 bg-border/65" />
        </button>
      )}
      {showExpandedEntries && displayEntries.length > 0 ? (
        <div className="mt-2.5 space-y-2">
          {displayEntries.map((entry) => (
            <ActivityGroupEntryRow key={`activity-row:${entry.id}`} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

const ActivityGroupEntryRow = memo(function ActivityGroupEntryRow({
  entry,
}: {
  entry: ReturnType<typeof deriveWorkActivityDisplayEntries>[number];
}) {
  const ctx = use(TimelineRowCtx);

  if (entry.kind === "work-summary") {
    return <WorkActivitySummaryRow summary={entry.summary} />;
  }

  const messageText = entry.entry.message.text || "(empty response)";
  return (
    <div className="min-w-0 py-0.5">
      <ChatMarkdown
        text={messageText}
        cwd={ctx.markdownCwd}
        isStreaming={Boolean(entry.entry.message.streaming)}
        skills={ctx.skills}
      />
    </div>
  );
});

const WorkActivitySummaryRow = memo(function WorkActivitySummaryRow({
  summary,
}: {
  summary: WorkActivitySummary;
}) {
  const { routeThreadKey } = use(TimelineRowCtx);
  const expanded = useUiStateStore(
    (store) => store.threadWorkActivityExpandedById[routeThreadKey]?.[summary.id] ?? true,
  );
  const setWorkActivityExpanded = useUiStateStore((store) => store.setThreadWorkActivityExpanded);
  const ActivityIcon = workActivityIcon(summary.category);
  const canExpand = summary.items.length > 0;
  const summaryButton = (
    <button
      type="button"
      aria-expanded={expanded}
      disabled={!canExpand}
      data-scroll-anchor-ignore
      onClick={() => setWorkActivityExpanded(routeThreadKey, summary.id, !expanded)}
      className={cn(
        "group/activity inline-flex h-5 max-w-full items-center gap-1.5 text-left text-sm leading-5",
        canExpand ? "cursor-pointer" : "cursor-default",
      )}
    >
      <span className="inline-flex size-4 shrink-0 items-center justify-center">
        <ActivityIcon
          className={cn(
            "size-4",
            summary.category === "error" ? "text-rose-300/60" : "text-muted-foreground/70",
          )}
        />
      </span>
      <span
        className={cn(
          "truncate",
          expanded ? "text-foreground/90" : "text-muted-foreground/70",
          canExpand ? "group-hover/activity:text-foreground/85" : null,
        )}
      >
        {summary.label}
      </span>
      {canExpand ? (
        <ChevronRightIcon
          className={cn(
            "size-4 shrink-0 text-muted-foreground/65 opacity-0 transition-[opacity,transform,color] duration-150 group-hover/activity:opacity-100 group-focus-visible/activity:opacity-100",
            expanded ? "rotate-90" : null,
            expanded ? "opacity-100" : null,
          )}
        />
      ) : null}
    </button>
  );

  return (
    <div className="min-w-0 py-0.5" data-work-activity-category={summary.category}>
      {import.meta.env.DEV && summary.debugText ? (
        <Tooltip>
          <TooltipTrigger render={summaryButton} />
          <TooltipPopup align="start" className="max-w-[min(56rem,calc(100vw-2rem))]" side="top">
            <p className="whitespace-pre-wrap wrap-break-word font-mono text-[11px] leading-4">
              {summary.debugText}
            </p>
          </TooltipPopup>
        </Tooltip>
      ) : (
        summaryButton
      )}
      {expanded && summary.items.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {summary.items.map((item) => (
            <WorkActivitySummaryItemRow key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

function WorkActivitySummaryItemRow({ item }: { item: WorkActivitySummary["items"][number] }) {
  const ctx = use(TimelineRowCtx);
  const turnSummary = item.turnId ? ctx.turnDiffSummaryByTurnId.get(item.turnId) : undefined;
  const canShowInlineDiff = Boolean(turnSummary && item.changedFilePath);
  const inlineDiffExpanded = useUiStateStore(
    (store) =>
      store.threadWorkActivityExpandedById[ctx.routeThreadKey]?.[
        workActivityItemDiffExpansionKey(item.id)
      ] ?? false,
  );
  const setWorkActivityExpanded = useUiStateStore((store) => store.setThreadWorkActivityExpanded);
  const debugText = import.meta.env.DEV ? (item.debugText ?? item.title) : item.title;
  const labelClassName =
    "min-w-0 truncate text-left text-sm text-muted-foreground/65 transition-colors hover:text-foreground/85";
  const label = canShowInlineDiff ? (
    <button
      type="button"
      className="group/item inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5"
      data-scroll-anchor-ignore
      aria-expanded={inlineDiffExpanded}
      onClick={() =>
        setWorkActivityExpanded(
          ctx.routeThreadKey,
          workActivityItemDiffExpansionKey(item.id),
          !inlineDiffExpanded,
        )
      }
      title={item.title ?? item.label}
    >
      <span className={labelClassName}>{item.label}</span>
      <ChevronRightIcon
        className={cn(
          "size-4 shrink-0 text-muted-foreground/60 opacity-0 transition-[opacity,transform,color] duration-150 group-hover/item:opacity-100 group-hover/item:text-foreground/80 group-focus-visible/item:opacity-100",
          inlineDiffExpanded ? "rotate-90" : null,
          inlineDiffExpanded ? "opacity-100" : null,
        )}
      />
    </button>
  ) : (
    <p className={labelClassName} title={item.title ?? item.label}>
      {item.label}
    </p>
  );

  const labelWithTooltip =
    !debugText || debugText === item.label ? (
      label
    ) : (
      <Tooltip>
        <TooltipTrigger className="block min-w-0 w-full text-left" render={label} />
        <TooltipPopup align="start" className="max-w-[min(56rem,calc(100vw-2rem))]" side="top">
          <p className="whitespace-pre-wrap wrap-break-word font-mono text-[11px] leading-4">
            {debugText}
          </p>
        </TooltipPopup>
      </Tooltip>
    );

  return (
    <div className="min-w-0">
      {labelWithTooltip}
      {canShowInlineDiff && inlineDiffExpanded && turnSummary && item.changedFilePath ? (
        <InlineWorkActivityFileDiff turnSummary={turnSummary} filePath={item.changedFilePath} />
      ) : null}
    </div>
  );
}

function workActivityItemDiffExpansionKey(itemId: string): string {
  return `work-activity-item-diff:${itemId}`;
}

function InlineWorkActivityFileDiff({
  turnSummary,
  filePath,
}: {
  turnSummary: TurnDiffSummary;
  filePath: string;
}) {
  const ctx = use(TimelineRowCtx);
  const checkpointTurnCount = turnSummary.checkpointTurnCount;
  const checkpointRange =
    typeof checkpointTurnCount === "number"
      ? {
          fromTurnCount: Math.max(0, checkpointTurnCount - 1),
          toTurnCount: checkpointTurnCount,
        }
      : null;
  const checkpointDiff = useCheckpointDiff(
    {
      environmentId: ctx.activeThreadEnvironmentId,
      threadId: ctx.activeThreadId,
      fromTurnCount: checkpointRange?.fromTurnCount ?? null,
      toTurnCount: checkpointRange?.toTurnCount ?? null,
      ignoreWhitespace: false,
      cacheScope: `timeline-inline:${turnSummary.turnId}`,
    },
    { enabled: checkpointRange !== null },
  );
  const patch = checkpointDiff.data?.diff;
  const renderablePatch = useMemo(
    () => getRenderablePatch(patch, `timeline-inline:${turnSummary.turnId}:${ctx.resolvedTheme}`),
    [ctx.resolvedTheme, patch, turnSummary.turnId],
  );
  const fileDiff = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return undefined;
    }
    return findRenderableFileDiff(renderablePatch.files, filePath, ctx.workspaceRoot);
  }, [ctx.workspaceRoot, filePath, renderablePatch]);

  return (
    <div className="mt-2 max-w-full overflow-hidden rounded-[10px] border border-border/70 bg-background">
      {checkpointDiff.error && !renderablePatch ? (
        <p className="px-3 py-2 text-[11px] text-rose-300/80">{checkpointDiff.error}</p>
      ) : checkpointRange === null ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground/65">
          Diff unavailable for this turn.
        </p>
      ) : checkpointDiff.isPending && !renderablePatch ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground/65">Loading diff...</p>
      ) : renderablePatch?.kind === "raw" ? (
        <div className="p-2">
          <p className="mb-1 text-[11px] text-muted-foreground/65">{renderablePatch.reason}</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground/90">
            {renderablePatch.text}
          </pre>
        </div>
      ) : fileDiff ? (
        <div className="max-h-[28rem] overflow-auto">
          <FileDiff
            key={buildFileDiffRenderKey(fileDiff)}
            fileDiff={fileDiff}
            options={{
              collapsed: false,
              diffIndicators: "bars",
              diffStyle: "unified",
              lineDiffType: "word-alt",
              overflow: "scroll",
              theme: resolveDiffThemeName(ctx.resolvedTheme),
              themeType: ctx.resolvedTheme as DiffThemeType,
              unsafeCSS: INLINE_DIFF_RENDER_UNSAFE_CSS,
            }}
          />
        </div>
      ) : (
        <p className="px-3 py-2 text-[11px] text-muted-foreground/65">
          No diff found for {filePath}.
        </p>
      )}
    </div>
  );
}

function findRenderableFileDiff(
  files: ReadonlyArray<FileDiffMetadata>,
  filePath: string,
  workspaceRoot: string | undefined,
) {
  const targetPath = normalizeComparableDiffPath(filePath, workspaceRoot);
  return files.find((file) => {
    const diffPath = normalizeComparableDiffPath(resolveFileDiffPath(file), workspaceRoot);
    return diffPath === targetPath;
  });
}

function normalizeComparableDiffPath(path: string, workspaceRoot: string | undefined): string {
  const normalizedPath = path.replaceAll("\\", "/").replace(/^"(.*)"$/u, "$1");
  const withoutPrefixes = normalizedPath.replace(/^(?:[ab]\/|\.\/)+/u, "");
  if (!workspaceRoot) {
    return withoutPrefixes.replace(/^\/+/u, "").toLowerCase();
  }
  const normalizedWorkspaceRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  const pathForCompare = withoutPrefixes.toLowerCase();
  const workspaceForCompare = normalizedWorkspaceRoot.toLowerCase();
  if (pathForCompare.startsWith(`${workspaceForCompare}/`)) {
    return withoutPrefixes.slice(normalizedWorkspaceRoot.length + 1).toLowerCase();
  }
  return withoutPrefixes.replace(/^\/+/u, "").toLowerCase();
}

function workActivityIcon(category: WorkActivityCategory): TablerIcon {
  switch (category) {
    case "search":
      return SearchIcon;
    case "file":
      return SearchIcon;
    case "edit":
      return SquarePenIcon;
    case "command":
      return TerminalIcon;
    case "tool":
      return WrenchIcon;
    case "info":
      return CheckIcon;
    case "error":
      return CircleAlertIcon;
  }
}

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
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 220;

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
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "line-clamp-2")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
          />
        </div>
      ) : null}
      {canCollapse ? (
        <div className="mt-2" data-user-message-footer="true">
          <button
            type="button"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex cursor-pointer items-center gap-1 text-sm text-muted-foreground/75 transition-colors hover:text-foreground/85"
          >
            {expanded ? "Show less" : "Show more"}
            <ChevronDownIcon
              className={cn("size-4 transition-transform", expanded ? "rotate-180" : null)}
            />
          </button>
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}) {
  const reviewCommentSegments = parseReviewCommentMessageSegments(props.text);
  if (reviewCommentSegments.some((segment) => segment.kind === "review-comment")) {
    return (
      <div className="space-y-3 text-sm leading-relaxed text-foreground">
        {reviewCommentSegments.map((segment) =>
          segment.kind === "text" ? (
            segment.text.trim().length > 0 ? (
              <div key={segment.id} className="whitespace-pre-wrap wrap-break-word">
                <SkillInlineText text={segment.text.trim()} skills={props.skills} />
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
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              <SkillInlineText text={props.text.slice(cursor, matchIndex)} skills={props.skills} />
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
              <SkillInlineText text={props.text.slice(cursor)} skills={props.skills} />
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
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          <SkillInlineText text={props.text} skills={props.skills} />
        </span>,
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
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      <SkillInlineText text={props.text} skills={props.skills} />
    </div>
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

function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string | null | undefined,
  timestampFormat: TimestampFormat,
): string {
  const elapsed = durationStart ? formatElapsed(durationStart, new Date().toISOString()) : null;
  return formatMessageMeta(createdAt, elapsed, timestampFormat);
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function formatWorkGroupSummary(
  groupedEntries: ReadonlyArray<TimelineActivityEntry>,
  completionSummary: string | null,
): string {
  const firstEntry = groupedEntries[0];
  const lastEntry = groupedEntries[groupedEntries.length - 1];
  const elapsed =
    firstEntry && lastEntry ? formatWorkingTimer(firstEntry.createdAt, lastEntry.createdAt) : null;
  const hasHiddenEntries = groupedEntries.some(
    (entry) => entry.kind === "work" && entry.workEntry.hidden === true,
  );

  if (hasHiddenEntries && elapsed) {
    return `Worked for ${elapsed}`;
  }

  if (completionSummary) {
    return completionSummary;
  }

  if (!elapsed) {
    return "Worked";
  }

  return `Worked for ${elapsed}`;
}
