import {
  EnvironmentId,
  type MessageId,
  ThreadId,
  type TurnDiffScope,
  type TurnId,
} from "@t3tools/contracts";
import {
  createContext,
  createElement,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { deriveTimelineEntries, formatElapsed, type AgentRun } from "../../session-logic";
import { buildThreadPath } from "@t3tools/shared/threadUrl";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CornerDownRightIcon,
  DiffIcon,
  EyeIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  HammerIcon,
  InfoIcon,
  LoaderCircle,
  Minimize2Icon,
  PaintbrushIcon,
  RadarIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { WorkLogPanel } from "./WorkLogPanel";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { ChildFollowUpReceipt } from "./ChildFollowUpPanel";
import {
  collectReviewOutputMessageIds,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveExternalActionUrl,
  shouldHandleInternalActionClick,
  stabilizeReadonlyStringSet,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "~/lib/previewAnnotation";
import {
  DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS,
  type MessagePreviewLineCount,
  type MessagePreviewLineLimits,
  type TimestampFormat,
} from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { formatTimestamp } from "../../timestampFormat";
import {
  compactWorkEntryLabel,
  groupRepeatedWorkEntries,
  hasWorkLogToolData,
  deriveWorkGroupActivity,
  extractCommandOutputText,
  workGroupReceiptLabel,
  toolGroupAction,
  workEntryNeedsAttention,
  workGroupAccessibleLabel,
} from "@t3tools/client-runtime/work-log/presentation";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { selectSidebarThreadSummaryByRef, useStore, type AppState } from "../../store";
import { readEnvironmentApi } from "~/environmentApi";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";
import { stackedThreadToast, toastManager } from "../ui/toast";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via useContext.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  copilotResumeCommand: string | null;
  timestampFormat: TimestampFormat;
  messagePreviewLineLimits: MessagePreviewLineLimits;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  activeChatFindRowId: string | null;
  highlightedMessageId: MessageId | null;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  onRevertUserMessage: (messageId: MessageId) => void;
  onForkAssistantMessage?: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  reviewOutputMessageIds: ReadonlySet<string>;
  workGroupExpansion: Map<string, boolean>;
}

// Streaming-hot state, updated on every chunk. Kept in a separate context so
// rows that only read TimelineRowCtx (user messages, settled rows) do not
// re-render when a token arrives. Only the active assistant row and live
// work-group sections subscribe to this.
interface TimelineStreamingState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  completionSummary: string | null;
  responseMetaByTurnId: ReadonlyMap<TurnId, AssistantResponseMeta>;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineStreamingCtx = createContext<TimelineStreamingState>(null!);
// Single shared 1s ticker for live labels. One interval at the list root
// replaces N per-row setIntervals (one per working/streaming row).
const TimelineNowMsCtx = createContext<number | null>(null);
const EMPTY_RESPONSE_META_BY_TURN_ID = new Map<TurnId, AssistantResponseMeta>();

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  rows?: MessagesTimelineRow[];
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  copilotResumeCommand: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  responseMetaByTurnId?: ReadonlyMap<TurnId, AssistantResponseMeta>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onForkAssistantMessage?: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  messagePreviewLineLimits?: MessagePreviewLineLimits;
  workspaceRoot: string | undefined;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  activeChatFindRowId?: string | null;
  highlightedMessageId?: MessageId | null;
  reviewResultActive?: boolean;
  hasMoreOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

export interface AssistantResponseMeta {
  model?: string;
  usedTokens?: number;
  cost?: {
    amount: number;
    currency: string;
  };
}

const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 900;
const AUTOLOAD_OLDER_OVERFLOW_PX = 8;

type OlderHistoryScrollMetrics = {
  contentLength: number;
  isAtEnd: boolean;
  isAtStart: boolean;
  scroll: number;
  scrollLength: number;
};

/**
 * Auto-loading older history must only run when the user has actually scrolled
 * to the top of an overflowed list. Short threads report isAtStart (scroll=0)
 * while also being at end — treating that as "at top" prepends history and
 * jumps the viewport to the oldest messages on send/resize scroll events.
 */
export function shouldAutoloadOlderHistory(
  metrics: OlderHistoryScrollMetrics,
  overflowPx = AUTOLOAD_OLDER_OVERFLOW_PX,
) {
  if (!metrics.isAtStart || metrics.isAtEnd) {
    return false;
  }

  const overflow = metrics.contentLength - metrics.scrollLength;
  return Number.isFinite(overflow) && overflow > overflowPx && metrics.scroll <= overflowPx;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  rows: providedRows,
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  copilotResumeCommand,
  turnDiffSummaryByAssistantMessageId,
  responseMetaByTurnId = EMPTY_RESPONSE_META_BY_TURN_ID,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onForkAssistantMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  activeThreadId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  messagePreviewLineLimits = DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS,
  workspaceRoot,
  onIsAtEndChange,
  activeChatFindRowId = null,
  highlightedMessageId = null,
  reviewResultActive = false,
  hasMoreOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: MessagesTimelineProps) {
  const workGroupExpansion = useMemo(() => new Map<string, boolean>(), [routeThreadKey]);
  const rawRows = useMemo(
    () =>
      providedRows ??
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking: isWorking || activeTurnInProgress,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      providedRows,
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  // The reviewer's structured output is rendered as the findings card, so hide
  // the raw JSON message it came from — identified by content, because later
  // turns in the same review thread append ordinary assistant replies.
  // Stabilize the Set identity: a fresh empty/equal Set on every stream chunk
  // would rebuild TimelineRowCtx and re-render every mounted row.
  const reviewOutputMessageIdsRef = useRef<ReadonlySet<string> | undefined>(undefined);
  const reviewOutputMessageIds = useMemo(() => {
    const next = stabilizeReadonlyStringSet(
      collectReviewOutputMessageIds(rows, reviewResultActive),
      reviewOutputMessageIdsRef.current,
    );
    reviewOutputMessageIdsRef.current = next;
    return next;
  }, [rows, reviewResultActive]);

  const tryAutoloadOlderHistory = useCallback(() => {
    if (!hasMoreOlder || loadingOlder || !onLoadOlder) {
      return;
    }
    const state = listRef.current?.getState?.();
    if (!state || !shouldAutoloadOlderHistory(state)) {
      return;
    }
    onLoadOlder();
  }, [hasMoreOlder, listRef, loadingOlder, onLoadOlder]);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
    tryAutoloadOlderHistory();
  }, [listRef, onIsAtEndChange, tryAutoloadOlderHistory]);

  const handleStartReached = useCallback(() => {
    tryAutoloadOlderHistory();
  }, [tryAutoloadOlderHistory]);

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

  // Memoised context values. Streaming-hot fields live in TimelineStreamingCtx
  // so settled rows subscribed only to TimelineRowCtx skip per-chunk renders.
  // Callbacks from ChatView are useCallback-stable.
  // Stable thread ref object: ChatMarkdown keys its component/plugin memos on
  // this identity, so a fresh inline object per row would defeat them.
  const threadRef = useMemo(
    () => ({ environmentId: activeThreadEnvironmentId, threadId: activeThreadId }),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const streamingState = useMemo<TimelineStreamingState>(
    () => ({
      activeTurnInProgress,
      activeTurnId: activeTurnId ?? null,
      completionSummary,
      responseMetaByTurnId,
    }),
    [activeTurnInProgress, activeTurnId, completionSummary, responseMetaByTurnId],
  );
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
      copilotResumeCommand,
      timestampFormat,
      messagePreviewLineLimits,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeChatFindRowId,
      highlightedMessageId,
      activeThreadEnvironmentId,
      activeThreadId,
      threadRef,
      onRevertUserMessage,
      ...(onForkAssistantMessage ? { onForkAssistantMessage } : {}),
      onImageExpand,
      onOpenTurnDiff,
      reviewOutputMessageIds,
      workGroupExpansion,
    }),
    [
      isWorking,
      isRevertingCheckpoint,
      copilotResumeCommand,
      timestampFormat,
      messagePreviewLineLimits,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeChatFindRowId,
      highlightedMessageId,
      activeThreadEnvironmentId,
      activeThreadId,
      threadRef,
      onRevertUserMessage,
      onForkAssistantMessage,
      onImageExpand,
      onOpenTurnDiff,
      reviewOutputMessageIds,
      workGroupExpansion,
    ],
  );
  // One shared 1s tick for live labels while work is in flight; idle lists
  // pay no interval. Consumers read TimelineNowMsCtx instead of owning timers.
  // Refresh immediately when the ticker enables so resumed work does not show
  // a stale elapsed time for up to a second.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ticking = isWorking || activeTurnInProgress;
  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

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

  const listHeader = useMemo(() => {
    const canLoadOlder = hasMoreOlder && onLoadOlder !== undefined;

    if (loadingOlder && canLoadOlder) {
      return (
        <div className="flex items-center justify-center py-2 text-xs text-muted-foreground">
          Loading older history...
        </div>
      );
    }
    if (canLoadOlder) {
      return (
        <button
          type="button"
          onClick={onLoadOlder}
          className="flex w-full cursor-pointer items-center justify-center py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Load older history
        </button>
      );
    }
    return <div className="h-3 sm:h-4" />;
  }, [hasMoreOlder, loadingOlder, onLoadOlder]);

  const listFooter = useMemo(() => <div className="h-3 sm:h-4" />, []);

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
    <TimelineRowCtx.Provider value={sharedState}>
      <TimelineStreamingCtx.Provider value={streamingState}>
        <TimelineNowMsCtx.Provider value={ticking ? nowMs : null}>
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
            onStartReached={handleStartReached}
            onStartReachedThreshold={0.05}
            className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
            ListHeaderComponent={listHeader}
            ListFooterComponent={listFooter}
          />
        </TimelineNowMsCtx.Provider>
      </TimelineStreamingCtx.Provider>
    </TimelineRowCtx.Provider>
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

