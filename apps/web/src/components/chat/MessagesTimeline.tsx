import {
  type EnvironmentId,
  type MessageId,
  type ThreadId,
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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { deriveTimelineEntries, formatElapsed, type AgentRun } from "../../session-logic";
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
  DiffIcon,
  EyeIcon,
  GitBranchIcon,
  GitForkIcon,
  GlobeIcon,
  HammerIcon,
  InfoIcon,
  PaintbrushIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  collectReviewOutputMessageIds,
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveWorkGroupExpanded,
  stabilizeReadonlyStringSet,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type WorkGroupExpansionOverride,
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
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via useContext.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  completionSummary: string | null;
  copilotResumeCommand: string | null;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  activeChatFindRowId: string | null;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  onRevertUserMessage: (messageId: MessageId) => void;
  onForkAssistantMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  reviewOutputMessageIds: ReadonlySet<string>;
  responseMetaByTurnId: ReadonlyMap<TurnId, AssistantResponseMeta>;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const NOOP_FORK_ASSISTANT_MESSAGE = () => undefined;
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
  workspaceRoot: string | undefined;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  activeChatFindRowId?: string | null;
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

const USER_MESSAGE_COLLAPSE_LINE_THRESHOLD = 8;
const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 900;

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
  workspaceRoot,
  onIsAtEndChange,
  activeChatFindRowId = null,
  reviewResultActive = false,
  hasMoreOlder = false,
  loadingOlder = false,
  onLoadOlder,
}: MessagesTimelineProps) {
  const handleForkAssistantMessage = onForkAssistantMessage ?? NOOP_FORK_ASSISTANT_MESSAGE;
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

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
      if (state.isAtStart && hasMoreOlder && !loadingOlder) {
        onLoadOlder?.();
      }
    }
  }, [hasMoreOlder, listRef, loadingOlder, onIsAtEndChange, onLoadOlder]);

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

  // Memoised context value — only changes on state transitions, NOT on
  // every streaming chunk. Callbacks from ChatView are useCallback-stable.
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      activeTurnInProgress,
      activeTurnId: activeTurnId ?? null,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      copilotResumeCommand,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      activeThreadId,
      activeChatFindRowId,
      onRevertUserMessage,
      onForkAssistantMessage: handleForkAssistantMessage,
      onImageExpand,
      onOpenTurnDiff,
      reviewOutputMessageIds,
      responseMetaByTurnId,
    }),
    [
      activeTurnInProgress,
      activeTurnId,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      copilotResumeCommand,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      activeThreadId,
      activeChatFindRowId,
      onRevertUserMessage,
      handleForkAssistantMessage,
      onImageExpand,
      onOpenTurnDiff,
      reviewOutputMessageIds,
      responseMetaByTurnId,
    ],
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
        ListHeaderComponent={listHeader}
        ListFooterComponent={<div className="h-3 sm:h-4" />}
      />
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

