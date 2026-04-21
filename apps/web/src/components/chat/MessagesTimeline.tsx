import { type EnvironmentId, type MessageId, type TurnId } from "@marcode/contracts";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
// Virtualization replaced with CSS content-visibility: auto for overlap-free
// rendering. See commit 8d4da730 for the original removal rationale.
import { deriveTimelineEntries, formatElapsed, type PendingApproval } from "../../session-logic";
// AUTO_SCROLL_BOTTOM_THRESHOLD_PX no longer needed without virtualizer
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import { type ComposerImageAttachment, useComposerDraftStore } from "../../composerDraftStore";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ImagePlusIcon,
  LoaderCircleIcon,
  type LucideIcon,
  SendIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { estimateTimelineMessageHeight } from "../timelineHeight";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import AnimatedChatMarkdown from "./TextReveal";
import {
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { FileChangeCard } from "./FileChangeCard";
import { AgentGroupCard } from "./AgentGroupCard";
import { CommandExecutionCard } from "./CommandExecutionCard";
import { ExplorationCard } from "./ExplorationCard";
import { WebSearchCard } from "./WebSearchCard";
import { WebFetchCard } from "./WebFetchCard";
import { McpToolCallCard } from "./McpToolCallCard";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";
import { extractTrailingJiraContexts, type ParsedJiraContextEntry } from "~/lib/jiraContext";
import { JiraTaskInlineChip } from "./JiraTaskInlineChip";
import { SelectionReplyToolbar } from "./SelectionReplyToolbar";
import { extractLeadingQuotedContexts, type QuotedContext } from "~/lib/quotedContext";
import { UserMessageQuotedContextLabel } from "./UserMessageQuotedContextLabel";
import { type TimestampFormat } from "@marcode/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

const EMPTY_EDIT_IMAGES: ComposerImageAttachment[] = [];

function TimelineSkeleton() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl px-1">
      <div className="flex flex-col gap-6 py-4">
        <div className="flex items-start gap-3">
          <Skeleton className="mt-0.5 size-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4 rounded" />
            <Skeleton className="h-4 w-1/2 rounded" />
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="mt-0.5 size-6 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-5/6 rounded" />
            <Skeleton className="h-4 w-4/6 rounded" />
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-4 w-3/5 rounded" />
          </div>
        </div>

        <div className="flex items-start gap-3">
          <Skeleton className="mt-0.5 size-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3 rounded" />
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="mt-0.5 size-6 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-4 w-4/5 rounded" />
            <Skeleton className="h-4 w-2/3 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

interface MessagesTimelineProps {
  threadId: string;
  hasMessages: boolean;
  isHydrating: boolean;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  scrollContainer: HTMLDivElement | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  nowIso: string;
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
  isSendBusy: boolean;
  isSessionStarting: boolean;
  hasPendingAssistantResponse: boolean;
  isPreparingWorktree: boolean;
  isCompacting: boolean;
  onSubagentSelect: (taskId: string) => void;
  pendingApprovals?: ReadonlyArray<PendingApproval>;
  editingUserMessageId: MessageId | null;
  editingUserMessageText: string;
  editingUserMessageImages: ComposerImageAttachment[];
  onStartEditUserMessage: (message: ChatMessage) => void;
  onChangeEditingUserMessageText: (text: string) => void;
  onAddEditingUserMessageImages: (files: File[]) => void;
  onRemoveEditingUserMessageImage: (imageId: string) => void;
  onCancelEditUserMessage: () => void;
  onSubmitEditUserMessage: () => void | Promise<void>;
  onReplyToSelection: (context: QuotedContext) => void;
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

let timelineHasMountedInSession = false;

const INITIAL_RENDER_ROW_CAP = 15;

export const MessagesTimeline = memo(function MessagesTimeline({
  threadId,
  hasMessages,
  isHydrating,
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  scrollContainer: _scrollContainer,
  timelineEntries,
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
  isSendBusy,
  isSessionStarting,
  hasPendingAssistantResponse,
  isPreparingWorktree,
  isCompacting,
  onSubagentSelect,
  pendingApprovals,
  editingUserMessageId,
  editingUserMessageText,
  editingUserMessageImages,
  onStartEditUserMessage,
  onChangeEditingUserMessageText,
  onAddEditingUserMessageImages,
  onRemoveEditingUserMessageImage,
  onCancelEditUserMessage,
  onSubmitEditUserMessage,
  onReplyToSelection,
  onVirtualizerSnapshot: _onVirtualizerSnapshot,
}: MessagesTimelineProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);
  const [skipInitialFadeIn] = useState(() => {
    const draftStore = useComposerDraftStore.getState();
    for (const draft of Object.values(draftStore.draftThreadsByThreadKey)) {
      if (draft.promotedTo?.threadId === threadId) {
        return true;
      }
    }
    if (timelineHasMountedInSession) {
      return true;
    }
    timelineHasMountedInSession = true;
    return false;
  });

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

  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
      }),
    [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt],
  );

  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const pendingRevealRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);
  const wasHydratingRef = useRef(isHydrating);
  const pendingHydrationSeedRef = useRef(isHydrating);

  const newAssistantMessageIds = useMemo(() => {
    if (isHydrating && !pendingHydrationSeedRef.current) {
      pendingHydrationSeedRef.current = true;
    }
    wasHydratingRef.current = isHydrating;

    if (threadId !== prevThreadIdRef.current) {
      knownMessageIdsRef.current = new Set<string>();
      pendingRevealRef.current = new Set<string>();
      pendingHydrationSeedRef.current = isHydrating;
      for (const row of rows) {
        if (row.kind === "message" && row.message.role === "assistant") {
          knownMessageIdsRef.current.add(row.message.id);
        }
      }
      prevThreadIdRef.current = threadId;
      return new Set<string>();
    }

    if (pendingHydrationSeedRef.current) {
      for (const row of rows) {
        if (row.kind === "message" && row.message.role === "assistant") {
          knownMessageIdsRef.current.add(row.message.id);
        }
      }
      const hasMessageRows = rows.some((row) => row.kind === "message");
      if (hasMessageRows && !isHydrating) {
        pendingHydrationSeedRef.current = false;
      }
      return new Set<string>();
    }

    const fresh = new Set<string>();
    for (const row of rows) {
      if (row.kind !== "message" || row.message.role !== "assistant") continue;
      const id = row.message.id;

      if (pendingRevealRef.current.has(id)) {
        if (!row.message.streaming) {
          pendingRevealRef.current.delete(id);
          fresh.add(id);
        }
        continue;
      }

      if (!knownMessageIdsRef.current.has(id)) {
        knownMessageIdsRef.current.add(id);
        if (row.message.streaming) {
          pendingRevealRef.current.add(id);
        }
      }
    }
    return fresh;
  }, [rows, threadId, isHydrating]);

  const showInlineDiffs = expandedWorkGroups;

  const [hydratedFully, setHydratedFully] = useState(() => rows.length <= INITIAL_RENDER_ROW_CAP);
  useEffect(() => {
    if (hydratedFully) return;
    startTransition(() => {
      setHydratedFully(true);
    });
  }, [hydratedFully]);
  const visibleRows = hydratedFully ? rows : rows.slice(-INITIAL_RENDER_ROW_CAP);
  const hiddenRowsCount = rows.length - visibleRows.length;
  const hiddenRowsHeight = useMemo(() => {
    if (hiddenRowsCount === 0) return 0;
    return rows
      .slice(0, hiddenRowsCount)
      .reduce((acc, row) => acc + estimateRowHeight(row, showInlineDiffs, timelineWidthPx), 0);
  }, [hiddenRowsCount, rows, showInlineDiffs, timelineWidthPx]);

  const onTimelineImageLoad = useCallback(() => {}, []);
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
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
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
                {visibleEntries.map((workEntry) => (
                  <SimpleWorkEntryRow
                    key={`work-row:${workEntry.id}`}
                    workEntry={workEntry}
                    workspaceRoot={workspaceRoot}
                  />
                ))}
              </div>
            </div>
          );
        })()}

      {row.kind === "file-change" && (
        <FileChangeCard
          diffPreviews={row.entry.diffPreviews ?? []}
          cwd={workspaceRoot}
          isPendingApproval={
            !row.entry.toolCompleted &&
            pendingApprovals !== undefined &&
            pendingApprovals.some((a) => a.requestKind === "file-change")
          }
        />
      )}

      {row.kind === "exploration" && (
        <ExplorationCard
          entries={row.entries}
          isLive={row.isLive}
          isPendingApproval={
            row.entries.some((e) => !e.toolCompleted) &&
            pendingApprovals !== undefined &&
            pendingApprovals.some((a) => a.requestKind === "file-read")
          }
        />
      )}

      {row.kind === "agent-group" && row.entry.agentGroup && (
        <AgentGroupCard
          agentGroup={row.entry.agentGroup}
          label={row.entry.label}
          isLive={row.isLive}
          onTaskSelect={onSubagentSelect}
        />
      )}

      {row.kind === "command" && (
        <CommandExecutionCard
          entry={row.entry}
          isLive={row.isLive}
          threadId={threadId}
          isPendingApproval={
            !row.entry.toolCompleted &&
            row.entry.exitCode === undefined &&
            pendingApprovals !== undefined &&
            pendingApprovals.some((a) => a.requestKind === "command")
          }
        />
      )}

      {row.kind === "web-search" && <WebSearchCard entry={row.entry} isLive={row.isLive} />}

      {row.kind === "web-fetch" && <WebFetchCard entry={row.entry} isLive={row.isLive} />}

      {row.kind === "mcp-tool" && <McpToolCallCard entry={row.entry} isLive={row.isLive} />}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const isEditingThisMessage = editingUserMessageId === row.message.id;
          return (
            <EditableUserMessageTimelineRow
              message={row.message}
              isEditing={isEditingThisMessage}
              editText={isEditingThisMessage ? editingUserMessageText : ""}
              editImages={isEditingThisMessage ? editingUserMessageImages : EMPTY_EDIT_IMAGES}
              canRevertAgentWork={revertTurnCountByUserMessageId.has(row.message.id)}
              isRevertingCheckpoint={isRevertingCheckpoint}
              isWorking={isWorking}
              isSendBusy={isSendBusy}
              timestampFormat={timestampFormat}
              onImageExpand={onImageExpand}
              onTimelineImageLoad={onTimelineImageLoad}
              onStartEdit={onStartEditUserMessage}
              onChangeText={onChangeEditingUserMessageText}
              onAddImages={onAddEditingUserMessageImages}
              onRemoveImage={onRemoveEditingUserMessageImage}
              onCancel={onCancelEditUserMessage}
              onSubmit={onSubmitEditUserMessage}
              onRevert={onRevertUserMessage}
            />
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const assistantTurnStillInProgress =
            activeTurnInProgress &&
            activeTurnId !== null &&
            activeTurnId !== undefined &&
            row.message.turnId === activeTurnId;
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming || assistantTurnStillInProgress,
          });
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
              <div className="group/msg min-w-0 px-1 py-0.5">
                <AssistantMessageContentWithReply
                  messageId={row.message.id}
                  turnId={row.message.turnId ?? null}
                  onReplyToSelection={onReplyToSelection}
                >
                  <AnimatedChatMarkdown
                    text={messageText}
                    cwd={markdownCwd}
                    isStreaming={Boolean(row.message.streaming)}
                    animate={newAssistantMessageIds.has(row.message.id)}
                  />
                </AssistantMessageContentWithReply>
                {(() => {
                  const turnSummary = turnDiffSummaryByAssistantMessageId.get(row.message.id);
                  if (!turnSummary) return null;
                  const checkpointFiles = turnSummary.files;
                  if (checkpointFiles.length === 0) return null;
                  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
                  const changedFileCountLabel = String(checkpointFiles.length);
                  const allDirectoriesExpanded =
                    changedFilesExpandedByTurnId[turnSummary.turnId] ?? true;
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
                            data-scroll-anchor-ignore
                            onClick={() =>
                              onSetChangedFilesExpanded(turnSummary.turnId, !allDirectoriesExpanded)
                            }
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
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {formatMessageMeta(
                      row.message.createdAt,
                      row.message.streaming
                        ? formatElapsed(row.durationStart, nowIso)
                        : formatElapsed(row.durationStart, row.message.completedAt),
                      timestampFormat,
                    )}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/msg:opacity-100">
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
        })()}

      {row.kind === "proposed-plan" && (
        <div className="group min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={activeThreadEnvironmentId}
            cwd={markdownCwd}
            workspaceRoot={workspaceRoot}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
              <MessageCopyButton text={row.proposedPlan.planMarkdown} />
            </div>
          </div>
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <span className="shiny-text pt-1 text-xs font-semibold text-primary/60">
            {isPreparingWorktree
              ? "Preparing worktree\u2026"
              : isSendBusy || isSessionStarting || hasPendingAssistantResponse
                ? "Starting\u2026"
                : isCompacting
                  ? "Compacting\u2026"
                  : row.createdAt
                    ? `Working for ${formatWorkingTimer(row.createdAt, nowIso) ?? "0s"}`
                    : "Working\u2026"}
          </span>
        </div>
      )}
    </div>
  );

  const showSkeleton =
    isHydrating || (!hasMessages && !isWorking && pendingHydrationSeedRef.current);

  if (showSkeleton) {
    return <TimelineSkeleton />;
  }

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
      className={cn(
        "mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden",
        !skipInitialFadeIn && "timeline-fade-in",
      )}
    >
      {hiddenRowsCount > 0 && <div aria-hidden="true" style={{ blockSize: hiddenRowsHeight }} />}
      {visibleRows.map((row, index) => {
        const nearBottom = index >= visibleRows.length - 3;
        return (
          <div
            key={row.id}
            {...(row.kind === "message" ? { "data-row-message-id": row.message.id } : undefined)}
            style={
              nearBottom
                ? undefined
                : {
                    contentVisibility: "auto",
                    containIntrinsicBlockSize: `auto ${estimateRowHeight(row, showInlineDiffs, timelineWidthPx)}px`,
                  }
            }
          >
            {renderRowContent(row)}
          </div>
        );
      })}
    </div>
  );
});

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function estimateRowHeight(
  row: TimelineRow,
  _showInlineDiffs: Record<string, boolean>,
  timelineWidthPx: number | null,
): number {
  if (row.kind === "message") {
    return estimateTimelineMessageHeight(row.message, { timelineWidthPx });
  }
  if (row.kind === "proposed-plan") return 200;
  if (row.kind === "working") return 40;
  if (row.kind === "file-change") return 64;
  if (row.kind === "work") return 64;
  return 64;
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
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const JIRA_INLINE_LABEL_PATTERN = /@jira:([A-Z][A-Z0-9]+-\d+)/gi;

function renderTextWithJiraChips(
  text: string,
  keyPrefix: string,
  jiraContextMap: ReadonlyMap<string, ParsedJiraContextEntry>,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(JIRA_INLINE_LABEL_PATTERN)) {
    const matchStart = match.index ?? 0;
    const issueKey = match[1] ?? "";
    if (matchStart > cursor) {
      nodes.push(<span key={`${keyPrefix}-text-${cursor}`}>{text.slice(cursor, matchStart)}</span>);
    }
    const context = jiraContextMap.get(issueKey.toUpperCase());
    nodes.push(
      <JiraTaskInlineChip
        key={`${keyPrefix}-jira-${issueKey}`}
        label={issueKey}
        tooltipText={context ? context.header : issueKey}
        detailHeader={context?.header}
        detailBody={context?.body}
      />,
    );
    cursor = matchStart + match[0].length;
  }
  if (cursor === 0) return [];
  if (cursor < text.length) {
    nodes.push(<span key={`${keyPrefix}-text-rest`}>{text.slice(cursor)}</span>);
  }
  return nodes;
}