type TimelineAttachment = NonNullable<TimelineMessage["attachments"]>[number];

/**
 * One attachment tile in a user message. Images that already carry a
 * server preview URL open directly; anything else mints a signed
 * `attachment` asset URL on demand so files staged outside the workspace
 * still open in-app instead of dead-ending on a bare filename.
 */
const TimelineAttachmentTile = memo(function TimelineAttachmentTile({
  attachment,
  images,
  environmentId,
  onImageExpand,
}: {
  attachment: TimelineAttachment;
  images: ReadonlyArray<TimelineAttachment>;
  environmentId: EnvironmentId;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  const [opening, setOpening] = useState(false);
  const openAttachment = useCallback(async () => {
    if (attachment.previewUrl) {
      const preview = buildExpandedImagePreview(images, attachment.id);
      if (preview) onImageExpand(preview);
      return;
    }
    if (opening) return;
    const environmentApi = readEnvironmentApi(environmentId);
    const httpBaseUrl = getEnvironmentHttpBaseUrl(environmentId);
    if (!environmentApi || !httpBaseUrl) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open attachment",
          description: "The environment is unavailable.",
        }),
      );
      return;
    }
    setOpening(true);
    try {
      const resolved = await Promise.all(
        images.map(async (image) => {
          if (image.previewUrl) return image;
          try {
            const asset = await environmentApi.assets.createUrl({
              resource: {
                _tag: "attachment",
                attachmentId: image.id,
                fileName: image.name,
                mimeType: image.mimeType,
                disposition: "inline",
              },
            });
            return {
              ...image,
              previewUrl: new URL(asset.relativeUrl, httpBaseUrl).toString(),
            };
          } catch (error) {
            // Sibling failures degrade gracefully, but the clicked
            // attachment's own failure must reach the outer catch so a
            // transient error reports its real cause instead of reading as
            // a missing attachment.
            if (image.id === attachment.id) throw error;
            return null;
          }
        }),
      );
      const preview = buildExpandedImagePreview(
        resolved.filter((image) => image !== null),
        attachment.id,
      );
      if (!preview) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open attachment",
            description: "The attachment is no longer available.",
          }),
        );
        return;
      }
      onImageExpand(preview);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open attachment",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setOpening(false);
    }
  }, [attachment, environmentId, images, onImageExpand, opening]);

  return (
    <div className="overflow-hidden rounded-lg border border-border/80 bg-background/70">
      {attachment.previewUrl ? (
        <button
          type="button"
          className="h-full w-full cursor-zoom-in"
          aria-label={`Preview ${attachment.name}`}
          onClick={() => void openAttachment()}
        >
          <img
            src={attachment.previewUrl}
            alt={attachment.name}
            className="block h-auto max-h-[220px] w-full object-cover"
          />
        </button>
      ) : (
        <button
          type="button"
          disabled={opening}
          onClick={() => void openAttachment()}
          aria-label={opening ? `Opening ${attachment.name}` : `Open ${attachment.name}`}
          title={opening ? `Opening ${attachment.name}…` : `Open ${attachment.name}`}
          className="flex min-h-[72px] w-full flex-col items-center justify-center gap-1 px-2 py-3 text-center text-[11px] text-muted-foreground/70 hover:text-foreground disabled:opacity-70"
        >
          {opening ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
          <span className="break-all">{attachment.name}</span>
        </button>
      )}
    </div>
  );
});