function TimelineRowContent(props: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);
  const { row } = props;

  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-chat-find-active={ctx.activeChatFindRowId === row.id ? "true" : undefined}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
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
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
                {regularImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {regularImages.map(
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
                                const preview = buildExpandedImagePreview(regularImages, image.id);
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
                      ),
                    )}
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
                  forceExpanded={ctx.activeChatFindRowId === row.id}
                  footer={
                    <>
                      <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                        {displayedUserMessage.copyText && (
                          <MessageCopyButton text={displayedUserMessage.copyText} />
                        )}
                        {canRevertAgentWork && (
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                            onClick={() => ctx.onRevertUserMessage(row.message.id)}
                            title="Revert to this message"
                          >
                            <Undo2Icon className="size-3" />
                          </Button>
                        )}
                      </div>
                      <p className="text-right text-xs text-muted-foreground/50">
                        {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                      </p>
                    </>
                  }
                />
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const assistantTurnStillInProgress =
            ctx.activeTurnInProgress &&
            ctx.activeTurnId !== null &&
            ctx.activeTurnId !== undefined &&
            row.message.turnId === ctx.activeTurnId;
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
          const responseMeta =
            !row.showAssistantTerminalMetadata ||
            row.message.streaming ||
            assistantTurnStillInProgress ||
            row.message.turnId === null ||
            row.message.turnId === undefined
              ? undefined
              : ctx.responseMetaByTurnId.get(row.message.turnId);
          return (
            <>
              <div className="min-w-0 px-1 py-0.5">
                {ctx.reviewOutputMessageIds.has(row.id) ? null : (
                  <ChatMarkdown
                    text={messageText}
                    cwd={ctx.markdownCwd}
                    isStreaming={Boolean(row.message.streaming)}
                    threadRef={{
                      environmentId: ctx.activeThreadEnvironmentId,
                      threadId: ctx.activeThreadId,
                    }}
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
                  {row.showAssistantTerminalMetadata &&
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
                        onClick={() => ctx.onForkAssistantMessage(row.message.id)}
                      >
                        <GitForkIcon className="size-3" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

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
        <div className="py-0.5 pl-1.5">
          <div className="flex items-center gap-2 pt-1 text-[7.5px] text-muted-foreground/50">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-status-pulse [animation-delay:400ms]" />
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
}

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

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

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
// Self-ticking components — bypass LegendList memoisation entirely.
// Each owns a `nowMs` state value consumed in the render output so the
// React Compiler cannot elide the re-render as a no-op.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
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
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [durationStart]);
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
  const { workspaceRoot } = use(TimelineRowCtx);
  const onlyToolEntries =
    groupedEntries.length > 0 && groupedEntries.every((entry) => entry.tone === "tool");
  const [expansionOverride, setExpansionOverride] = useState<WorkGroupExpansionOverride>(null);
  const isExpanded = resolveWorkGroupExpanded({
    shouldAutoCollapse,
    expansionOverride,
  });
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    shouldAutoCollapse && !isExpanded
      ? []
      : hasOverflow && !isExpanded
        ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
        : groupedEntries;
  const showHeader = shouldAutoCollapse || hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries ? "Tool Calls" : "Work log";
  const showCollapseToggle = shouldAutoCollapse || hasOverflow;
  const CollapseIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
  const toggleLabel = isExpanded ? "Collapse" : "Expand";

  return (
    <div className="work-group-section rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader &&
        (showCollapseToggle ? (
          <button
            type="button"
            className="mb-1.5 flex w-full items-center justify-between gap-2 px-0.5 text-left text-[0.75em] tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
            onClick={() => setExpansionOverride(isExpanded ? "collapsed" : "expanded")}
            aria-expanded={isExpanded}
            aria-label={`${toggleLabel} ${groupLabel} (${groupedEntries.length})`}
          >
            <span>
              {groupLabel} ({groupedEntries.length})
            </span>
            <CollapseIcon className="size-3 shrink-0" />
          </button>
        ) : (
          <div className="mb-1.5 flex items-center px-0.5">
            <p className="text-[0.75em] tracking-[0.12em] text-muted-foreground/55">
              {groupLabel} ({groupedEntries.length})
            </p>
          </div>
        ))}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={`work-row:${workEntry.id}`}
            canExpandCommand={onlyToolEntries}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </div>
  );
});

const ReasoningSection = memo(function ReasoningSection({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "reasoning" }>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const CollapseIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;
  const label = row.workedFor ? `Worked for ${row.workedFor}` : "Worked";

  return (
    <div className="my-2 px-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 text-[9px] text-muted-foreground/50 transition-colors hover:text-foreground/70"
          onClick={() => setIsExpanded((value) => !value)}
          aria-expanded={isExpanded}
        >
          <span>{label}</span>
          <CollapseIcon className="size-3" />
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
      {isExpanded && (
        <div className="mt-3">
          {row.rows.map((nestedRow) => (
            <TimelineRowContent key={`reasoning-row:${nestedRow.id}`} row={nestedRow} />
          ))}
        </div>
      )}
    </div>
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
  forceExpanded: boolean;
  footer: ReactNode;
}) {
  const hasBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const isCollapsible = shouldCollapseUserMessage(props.text, props.terminalContexts);
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
          data-user-message-fade={String(isCollapsed)}
          className={cn("relative", isCollapsed ? "max-h-44 overflow-hidden" : null)}
          style={
            isCollapsed
              ? {
                  maskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
                  WebkitMaskImage: "linear-gradient(to bottom, black 65%, transparent 100%)",
                }
              : undefined
          }
        >
          <UserMessageBody text={props.text} terminalContexts={props.terminalContexts} />
        </div>
      ) : null}
      <div data-user-message-footer="true" className="mt-1.5 flex items-center justify-end gap-2">
        {isCollapsible ? (
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
        ) : null}
        {props.footer}
      </div>
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
): boolean {
  const trimmedText = text.trim();
  if (trimmedText.length >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD) {
    return true;
  }
  const lineCount = trimmedText.length === 0 ? 0 : trimmedText.split(/\r\n|\r|\n/).length;
  return lineCount > USER_MESSAGE_COLLAPSE_LINE_THRESHOLD || terminalContexts.length > 2;
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
  canExpandCommand?: boolean;
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { canExpandCommand = false, workEntry, workspaceRoot } = props;
  const [isCommandExpanded, setIsCommandExpanded] = useState(false);
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
        <AgentRunTranscript agentRun={agentRun} workspaceRoot={workspaceRoot} compact />
      )}
    </div>
  );
});

const AgentRunTranscript = memo(function AgentRunTranscript({
  agentRun,
  workspaceRoot,
  compact = false,
}: {
  agentRun: AgentRun;
  workspaceRoot: string | undefined;
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
          <div className="whitespace-pre-wrap text-muted-foreground/80">{agentRun.summary}</div>
        ) : (
          <div className="min-w-0 px-1 py-0.5">
            <ChatMarkdown text={agentRun.summary} cwd={workspaceRoot} isStreaming={false} />
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