const EditableUserMessageTimelineRow = memo(function EditableUserMessageTimelineRow(props: {
  message: TimelineMessage;
  isEditing: boolean;
  editText: string;
  editImages: ComposerImageAttachment[];
  canRevertAgentWork: boolean;
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  isSendBusy: boolean;
  timestampFormat: TimestampFormat;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onTimelineImageLoad: () => void;
  onStartEdit: (message: ChatMessage) => void;
  onChangeText: (text: string) => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (imageId: string) => void;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
  onRevert: (messageId: MessageId) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);
  const { onSubmit, onCancel, onAddImages } = props;

  const handleEditSubmit = useCallback(() => {
    if (isSubmittingEdit) return;
    setIsSubmittingEdit(true);
    Promise.resolve(onSubmit()).finally(() => setIsSubmittingEdit(false));
  }, [onSubmit, isSubmittingEdit]);

  useEffect(() => {
    if (props.isEditing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [props.isEditing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleEditSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    },
    [handleEditSubmit, onCancel],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        onAddImages(Array.from(files));
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [onAddImages],
  );

  const isBusy = props.isWorking || props.isSendBusy || isSubmittingEdit;
  const canSubmitEdit =
    !isBusy && (props.editText.trim().length > 0 || props.editImages.length > 0);
  const lineCount = props.editText.split("\n").length;

  if (props.isEditing) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm border border-primary/40 bg-secondary px-4 py-3">
          <Textarea
            ref={textareaRef}
            unstyled
            rows={Math.max(3, Math.min(10, lineCount + 1))}
            value={props.editText}
            onChange={(e) => props.onChangeText(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full resize-none bg-transparent text-sm text-foreground outline-none"
            aria-label="Edit message"
          />
          {props.editImages.length > 0 && (
            <div className="mt-2 grid max-w-[420px] grid-cols-2 gap-2">
              {props.editImages.map((image) => (
                <div
                  key={image.id}
                  className="group/img relative overflow-hidden rounded-lg border border-border/80 bg-background/70"
                >
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="block h-auto max-h-[220px] w-full object-cover"
                  />
                  <button
                    type="button"
                    className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover/img:opacity-100"
                    onClick={() => props.onRemoveImage(image.id)}
                    aria-label={`Remove ${image.name}`}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                title="Add image"
                disabled={isBusy}
              >
                <ImagePlusIcon className="size-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={props.onCancel}
                disabled={isBusy}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="xs"
                variant="default"
                onClick={handleEditSubmit}
                disabled={!canSubmitEdit}
                title="Send edited message (⌘+Enter)"
              >
                {isSubmittingEdit ? (
                  <LoaderCircleIcon className="size-3 animate-spin" />
                ) : (
                  <SendIcon className="size-3" />
                )}
                {isSubmittingEdit ? "Saving..." : "Send"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const userImages = props.message.attachments ?? [];
  const quotedExtracted = extractLeadingQuotedContexts(props.message.text);
  const afterQuotedText =
    quotedExtracted.contextCount > 0 ? quotedExtracted.promptText : props.message.text;
  const displayedUserMessage = deriveDisplayedUserMessageState(afterQuotedText);
  const terminalContexts = displayedUserMessage.contexts;
  const jiraExtracted = extractTrailingJiraContexts(displayedUserMessage.visibleText);
  const visibleText =
    jiraExtracted.contexts.length > 0 ? jiraExtracted.promptText : displayedUserMessage.visibleText;
  const jiraContextMap = new Map(
    jiraExtracted.contexts.map((ctx) => {
      const keyMatch = ctx.header.match(/^\[([A-Z][A-Z0-9]+-\d+)]/);
      return [keyMatch?.[1]?.toUpperCase() ?? "", ctx] as const;
    }),
  );

  return (
    <div className="flex justify-end">
      <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
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
        )}
        {quotedExtracted.contexts.length > 0 && (
          <UserMessageQuotedContextLabel contexts={quotedExtracted.contexts} />
        )}
        {(visibleText.trim().length > 0 || terminalContexts.length > 0) && (
          <UserMessageBody
            text={visibleText}
            terminalContexts={terminalContexts}
            jiraContextMap={jiraContextMap}
          />
        )}
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
            {displayedUserMessage.copyText && (
              <MessageCopyButton text={displayedUserMessage.copyText} />
            )}
            {props.canRevertAgentWork && (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={props.isRevertingCheckpoint || props.isWorking}
                  onClick={() => props.onStartEdit(props.message)}
                  title="Edit message"
                >
                  <SquarePenIcon className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={props.isRevertingCheckpoint || props.isWorking}
                  onClick={() => props.onRevert(props.message.id)}
                  title="Revert to this message"
                >
                  <Undo2Icon className="size-3" />
                </Button>
              </>
            )}
          </div>
          <p className="text-right text-[10px] text-muted-foreground/30">
            {formatTimestamp(props.message.createdAt, props.timestampFormat)}
          </p>
        </div>
      </div>
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  jiraContextMap: ReadonlyMap<string, ParsedJiraContextEntry>;
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
          <div className="wrap-break-word whitespace-pre-wrap text-sm leading-relaxed text-foreground">
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
      <div className="wrap-break-word whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  const jiraChipNodes = renderTextWithJiraChips(props.text, "user-msg", props.jiraContextMap);
  if (jiraChipNodes.length > 0) {
    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {jiraChipNodes}
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {props.text}
    </div>
  );
});

const AssistantMessageContentWithReply = memo(function AssistantMessageContentWithReply(props: {
  messageId: MessageId;
  turnId: TurnId | null;
  children: ReactNode;
  onReplyToSelection: (context: QuotedContext) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={containerRef} className="relative">
      {props.children}
      <SelectionReplyToolbar
        messageId={props.messageId}
        turnId={props.turnId}
        containerRef={containerRef}
        onReply={props.onReplyToSelection}
      />
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
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry, workspaceRoot);
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
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
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