const TimelineRowContent = memo(function TimelineRowContent(props: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);
  const { row } = props;

  return (
    <div
      className={cn(
        row.kind === "work" || row.kind === "working" ? "pb-2" : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-chat-find-active={ctx.activeChatFindRowId === row.id ? "true" : undefined}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
      data-message-highlighted={
        row.kind === "message" && row.message.id === ctx.highlightedMessageId ? "true" : undefined
      }
    >
      {row.kind === "context-compaction" && (
        <div
          role="separator"
          aria-label={row.label}
          className="mx-auto flex w-full max-w-3xl items-center gap-3 py-1 text-xs text-muted-foreground"
        >
          <span className="h-px min-w-4 flex-1 bg-border/70" />
          <span className="flex min-w-0 items-center justify-center gap-1.5 text-center">
            <Minimize2Icon aria-hidden="true" className="size-3 shrink-0" />
            {row.label}
          </span>
          <span className="h-px min-w-4 flex-1 bg-border/70" />
        </div>
      )}
      {row.kind === "work" && (
        <WorkGroupSection
          groupedEntries={row.groupedEntries}
          shouldAutoCollapse={row.shouldAutoCollapse}
        />
      )}

      {row.kind === "reasoning" && <ReasoningSection row={row} />}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const childNudge = row.message.origin?.kind === "child-nudge" ? row.message.origin : null;
          if (childNudge) {
            return (
              <ChildFollowUpReceipt
                updates={childNudge.updates}
                environmentId={ctx.activeThreadEnvironmentId}
                forceExpanded={ctx.activeChatFindRowId === row.id}
                initialExpanded={ctx.workGroupExpansion.get(row.id) ?? false}
                onExpandedChange={(expanded) => ctx.workGroupExpansion.set(row.id, expanded)}
              />
            );
          }
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const previewAnnotations: ParsedPreviewAnnotation[] = [];
          let visibleText = displayedUserMessage.visibleText;
          while (true) {
            const extracted = extractTrailingPreviewAnnotation(visibleText);
            if (!extracted.annotation) break;
            previewAnnotations.unshift(extracted.annotation);
            visibleText = extracted.promptText;
          }
          const previewImages = userImages.filter((image) =>
            image.name.startsWith("preview-annotation-"),
          );
          const previewImagesByName = new Map(previewImages.map((image) => [image.name, image]));
          const regularImages = userImages.filter(
            (image) => !image.name.startsWith("preview-annotation-"),
          );
          return (
            <div className="flex flex-col items-end">
              {row.message.origin?.kind === "cross-thread" ? (
                <CrossThreadProvenance origin={row.message.origin} />
              ) : row.message.origin?.kind === "pull-request-monitor" ? (
                <PullRequestMonitorProvenance origin={row.message.origin} />
              ) : null}
              <div
                className={cn(
                  "group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3",
                  row.message.origin?.kind === "cross-thread" &&
                    "border-violet-400/30 bg-gradient-to-br from-violet-500/[0.07] via-violet-500/[0.02] to-transparent",
                  row.message.origin?.kind === "pull-request-monitor" &&
                    "border-sky-400/30 bg-gradient-to-br from-sky-500/[0.07] via-sky-500/[0.02] to-transparent",
                )}
              >
                {regularImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {regularImages.map((image) => (
                      <TimelineAttachmentTile
                        key={image.id}
                        attachment={image}
                        images={regularImages}
                        environmentId={ctx.activeThreadEnvironmentId}
                        onImageExpand={ctx.onImageExpand}
                      />
                    ))}
                  </div>
                )}
                {previewAnnotations.map((annotation) => (
                  <UserMessagePreviewAnnotationCard
                    key={annotation.id}
                    annotation={annotation}
                    image={
                      previewImagesByName.get(`preview-annotation-${annotation.id}.png`) ?? null
                    }
                  />
                ))}
                <CollapsibleUserMessageBody
                  rowId={row.id}
                  text={visibleText}
                  terminalContexts={terminalContexts}
                  collapsedLineLimit={resolveMessagePreviewLineLimit(
                    row.message.origin?.kind,
                    ctx.messagePreviewLineLimits,
                  )}
                  forceExpanded={ctx.activeChatFindRowId === row.id}
                />
              </div>
            </div>
          );
        })()}

      {row.kind === "message" && row.message.role === "assistant" && (
        <AssistantMessageContent row={row} />
      )}

      {row.kind === "message" && row.message.role === "system" && (
        <div className="mx-1 flex items-start gap-2 rounded-lg border border-border/50 bg-muted/25 px-3 py-2 text-sm text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p className="whitespace-pre-wrap break-words">{row.message.text}</p>
            <p className="mt-1 text-[length:var(--app-status-line-font-size)] text-muted-foreground/60">
              {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
            </p>
          </div>
        </div>
      )}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.markdownCwd}
            workspaceRoot={ctx.workspaceRoot}
          />
        </div>
      )}

      {row.kind === "workspace-handoff" &&
        (() => {
          const revertMessageId = row.revertMessageId;
          const canRevertAgentWork =
            revertMessageId !== undefined && typeof row.revertTurnCount === "number";
          return (
            <div className="group/handoff mx-1 flex items-center gap-2 py-2 text-[length:var(--app-status-line-font-size)] text-muted-foreground">
              <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <GitBranchIcon className="size-3 shrink-0" aria-hidden="true" />
                      <span className="shrink-0">Moved to</span>
                      <span className="truncate font-medium text-foreground/80">
                        {row.origin.branch}
                      </span>
                    </span>
                  }
                />
                <TooltipPopup>{row.origin.worktreePath}</TooltipPopup>
              </Tooltip>
              {canRevertAgentWork && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                  onClick={() => ctx.onRevertUserMessage(revertMessageId)}
                  title="Revert to this workspace move"
                  aria-label="Revert to this workspace move"
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/handoff:opacity-100"
                >
                  <Undo2Icon className="size-3" />
                </Button>
              )}
              <span className="h-px flex-1 bg-border/60" aria-hidden="true" />
            </div>
          );
        })()}

      {row.kind === "working" && (
        <div className="py-0.5">
          <div className="chat-work-text flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-flex w-[1em] shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              <span className="h-1 w-1 rounded-full bg-muted-foreground animate-status-pulse motion-reduce:animate-none" />
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
      )}
    </div>
  );
});

// Per-row streaming bridge. This is the only assistant subtree subscribed to
// TimelineStreamingCtx: it projects the row's own slice (liveness boolean +
// its turn's meta entry) and renders the memoized presentational below. The
// bridge itself re-renders per chunk, but that render is two map lookups;
// settled rows pass referentially-stable props (stable row identity from
// useStableRows, stable meta entry identity for untouched turns), so the
// heavy presentational subtree bails out via memo.
const AssistantMessageContent = memo(function AssistantMessageContent({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "message" }>;
}) {
  const streaming = use(TimelineStreamingCtx);
  const assistantTurnStillInProgress =
    streaming.activeTurnInProgress &&
    streaming.activeTurnId !== null &&
    streaming.activeTurnId !== undefined &&
    row.message.turnId === streaming.activeTurnId;
  const responseMeta =
    !row.showAssistantTerminalMetadata ||
    row.message.streaming ||
    assistantTurnStillInProgress ||
    row.message.turnId === null ||
    row.message.turnId === undefined
      ? undefined
      : streaming.responseMetaByTurnId.get(row.message.turnId);
  return (
    <AssistantMessagePresentational
      row={row}
      assistantTurnStillInProgress={assistantTurnStillInProgress}
      responseMeta={responseMeta}
    />
  );
});

const AssistantMessagePresentational = memo(function AssistantMessagePresentational({
  row,
  assistantTurnStillInProgress,
  responseMeta,
}: {
  row: Extract<MessagesTimelineRow, { kind: "message" }>;
  assistantTurnStillInProgress: boolean;
  responseMeta: AssistantResponseMeta | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.message.streaming || assistantTurnStillInProgress,
  });
  const showCopilotResumeCommand =
    row.showAssistantTerminalMetadata &&
    !row.message.streaming &&
    !assistantTurnStillInProgress &&
    ctx.copilotResumeCommand;
  return (
    <>
      <div className="min-w-0 px-1 py-0.5">
        {ctx.reviewOutputMessageIds.has(row.id) ? null : (
          <ChatMarkdown
            text={messageText}
            cwd={ctx.markdownCwd}
            isStreaming={Boolean(row.message.streaming)}
            threadRef={ctx.threadRef}
          />
        )}
        <AssistantChangedFilesSection
          turnSummary={row.assistantTurnDiffSummary}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
          workspaceRoot={ctx.workspaceRoot}
        />
        <div className="mt-1.5 flex min-w-0 items-center gap-2">
          {responseMeta ? (
            <span className="shrink-0 text-[length:var(--app-status-line-font-size)] text-muted-foreground/50">
              {formatAssistantResponseMeta(responseMeta)}
            </span>
          ) : null}
          <p className="shrink-0 text-[length:var(--app-status-line-font-size)] text-muted-foreground/30">
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
          {showCopilotResumeCommand ? (
            <span
              className="min-w-0 truncate font-mono text-[length:var(--app-status-line-font-size)] text-muted-foreground/30 opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100"
              title={showCopilotResumeCommand}
            >
              {showCopilotResumeCommand}
            </span>
          ) : null}
          {assistantCopyState.visible ? (
            <div className="flex items-center opacity-0 transition-opacity duration-200  group-hover/assistant:opacity-100">
              <MessageCopyButton
                text={assistantCopyState.text ?? ""}
                size="icon-xs"
                variant="outline"
                className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
              />
            </div>
          ) : null}
          {ctx.onForkAssistantMessage &&
          row.showAssistantTerminalMetadata &&
          !row.message.streaming &&
          !assistantTurnStillInProgress ? (
            <div className="flex items-center opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100">
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                title="Fork chat"
                aria-label="Fork chat from this response"
                onClick={() => ctx.onForkAssistantMessage?.(row.message.id)}
              >
                <GitForkIcon className="size-3" />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
});

function formatAssistantResponseMeta(meta: AssistantResponseMeta): string {
  const parts = [
    meta.model,
    meta.usedTokens === undefined ? undefined : `${formatCompactNumber(meta.usedTokens)} tokens`,
    meta.cost === undefined ? undefined : formatResponseCost(meta.cost),
  ].filter((part): part is string => part !== undefined);
  return parts.join(" · ");
}

function formatResponseCost(cost: NonNullable<AssistantResponseMeta["cost"]>): string {
  const amount = formatBillingAmount(cost.amount);
  if (cost.currency.toUpperCase() === "USD") {
    return `$${amount}`;
  }
  return `${amount} ${cost.currency}`;
}

function formatBillingAmount(value: number): string {
  const absoluteValue = Math.abs(value);
  const fractionDigits =
    absoluteValue > 0 && absoluteValue < 1
      ? Math.min(20, Math.max(2, Math.ceil(-Math.log10(absoluteValue))))
      : 2;
  return value.toFixed(fractionDigits);
}

function CrossThreadProvenance({
  origin,
}: {
  origin: Extract<NonNullable<TimelineMessage["origin"]>, { kind: "cross-thread" }>;
}) {
  const navigate = useNavigate();
  const ctx = use(TimelineRowCtx);
  // scopeThreadRef allocates a fresh object; memoize the ref on the primitives
  // so the selector (and its subscription) stays stable across stream chunks.
  const sourceThreadEnvironmentId = ctx.activeThreadEnvironmentId;
  const sourceThreadThreadId = origin.sourceThreadId;
  const sourceThreadSelector = useMemo(() => {
    const ref = scopeThreadRef(sourceThreadEnvironmentId, sourceThreadThreadId);
    return (state: AppState) => selectSidebarThreadSummaryByRef(state, ref);
  }, [sourceThreadEnvironmentId, sourceThreadThreadId]);
  const sourceThread = useStore(sourceThreadSelector);
  const sourceTitle = sourceThread?.title.trim() || origin.sourceThreadTitle;
  const canNavigate = sourceThread !== null && sourceThread !== undefined;

  if (!canNavigate) {
    return (
      <span
        className="mb-1 mr-2 inline-flex max-w-[80%] items-center gap-1 text-[length:var(--app-status-line-font-size)] text-muted-foreground/40"
        title={`Source chat unavailable: ${sourceTitle}`}
      >
        <CornerDownRightIcon className="size-2.5 shrink-0 text-violet-400/40" aria-hidden="true" />
        <span className="truncate">{sourceTitle}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="group/origin mb-1 mr-2 inline-flex max-w-[80%] cursor-pointer items-center gap-1 rounded text-[length:var(--app-status-line-font-size)] text-muted-foreground/45 transition-colors hover:text-muted-foreground/85 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-violet-500/60"
      title={`Open source chat: ${sourceTitle}`}
      aria-label={`Open source chat ${sourceTitle} at the initiating message`}
      onClick={() => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: sourceThreadEnvironmentId,
            threadId: sourceThreadThreadId,
          },
          search: (previous) => ({ ...previous, message: origin.sourceMessageId }),
        });
      }}
    >
      <CornerDownRightIcon
        className="size-2.5 shrink-0 text-violet-400/50 transition-colors group-hover/origin:text-violet-400/90"
        aria-hidden="true"
      />
      <span className="truncate decoration-current/30 underline-offset-2 group-hover/origin:underline">
        {sourceTitle}
      </span>
    </button>
  );
}

function PullRequestMonitorProvenance({
  origin,
}: {
  origin: Extract<NonNullable<TimelineMessage["origin"]>, { kind: "pull-request-monitor" }>;
}) {
  return (
    <span
      className="mb-1 mr-2 inline-flex max-w-[80%] items-center gap-1 text-[length:var(--app-status-line-font-size)] text-muted-foreground/45"
      title={`Sent by pull request monitor for ${origin.repository}#${origin.number}`}
    >
      <RadarIcon className="size-2.5 shrink-0 text-sky-400/60" aria-hidden="true" />
      <span className="truncate">
        PR monitor · {origin.repository}#{origin.number}
      </span>
    </span>
  );
}

function formatCompactNumber(value: number): string {
  return (value >= 1_000 ? COMPACT_NUMBER_FORMAT : STANDARD_NUMBER_FORMAT).format(value);
}

const STANDARD_NUMBER_FORMAT = new Intl.NumberFormat("en", {
  notation: "standard",
  maximumFractionDigits: 1,
});
const COMPACT_NUMBER_FORMAT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function UserMessagePreviewAnnotationCard(props: {
  annotation: ParsedPreviewAnnotation;
  image: NonNullable<TimelineMessage["attachments"]>[number] | null;
}) {
  const ctx = use(TimelineRowCtx);
  return (
    <div className="mb-2 flex max-w-full items-center overflow-hidden rounded-lg border border-border/70 bg-background/70">
      {props.image?.previewUrl ? (
        <button
          type="button"
          className="size-14 shrink-0 cursor-zoom-in overflow-hidden border-r border-border/70 bg-muted"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            if (!props.image) return;
            const preview = buildExpandedImagePreview([props.image], props.image.id);
            if (preview) ctx.onImageExpand(preview);
          }}
        >
          <img
            src={props.image.previewUrl}
            alt="Annotated preview crop"
            className="size-full object-cover"
          />
        </button>
      ) : null}
      <div className="min-w-0 px-2.5 py-2">
        {props.annotation.comment ? (
          <div className="max-w-80 truncate text-xs font-medium text-foreground/90">
            {props.annotation.comment}
          </div>
        ) : null}
        <div
          className={cn(
            "flex items-center gap-2 text-[10px] text-muted-foreground",
            props.annotation.comment && "mt-1",
          )}
        >
          {props.annotation.targetSummary ? (
            <span className="truncate">{props.annotation.targetSummary}</span>
          ) : null}
          {props.annotation.styleChanges.length > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              <PaintbrushIcon className="size-3" />
              {props.annotation.styleChanges.length}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live labels read the single shared 1s tick from TimelineNowMsCtx. When the
// list is idle the context is null and labels render settled text with no
// interval. This replaces N per-row setIntervals with one list-level timer.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const nowMs = use(TimelineNowMsCtx) ?? Date.now();
  return <>{formatWorkingTimer(createdAt, new Date(nowMs).toISOString()) ?? "0s"}</>;
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
  const nowMs = use(TimelineNowMsCtx) ?? Date.now();
  const elapsed = durationStart
    ? formatElapsed(durationStart, new Date(nowMs).toISOString())
    : null;
  return <>{formatMessageMeta(createdAt, elapsed, timestampFormat)}</>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Owns user expand/collapse overrides so streaming updates do not reset a chosen state. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
  shouldAutoCollapse,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  shouldAutoCollapse: boolean;
}) {
  // Per-row bridge over the streaming context. activeTurnInProgress/Id only
  // change on turn transitions (not per chunk), so forwarding them as props
  // keeps the memoized presentational below bailed out across chunks while
  // preserving exact liveness semantics.
  const { activeTurnInProgress, activeTurnId } = use(TimelineStreamingCtx);
  return (
    <WorkGroupPresentational
      groupedEntries={groupedEntries}
      shouldAutoCollapse={shouldAutoCollapse}
      activeTurnInProgress={activeTurnInProgress}
      activeTurnId={activeTurnId}
    />
  );
});

const WorkGroupPresentational = memo(function WorkGroupPresentational({
  groupedEntries,
  shouldAutoCollapse,
  activeTurnInProgress,
  activeTurnId,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  shouldAutoCollapse: boolean;
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
}) {
  const { workspaceRoot, workGroupExpansion } = use(TimelineRowCtx);
  const onlyToolEntries =
    groupedEntries.length > 0 && groupedEntries.every((entry) => entry.tone === "tool");
  const groupKey = groupedEntries[0]?.stableId ?? groupedEntries[0]?.id ?? "";
  const working =
    !shouldAutoCollapse &&
    activeTurnInProgress &&
    groupedEntries.some((entry) => !entry.turnId || entry.turnId === activeTurnId);
  const disclosureKey = `${groupKey}:${working ? "working" : "settled"}`;
  const [disclosure, setDisclosure] = useState<{ key: string; expanded: boolean } | null>(null);
  const isExpanded =
    disclosure?.key === disclosureKey
      ? disclosure.expanded
      : (workGroupExpansion.get(disclosureKey) ?? working);
  const activity = useMemo(
    () =>
      deriveWorkGroupActivity(
        groupedEntries,
        activeTurnInProgress &&
          groupedEntries.some((entry) =>
            entry.turnId ? entry.turnId === activeTurnId : !shouldAutoCollapse,
          ),
      ),
    [groupedEntries, activeTurnInProgress, activeTurnId, shouldAutoCollapse],
  );
  const groupLabel = onlyToolEntries ? "Tool Calls" : "Work log";
  const toggleLabel = isExpanded ? "Collapse" : "Expand";
  const attention = activity.state === "failed" || activity.state === "approval";
  const activityIsCommand = activity.lead
    ? toolGroupAction(activity.lead) === "command"
    : groupedEntries.length === 1 && toolGroupAction(groupedEntries[0]!) === "command";

  return (
    <Collapsible
      className="work-group-section"
      open={isExpanded}
      onOpenChange={(expanded) => {
        workGroupExpansion.set(disclosureKey, expanded);
        setDisclosure({ key: disclosureKey, expanded });
      }}
    >
      <CollapsibleTrigger
        className="chat-work-trigger text-muted-foreground"
        aria-label={workGroupAccessibleLabel(
          `${toggleLabel} ${groupLabel} (${groupedEntries.length})`,
          activity.activeCount,
        )}
      >
        <span
          data-work-icon
          className={cn(
            "flex items-center justify-center",
            attention && "text-amber-700 dark:text-amber-400",
          )}
          aria-hidden="true"
        >
          {attention ? (
            <CircleAlertIcon className="size-full" />
          ) : activity.lead ? (
            createElement(workEntryIcon(activity.lead), { className: "size-full" })
          ) : activity.state === "stopped" ? (
            <Minimize2Icon className="size-full" />
          ) : (
            <CheckIcon className="size-full" />
          )}
        </span>
        <span
          className={cn(
            "chat-work-label",
            activityIsCommand && "chat-work-label-truncate",
            activity.shimmer && "work-activity-shimmer",
          )}
          title={activity.label}
        >
          {activity.label}
        </span>
        {activity.activeCount > 1 ? (
          <span
            className="shrink-0 text-muted-foreground"
            title={`${activity.activeCount - 1} more active`}
          >
            +{activity.activeCount - 1}
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3 shrink-0 chat-work-chevron", isExpanded && "rotate-90")}
        />
      </CollapsibleTrigger>
      <WorkLogPanel open={isExpanded}>
        <div className="ml-[0.5em] border-l border-border/50 pl-[1em] py-1">
          <p className="sr-only">
            {groupedEntries.length} {groupedEntries.length === 1 ? "action" : "actions"}
            {activity.activeCount > 1 ? ` · ${activity.activeCount} active` : ""}
          </p>
          <WorkGroupHistory entries={groupedEntries} workspaceRoot={workspaceRoot} />
        </div>
      </WorkLogPanel>
    </Collapsible>
  );
});

function WorkGroupHistory({
  entries,
  workspaceRoot,
}: {
  entries: TimelineWorkEntry[];
  workspaceRoot: string | undefined;
}) {
  const [visibleCount, setVisibleCount] = useState(50);
  return (
    <>
      {groupRepeatedWorkEntries(entries.slice(-visibleCount), repeatableWorkEntry).map((group) => (
        <RepeatedWorkRow
          key={group.entries[0]!.stableId ?? group.entries[0]!.id}
          entries={group.entries}
          label={group.label}
          workspaceRoot={workspaceRoot}
        />
      ))}
      {entries.length > visibleCount ? (
        <button
          type="button"
          className="chat-work-trigger mt-1 text-muted-foreground"
          onClick={() => setVisibleCount((count) => count + 50)}
        >
          Show {Math.min(50, entries.length - visibleCount)} earlier actions
          {entries.length - visibleCount > 50
            ? ` (${entries.length - visibleCount} remaining)`
            : ""}
        </button>
      ) : null}
    </>
  );
}

function repeatableWorkEntry(entry: TimelineWorkEntry) {
  return entry.agentRun || entry.action ? null : entry;
}

function RepeatedWorkRow({
  entries,
  label,
  workspaceRoot,
}: {
  entries: TimelineWorkEntry[];
  label: string;
  workspaceRoot: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const first = entries[0]!;
  if (entries.length === 1) {
    return (
      <SimpleWorkEntryRow
        compact
        canExpandCommand
        workEntry={first}
        workspaceRoot={workspaceRoot}
      />
    );
  }
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger
        className="chat-work-trigger text-muted-foreground"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${entries.length} calls: ${label}`}
      >
        {createElement(workEntryIcon(first), { className: "size-3", "aria-hidden": true })}
        <span
          className={cn(
            "chat-work-label",
            toolGroupAction(first) === "command" && "chat-work-label-truncate",
          )}
          title={label}
        >
          {label}
        </span>
        <span className="shrink-0">×{entries.length}</span>
        <ChevronRightIcon
          className={cn("size-3 shrink-0 chat-work-chevron", expanded && "rotate-90")}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <WorkLogPanel open={expanded}>
        <div className="ml-[0.5em] border-l border-border/50 pl-[1em] py-1">
          {entries.map((entry) => (
            <SimpleWorkEntryRow
              key={entry.stableId ?? entry.id}
              compact
              canExpandCommand
              workEntry={entry}
              workspaceRoot={workspaceRoot}
            />
          ))}
        </div>
      </WorkLogPanel>
    </Collapsible>
  );
}

const ReasoningSection = memo(function ReasoningSection({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "reasoning" }>;
}) {
  const { workGroupExpansion, workspaceRoot } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(() => workGroupExpansion.get(row.id) ?? false);
  const [visibleCount, setVisibleCount] = useState(50);
  const { history, summary } = useMemo(() => {
    type HistoryItem =
      | (typeof row.rows)[number]
      | { kind: "work-entry"; id: string; entry: TimelineWorkEntry };
    const history: HistoryItem[] = [];
    const work: TimelineWorkEntry[] = [];
    for (const nestedRow of row.rows) {
      if (nestedRow.kind === "work") {
        for (const entry of nestedRow.groupedEntries) {
          history.push({ kind: "work-entry", id: entry.stableId ?? entry.id, entry });
          work.push(entry);
        }
      } else {
        history.push(nestedRow);
      }
    }
    return { history, summary: work.length ? workGroupReceiptLabel(work) : null };
  }, [row.rows]);
  const label = row.workedFor ? `Worked for ${row.workedFor}` : "Worked";

  return (
    <Collapsible
      className="work-group-section"
      open={isExpanded}
      onOpenChange={(expanded) => {
        workGroupExpansion.set(row.id, expanded);
        setIsExpanded(expanded);
      }}
    >
      <CollapsibleTrigger className="chat-work-trigger text-muted-foreground">
        <span className="chat-work-label">
          {label}
          {summary ? ` · ${summary}` : ""}
        </span>
        <ChevronRightIcon className={cn("chat-work-chevron", isExpanded && "rotate-90")} />
      </CollapsibleTrigger>
      <WorkLogPanel open={isExpanded}>
        <div className="ml-[0.5em] border-l border-border/50 pl-[1em] py-1">
          {groupRepeatedWorkEntries(history.slice(-visibleCount), (item) =>
            item.kind === "work-entry" ? repeatableWorkEntry(item.entry) : null,
          ).map((group) => {
            const first = group.entries[0]!;
            return first.kind === "work-entry" ? (
              <RepeatedWorkRow
                key={first.id}
                entries={group.entries.flatMap((item) =>
                  item.kind === "work-entry" ? [item.entry] : [],
                )}
                label={group.label}
                workspaceRoot={workspaceRoot}
              />
            ) : (
              <TimelineRowContent key={first.id} row={first} />
            );
          })}
          {history.length > visibleCount && (
            <button
              type="button"
              className="chat-work-trigger"
              onClick={() => setVisibleCount((count) => count + 50)}
            >
              Show {Math.min(50, history.length - visibleCount)} earlier entries
              {history.length - visibleCount > 50
                ? ` (${history.length - visibleCount} remaining)`
                : ""}
            </button>
          )}
        </div>
      </WorkLogPanel>
    </Collapsible>
  );
});

/** Subscribes directly to the UI state store for diff scope state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  resolvedTheme,
  onOpenTurnDiff,
  workspaceRoot,
}: {
  turnSummary: TurnDiffSummary | undefined;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  workspaceRoot: string | undefined;
}) {
  if (!turnSummary) return null;
  const snapshotFiles = turnSummary.files;
  const turnFiles = turnSummary.turnFiles ?? [];
  if (snapshotFiles.length === 0 && turnFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
      workspaceRoot={workspaceRoot}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  resolvedTheme,
  onOpenTurnDiff,
  workspaceRoot,
}: {
  turnSummary: TurnDiffSummary;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  workspaceRoot: string | undefined;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const turnFiles = turnSummary.turnFiles ?? [];
  const visibleFiles = turnFiles;
  const summaryStat = summarizeTurnDiffStats(visibleFiles);
  if (summaryStat.additions === 0 && summaryStat.deletions === 0) return null;

  return (
    <div
      className="relative mt-4 rounded-2xl bg-card/40 shadow-xs/5 not-dark:bg-clip-padding after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-2xl after:border after:border-input"
      style={{
        fontSize: "var(--app-tool-font-size)",
      }}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-2xl bg-card/72 p-2 backdrop-blur-md">
        <div className="min-w-0 leading-4">
          <DiffStatLabel
            additions={summaryStat.additions}
            className="leading-4"
            deletions={summaryStat.deletions}
            layout="inline"
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="size-[1.5em] p-0 text-[inherit] sm:h-[1.5em] sm:text-[inherit]"
            disabled={visibleFiles.length === 0}
            onClick={() => onOpenTurnDiff(turnSummary.turnId, visibleFiles[0]?.path, "turn")}
            aria-label="View diff"
          >
            <DiffIcon className="size-[0.85em]" />
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="size-[1.5em] p-0 text-[inherit] sm:h-[1.5em] sm:text-[inherit]"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand changed files" : "Collapse changed files"}
          >
            {collapsed ? (
              <ChevronDownIcon className="size-[0.85em]" />
            ) : (
              <ChevronUpIcon className="size-[0.85em]" />
            )}
          </Button>
        </div>
      </div>
      {!collapsed && (
        <div className="px-2 pb-2">
          <ChangedFilesTree
            key={`changed-files-tree:${turnSummary.turnId}`}
            turnId={turnSummary.turnId}
            files={visibleFiles}
            allDirectoriesExpanded
            resolvedTheme={resolvedTheme}
            diffScope="turn"
            onOpenTurnDiff={onOpenTurnDiff}
            workspaceRoot={workspaceRoot}
          />
        </div>
      )}
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

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  rowId: string;
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  collapsedLineLimit: MessagePreviewLineCount;
  forceExpanded: boolean;
}) {
  const hasBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const contentRef = useRef<HTMLDivElement>(null);
  const previewHeightRef = useRef<HTMLDivElement>(null);
  const [hasRenderedOverflow, setHasRenderedOverflow] = useState(false);
  const measureRenderedOverflow = useCallback(() => {
    const content = contentRef.current;
    const previewHeight = previewHeightRef.current;
    if (!content || !previewHeight) return;

    const nextHasRenderedOverflow = exceedsMessagePreviewHeight(
      content.scrollHeight,
      previewHeight.getBoundingClientRect().height,
    );
    setHasRenderedOverflow((current) =>
      current === nextHasRenderedOverflow ? current : nextHasRenderedOverflow,
    );
  }, []);
  useLayoutEffect(measureRenderedOverflow);
  useEffect(() => {
    const content = contentRef.current;
    const previewHeight = previewHeightRef.current;
    if (!content || !previewHeight) return;

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureRenderedOverflow);
      return () => window.removeEventListener("resize", measureRenderedOverflow);
    }

    const observer = new ResizeObserver(measureRenderedOverflow);
    observer.observe(content);
    observer.observe(previewHeight);
    return () => observer.disconnect();
  }, [measureRenderedOverflow]);

  const isCollapsible =
    hasRenderedOverflow ||
    shouldCollapseUserMessage(props.text, props.terminalContexts, props.collapsedLineLimit);
  const [isExpandedOverride, setIsExpandedOverride] = useState<boolean | null>(null);
  const isExpanded = props.forceExpanded || !isCollapsible || isExpandedOverride === true;
  const isCollapsed = isCollapsible && !isExpanded;

  return (
    <>
      {hasBody ? (
        <div
          data-user-message-body="true"
          data-user-message-row-id={props.rowId}
          data-user-message-collapsible={String(isCollapsible)}
          data-user-message-collapsed={String(isCollapsed)}
          data-user-message-collapsed-line-limit={props.collapsedLineLimit}
          data-user-message-fade={String(isCollapsed)}
          className={cn("relative", isCollapsed ? "overflow-hidden" : null)}
          style={
            isCollapsed
              ? {
                  maxHeight: `${props.collapsedLineLimit}lh`,
                  maskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
                  WebkitMaskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
                }
              : undefined
          }
        >
          <div
            ref={previewHeightRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute h-auto w-px"
            style={{ height: `${props.collapsedLineLimit}lh` }}
          />
          <div ref={contentRef}>
            <UserMessageBody text={props.text} terminalContexts={props.terminalContexts} />
          </div>
        </div>
      ) : null}
      {isCollapsible ? (
        <div data-user-message-footer="true" className="mt-1.5 flex items-center justify-end gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={isExpanded}
            onClick={() => setIsExpandedOverride(!isExpanded)}
            className="mr-auto h-6 px-0 text-muted-foreground/70 text-xs hover:bg-transparent hover:text-foreground"
          >
            {isExpanded ? "Show less" : "Show full message"}
          </Button>
        </div>
      ) : null}
    </>
  );
});

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
          <div className="chat-message-content whitespace-pre-wrap wrap-break-word text-foreground">
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
      <div className="chat-message-content whitespace-pre-wrap wrap-break-word text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="chat-message-content whitespace-pre-wrap wrap-break-word text-foreground">
      {props.text}
    </div>
  );
});

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

function shouldCollapseUserMessage(
  text: string,
  terminalContexts: ReadonlyArray<ParsedTerminalContextEntry>,
  collapsedLineLimit: MessagePreviewLineCount,
): boolean {
  const trimmedText = text.trim();
  if (trimmedText.length >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) {
    return true;
  }
  const lineCount = trimmedText.length === 0 ? 0 : trimmedText.split(/\r\n|\r|\n/).length;
  return lineCount > collapsedLineLimit || terminalContexts.length > 2;
}

export function exceedsMessagePreviewHeight(contentHeight: number, previewHeight: number): boolean {
  return contentHeight > previewHeight + 1;
}

function resolveMessagePreviewLineLimit(
  originKind: NonNullable<TimelineMessage["origin"]>["kind"] | undefined,
  limits: MessagePreviewLineLimits,
): MessagePreviewLineCount {
  if (originKind === "cross-thread") return limits.crossThread;
  if (originKind === "pull-request-monitor") return limits.monitoring;
  return limits.normal;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
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
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryFullCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  return rawCommand ?? workEntry.command?.trim() ?? null;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntryNeedsAttention(workEntry)) return CircleAlertIcon;
  if (toolGroupAction(workEntry) === "read") return EyeIcon;
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

const WorkEntryDetails = memo(function WorkEntryDetails({
  workEntry,
}: {
  workEntry: TimelineWorkEntry;
}) {
  const output = extractCommandOutputText(workEntry.toolData);
  const command = workEntryFullCommand(workEntry);
  const fallback =
    !output && hasWorkLogToolData(workEntry.toolData)
      ? JSON.stringify(workEntry.toolData, null, 2)
      : undefined;
  const detail = [
    command,
    output ?? workEntry.detail,
    ...(output ? [] : (workEntry.changedFiles ?? [])),
    fallback === "{}" || fallback === "[]" ? undefined : fallback,
  ]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join("\n\n");
  if (!detail) return null;
  return (
    <div className="ml-[0.5em] border-l border-border/50 pl-[1em] py-1">
      <pre
        data-tool-command-details
        className="max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[length:inherit] text-muted-foreground"
      >
        {detail}
      </pre>
    </div>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  compact?: boolean;
  canExpandCommand?: boolean;
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { canExpandCommand = false, workEntry, workspaceRoot } = props;
  const [isCommandExpanded, setIsCommandExpanded] = useState(false);
  const navigate = useNavigate();
  const { activeThreadEnvironmentId } = use(TimelineRowCtx);
  if (workEntry.agentRun) {
    return <AgentRunRow agentRun={workEntry.agentRun} workspaceRoot={workspaceRoot} />;
  }
  const iconConfig = workToneIcon(workEntry.tone);
  const entryIcon = createElement(workEntryIcon(workEntry), { className: "size-3" });
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const fullCommand = workEntryFullCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;
  const CommandToggleIcon = isCommandExpanded ? ChevronDownIcon : ChevronRightIcon;
  const expandableCommand = canExpandCommand ? fullCommand : null;
  const actionHref =
    workEntry.action?.kind === "thread"
      ? buildThreadPath({
          environmentId: activeThreadEnvironmentId,
          threadId: workEntry.action.threadId,
        })
      : workEntry.action?.kind === "external"
        ? resolveExternalActionUrl(workEntry.action.url)
        : null;

  if (props.compact && !workEntry.action) {
    const hasDetail =
      Boolean(fullCommand || workEntry.detail || hasChangedFiles) ||
      hasWorkLogToolData(workEntry.toolData);
    const label = compactWorkEntryLabel(workEntry);
    const truncateLabel = toolGroupAction(workEntry) === "command";
    const failed = workEntryNeedsAttention(workEntry);
    return (
      <Collapsible open={isCommandExpanded} onOpenChange={setIsCommandExpanded}>
        <CollapsibleTrigger
          disabled={!hasDetail}
          aria-expanded={hasDetail ? isCommandExpanded : undefined}
          aria-label={
            hasDetail ? `${isCommandExpanded ? "Collapse" : "Expand"} details: ${label}` : label
          }
          className="chat-work-trigger text-muted-foreground disabled:cursor-default"
        >
          {failed ? (
            <CircleAlertIcon className="text-amber-700 dark:text-amber-400" aria-hidden="true" />
          ) : (
            entryIcon
          )}
          <span
            className={cn("chat-work-label", truncateLabel && "chat-work-label-truncate")}
            title={label}
          >
            {label}
          </span>
          {hasDetail ? (
            <ChevronRightIcon
              className={cn("size-3 shrink-0 chat-work-chevron", isCommandExpanded && "rotate-90")}
              aria-hidden="true"
            />
          ) : null}
        </CollapsibleTrigger>
        <WorkLogPanel open={isCommandExpanded}>
          <WorkEntryDetails workEntry={workEntry} />
        </WorkLogPanel>
      </Collapsible>
    );
  }

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          {entryIcon}
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {expandableCommand ? (
            <button
              type="button"
              className="flex w-full min-w-0 items-start gap-1 text-left"
              onClick={() => setIsCommandExpanded((value) => !value)}
              aria-expanded={isCommandExpanded}
              aria-label={`${isCommandExpanded ? "Collapse" : "Expand"} command: ${heading}`}
            >
              {isCommandExpanded ? (
                <code
                  data-tool-command-details
                  data-testid="tool-command-details"
                  className="block min-w-0 flex-1 overflow-x-auto rounded-md border border-border/45 bg-background/60 px-2 py-1.5 font-mono text-[0.9em] leading-[1.5] whitespace-pre-wrap wrap-break-word text-foreground/80"
                >
                  {expandableCommand}
                </code>
              ) : (
                <p
                  className={cn(
                    "min-w-0 flex-1 truncate text-[length:inherit] leading-[1.67]",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                  title={displayText}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              )}
              <CommandToggleIcon
                className="size-3 shrink-0 text-muted-foreground/55"
                aria-hidden="true"
              />
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-[length:inherit] leading-[1.67]",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-[length:inherit] leading-[1.67]">
                  {displayText}
                </p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        {workEntry.action && actionHref ? (
          <a
            href={actionHref}
            {...(workEntry.action.kind === "external"
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
            onClick={(event) => {
              if (workEntry.action?.kind !== "thread") return;
              if (!shouldHandleInternalActionClick(event)) return;
              event.preventDefault();
              void navigate({
                to: "/$environmentId/$threadId",
                params: {
                  environmentId: activeThreadEnvironmentId,
                  threadId: workEntry.action.threadId,
                },
              });
            }}
            className="shrink-0 text-[0.9em] font-medium text-primary hover:underline"
          >
            {workEntry.action.label}
          </a>
        ) : null}
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[0.85em] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[0.85em] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

const AgentRunRow = memo(function AgentRunRow({
  agentRun,
  workspaceRoot,
}: {
  agentRun: AgentRun;
  workspaceRoot: string | undefined;
}) {
  const { activeThreadEnvironmentId, activeThreadId } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(agentRun.status === "running");
  const ToggleIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
  const status =
    agentRun.status === "running"
      ? "Running"
      : agentRun.status === "completed"
        ? "Completed"
        : agentRun.status === "stopped"
          ? "Stopped"
          : "Failed";

  return (
    <div className="rounded-lg border border-border/50 bg-background/45 px-2 py-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setIsExpanded((value) => !value)}
        aria-expanded={isExpanded}
      >
        <ToggleIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground/85">{agentRun.name}</span>
        <span className="text-[0.8em] text-muted-foreground/65">{status}</span>
      </button>
      {isExpanded && (
        <AgentRunTranscript
          agentRun={agentRun}
          workspaceRoot={workspaceRoot}
          threadRef={{
            environmentId: activeThreadEnvironmentId,
            threadId: activeThreadId,
          }}
          compact
        />
      )}
    </div>
  );
});

const AgentRunTranscript = memo(function AgentRunTranscript({
  agentRun,
  workspaceRoot,
  threadRef,
  compact = false,
}: {
  agentRun: AgentRun;
  workspaceRoot: string | undefined;
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  compact?: boolean;
}) {
  return (
    <div className={compact ? "mt-2 border-l border-border/50 pl-3" : "space-y-3"}>
      {agentRun.prompt ? (
        compact ? (
          <div className="rounded-md bg-muted/35 px-3 py-2 whitespace-pre-wrap text-muted-foreground">
            {agentRun.prompt}
          </div>
        ) : (
          <div className="flex justify-end">
            <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3 whitespace-pre-wrap">
              {agentRun.prompt}
            </div>
          </div>
        )
      ) : null}
      {agentRun.entries.map((entry) => (
        <SimpleWorkEntryRow
          key={`agent-entry:${entry.id}`}
          workEntry={entry}
          workspaceRoot={workspaceRoot}
        />
      ))}
      {agentRun.summary ? (
        compact ? (
          <div className="min-w-0 px-1 py-0.5 text-muted-foreground/80">
            <ChatMarkdown
              text={agentRun.summary}
              cwd={workspaceRoot}
              isStreaming={false}
              threadRef={threadRef}
            />
          </div>
        ) : (
          <div className="min-w-0 px-1 py-0.5">
            <ChatMarkdown
              text={agentRun.summary}
              cwd={workspaceRoot}
              isStreaming={false}
              threadRef={threadRef}
            />
          </div>
        )
      ) : null}
      <div className="text-[0.75em] tracking-wide text-muted-foreground/50">
        Background{agentRun.agentType ? ` ${agentRun.agentType}` : ""} agent
        {agentRun.model ? ` · ${agentRun.model}` : ""}
        {agentRun.reasoningEffort ? ` · ${agentRun.reasoningEffort}` : ""}
      </div>
    </div>
  );
});
