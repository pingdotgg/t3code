import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationThreadActivity,
  type ScopedThreadRef,
  type ThreadId,
  type TurnDiffScope,
  type TurnId,
  type TimestampFormat,
} from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSearch } from "@tanstack/react-router";
import {
  deriveCompletionDividerBeforeEntryId,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  hasToolActivityForTurn,
  inferCheckpointTurnCountByTurnId,
} from "../../session-logic";
import { useStore } from "../../store";
import { createThreadMessagesSelectorByRef } from "../../storeSelectors";
import {
  type ChatMessage,
  type ProposedPlan,
  type Thread,
  type TurnDiffSummary,
} from "../../types";
import { revokeBlobPreviewUrl } from "../../pendingTurnStore";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { MessagesTimeline, type AssistantResponseMeta } from "./MessagesTimeline";
import { FindInChatBar } from "./FindInChatBar";
import { useChatFind, type ChatFindController } from "./useChatFind";
import { scrollTimelineRowIntoView } from "./useChatFind";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { parseThreadMessageRouteSearch } from "../../threadRoutes";

const EMPTY_OPTIMISTIC_USER_MESSAGES: ChatMessage[] = [];

export interface ChatTimelineSectionHandle {
  handoffAttachmentPreviews: (messageId: MessageId, previewUrls: string[]) => void;
  getFindController: () => ChatFindController | null;
}

interface ChatTimelineSectionProps {
  routeThreadRef: ScopedThreadRef | null;
  routeThreadKey: string;
  isServerThread: boolean;
  draftMessages?: ChatMessage[];
  optimisticUserMessages?: ChatMessage[];
  threadId: ThreadId;
  threadEnvironmentId: EnvironmentId;
  proposedPlans: ProposedPlan[];
  turnDiffSummaries: TurnDiffSummary[];
  threadActivities: ReadonlyArray<OrchestrationThreadActivity>;
  latestTurn: Thread["latestTurn"];
  latestTurnSettled: boolean;
  sessionActivelyWorking: boolean;
  isSendBusy: boolean;
  isWorking: boolean;
  timelineActiveWork: boolean;
  activeWorkStartedAt: string | null;
  copilotResumeCommand: string | null;
  isRevertingCheckpoint: boolean;
  reviewResultActive: boolean;
  listRef: RefObject<LegendListRef | null>;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  gitCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  chatFindShortcutLabel: string | null;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  onRevertToTurnCount: (turnCount: number) => void | Promise<void>;
  onForkAssistantMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onIsAtEndChange: (isAtEnd: boolean) => void;
}

export const ChatTimelineSection = forwardRef<ChatTimelineSectionHandle, ChatTimelineSectionProps>(
  function ChatTimelineSection(props, ref) {
    const {
      routeThreadRef,
      routeThreadKey,
      isServerThread,
      draftMessages,
      optimisticUserMessages = EMPTY_OPTIMISTIC_USER_MESSAGES,
      threadId,
      threadEnvironmentId,
      proposedPlans,
      turnDiffSummaries: turnDiffSummariesProp,
      threadActivities,
      latestTurn,
      latestTurnSettled,
      sessionActivelyWorking,
      isSendBusy,
      isWorking,
      timelineActiveWork,
      activeWorkStartedAt,
      copilotResumeCommand,
      isRevertingCheckpoint,
      reviewResultActive,
      listRef,
      messagesViewportRef,
      gitCwd,
      resolvedTheme,
      timestampFormat,
      workspaceRoot,
      chatFindShortcutLabel,
      hasMoreOlder,
      loadingOlder,
      onLoadOlder,
      onOpenTurnDiff,
      onRevertToTurnCount,
      onForkAssistantMessage,
      onImageExpand,
      onIsAtEndChange,
    } = props;

    const serverMessages = useStore(
      useMemo(
        () => createThreadMessagesSelectorByRef(isServerThread ? routeThreadRef : null),
        [isServerThread, routeThreadRef],
      ),
    );
    const sourceMessages = isServerThread ? serverMessages : (draftMessages ?? []);

    const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
      Record<string, string[]>
    >({});
    const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
    const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});

    useEffect(() => {
      attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
    }, [attachmentPreviewHandoffByMessageId]);

    const clearAttachmentPreviewHandoff = useCallback(
      (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        const currentPreviewUrls =
          previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
        const existing = attachmentPreviewHandoffByMessageIdRef.current;
        if (messageId in existing) {
          const next = { ...existing };
          delete next[messageId];
          attachmentPreviewHandoffByMessageIdRef.current = next;
          setAttachmentPreviewHandoffByMessageId(next);
        }
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      },
      [],
    );

    const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
      if (previewUrls.length === 0) return;

      const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      for (const previewUrl of previousPreviewUrls) {
        if (!previewUrls.includes(previewUrl)) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      const next = {
        ...attachmentPreviewHandoffByMessageIdRef.current,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      setAttachmentPreviewHandoffByMessageId(next);
    }, []);

    useEffect(() => {
      return () => {
        attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
        for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
          for (const previewUrl of previewUrls) {
            revokeBlobPreviewUrl(previewUrl);
          }
        }
        attachmentPreviewHandoffByMessageIdRef.current = {};
      };
    }, []);

    useEffect(() => {
      if (typeof Image === "undefined" || sourceMessages.length === 0) {
        return;
      }

      const cleanups: Array<() => void> = [];

      for (const [messageId, handoffPreviewUrls] of Object.entries(
        attachmentPreviewHandoffByMessageId,
      )) {
        if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
          continue;
        }

        const serverMessage = sourceMessages.find(
          (message) => message.id === messageId && message.role === "user",
        );
        if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
          continue;
        }

        const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
          attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
        );
        if (
          serverPreviewUrls.length === 0 ||
          serverPreviewUrls.length !== handoffPreviewUrls.length ||
          serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
        ) {
          continue;
        }

        attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

        let cancelled = false;
        const imageInstances: HTMLImageElement[] = [];

        const preloadServerPreviews = Promise.all(
          serverPreviewUrls.map(
            (previewUrl) =>
              new Promise<void>((resolve, reject) => {
                const image = new Image();
                imageInstances.push(image);
                const handleLoad = () => resolve();
                const handleError = () =>
                  reject(new Error(`Failed to load server preview for ${messageId}.`));
                image.addEventListener("load", handleLoad, { once: true });
                image.addEventListener("error", handleError, { once: true });
                image.src = previewUrl;
              }),
          ),
        );

        void preloadServerPreviews
          .then(() => {
            if (cancelled) {
              return;
            }
            clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
          })
          .catch(() => {
            if (!cancelled) {
              delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
            }
          });

        cleanups.push(() => {
          cancelled = true;
          delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          for (const image of imageInstances) {
            image.src = "";
          }
        });
      }

      return () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };
    }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, sourceMessages]);

    const timelineMessages = useMemo(() => {
      const messages = sourceMessages;
      const serverMessagesWithPreviewHandoff =
        Object.keys(attachmentPreviewHandoffByMessageId).length === 0
          ? messages
          : messages.map((message) => {
              if (
                message.role !== "user" ||
                !message.attachments ||
                message.attachments.length === 0
              ) {
                return message;
              }
              const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
              if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
                return message;
              }

              let changed = false;
              let imageIndex = 0;
              const attachments = message.attachments.map((attachment) => {
                if (attachment.type !== "image") {
                  return attachment;
                }
                const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
                imageIndex += 1;
                if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                  return attachment;
                }
                changed = true;
                return {
                  ...attachment,
                  previewUrl: handoffPreviewUrl,
                };
              });

              return changed ? { ...message, attachments } : message;
            });

      if (optimisticUserMessages.length === 0) {
        return serverMessagesWithPreviewHandoff;
      }
      const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
      const pendingMessages = optimisticUserMessages.filter(
        (message) => !serverIds.has(message.id),
      );
      if (pendingMessages.length === 0) {
        return serverMessagesWithPreviewHandoff;
      }
      return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
    }, [attachmentPreviewHandoffByMessageId, optimisticUserMessages, sourceMessages]);

    const workLogEntries = useMemo(
      () => deriveWorkLogEntries(threadActivities, latestTurn?.turnId ?? undefined),
      [latestTurn?.turnId, threadActivities],
    );

    const timelineEntries = useMemo(
      () => deriveTimelineEntries(timelineMessages, proposedPlans, workLogEntries),
      [proposedPlans, timelineMessages, workLogEntries],
    );

    const inferredCheckpointTurnCountByTurnId = useMemo(
      () => inferCheckpointTurnCountByTurnId(turnDiffSummariesProp),
      [turnDiffSummariesProp],
    );
    const turnDiffSummaries = turnDiffSummariesProp;

    const turnDiffSummaryByAssistantMessageId = useMemo(() => {
      const byMessageId = new Map<MessageId, TurnDiffSummary>();
      const byTurnId = new Map<string, TurnDiffSummary>();
      const assignedSummaries = new WeakSet<TurnDiffSummary>();
      for (const summary of turnDiffSummaries) {
        if (summary.assistantMessageId && !byMessageId.has(summary.assistantMessageId)) {
          byMessageId.set(summary.assistantMessageId, summary);
          assignedSummaries.add(summary);
        }
        byTurnId.set(summary.turnId, summary);
      }
      const lastAssistantByTurnId = new Map<string, MessageId>();
      for (const message of timelineMessages) {
        if (message.role !== "assistant" || !message.turnId) continue;
        lastAssistantByTurnId.set(message.turnId, message.id);
      }
      for (const [turnId, messageId] of lastAssistantByTurnId) {
        if (byMessageId.has(messageId)) continue;
        const summary = byTurnId.get(turnId);
        if (!summary || assignedSummaries.has(summary)) continue;
        byMessageId.set(messageId, summary);
        assignedSummaries.add(summary);
      }
      return byMessageId;
    }, [timelineMessages, turnDiffSummaries]);

    const responseMetaByTurnId = useMemo(() => {
      const metadata = new Map<TurnId, AssistantResponseMeta>();
      for (const activity of threadActivities) {
        if (activity.turnId === null || typeof activity.payload !== "object" || !activity.payload) {
          continue;
        }
        const payload = activity.payload as Record<string, unknown>;
        const existing = metadata.get(activity.turnId) ?? {};
        if (activity.kind === "insights.turn.started" && typeof payload.model === "string") {
          metadata.set(activity.turnId, { ...existing, model: payload.model });
          continue;
        }
        if (activity.kind === "context-window.updated") {
          const usedTokens =
            typeof payload.lastUsedTokens === "number"
              ? payload.lastUsedTokens
              : typeof payload.usedTokens === "number"
                ? payload.usedTokens
                : undefined;
          const rawCost = payload.cost;
          const cost =
            typeof rawCost === "object" &&
            rawCost !== null &&
            "amount" in rawCost &&
            typeof rawCost.amount === "number" &&
            "currency" in rawCost &&
            typeof rawCost.currency === "string"
              ? { amount: rawCost.amount, currency: rawCost.currency }
              : undefined;
          if (usedTokens !== undefined || cost !== undefined) {
            metadata.set(activity.turnId, {
              ...existing,
              ...(usedTokens !== undefined ? { usedTokens } : {}),
              ...(cost !== undefined ? { cost } : {}),
            });
          }
          continue;
        }
        if (
          activity.kind === "insights.turn.completed" &&
          typeof payload.totalCostUsd === "number"
        ) {
          metadata.set(activity.turnId, {
            ...existing,
            cost: { amount: payload.totalCostUsd, currency: "USD" },
          });
        }
      }
      return metadata;
    }, [threadActivities]);

    const revertTurnCountByUserMessageId = useMemo(() => {
      const byUserMessageId = new Map<MessageId, number>();
      for (let index = 0; index < timelineEntries.length; index += 1) {
        const entry = timelineEntries[index];
        if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
          continue;
        }

        for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
          const nextEntry = timelineEntries[nextIndex];
          if (!nextEntry || nextEntry.kind !== "message") {
            continue;
          }
          if (nextEntry.message.role === "user") {
            break;
          }
          const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
          if (!summary) {
            continue;
          }
          const turnCount =
            summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
          if (typeof turnCount !== "number") {
            break;
          }
          byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
          break;
        }
      }

      return byUserMessageId;
    }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

    const latestTurnHasToolActivity = useMemo(
      () => hasToolActivityForTurn(threadActivities, latestTurn?.turnId),
      [latestTurn?.turnId, threadActivities],
    );

    const completionSummary = useMemo(() => {
      if (!latestTurnSettled) return null;
      if (sessionActivelyWorking) return null;
      if (isSendBusy) return null;
      if (!latestTurn?.startedAt) return null;
      if (!latestTurn.completedAt) return null;
      if (!latestTurnHasToolActivity) return null;

      const elapsed = formatElapsed(latestTurn.startedAt, latestTurn.completedAt);
      return elapsed ? `Worked for ${elapsed}` : null;
    }, [
      isSendBusy,
      latestTurn?.completedAt,
      latestTurn?.startedAt,
      latestTurnHasToolActivity,
      latestTurnSettled,
      sessionActivelyWorking,
    ]);

    const completionDividerBeforeEntryId = useMemo(() => {
      if (!latestTurnSettled) return null;
      if (sessionActivelyWorking) return null;
      if (isSendBusy) return null;
      if (!latestTurn?.assistantMessageId) return null;
      return deriveCompletionDividerBeforeEntryId(timelineEntries, latestTurn);
    }, [isSendBusy, latestTurn, latestTurnSettled, sessionActivelyWorking, timelineEntries]);

    const timelineRows = useMemo(
      () =>
        deriveMessagesTimelineRows({
          timelineEntries,
          completionDividerBeforeEntryId,
          isWorking: timelineActiveWork,
          activeTurnId: latestTurn?.turnId ?? null,
          activeTurnStartedAt: activeWorkStartedAt,
          turnDiffSummaryByAssistantMessageId,
          revertTurnCountByUserMessageId,
        }),
      [
        activeWorkStartedAt,
        completionDividerBeforeEntryId,
        latestTurn?.turnId,
        revertTurnCountByUserMessageId,
        timelineActiveWork,
        timelineEntries,
        turnDiffSummaryByAssistantMessageId,
      ],
    );

    const findController = useChatFind({
      timelineRows,
      messagesViewportRef,
      legendListRef: listRef,
      routeThreadKey,
      activeThreadId: threadId,
    });
    const routeMessageSearch = useSearch({
      strict: false,
      select: (search) => parseThreadMessageRouteSearch(search),
    });
    const [highlightedMessageId, setHighlightedMessageId] = useState<MessageId | null>(null);
    const handledRouteMessageRef = useRef<string | null>(null);
    const highlightTimeoutRef = useRef<number | null>(null);

    useEffect(
      () => () => {
        if (highlightTimeoutRef.current !== null) {
          window.clearTimeout(highlightTimeoutRef.current);
        }
      },
      [],
    );

    useEffect(() => {
      const messageId = routeMessageSearch.message;
      if (!messageId) {
        return;
      }
      const routeMessageKey = `${routeThreadKey}:${messageId}`;
      if (handledRouteMessageRef.current === routeMessageKey) {
        return;
      }
      const rowIndex = timelineRows.findIndex(
        (row) => row.kind === "message" && row.message.id === messageId,
      );
      if (rowIndex < 0) {
        return;
      }

      const row = timelineRows[rowIndex];
      if (!row) {
        return;
      }
      handledRouteMessageRef.current = routeMessageKey;
      const highlightedId = messageId as MessageId;
      setHighlightedMessageId(highlightedId);
      scrollTimelineRowIntoView({ rowId: row.id, rowIndex, legendListRef: listRef });
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      highlightTimeoutRef.current = window.setTimeout(() => setHighlightedMessageId(null), 1_800);
    }, [listRef, routeMessageSearch.message, routeThreadKey, timelineRows]);

    const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
    onRevertToTurnCountRef.current = onRevertToTurnCount;
    const onRevertUserMessage = useCallback(
      (messageId: MessageId) => {
        const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
        if (typeof targetTurnCount !== "number") {
          return;
        }
        void onRevertToTurnCountRef.current(targetTurnCount);
      },
      [revertTurnCountByUserMessageId],
    );

    const findControllerRef = useRef(findController);
    findControllerRef.current = findController;

    useImperativeHandle(
      ref,
      () => ({
        handoffAttachmentPreviews,
        getFindController: () => findControllerRef.current,
      }),
      [handoffAttachmentPreviews],
    );

    return (
      <>
        {findController.open ? (
          <FindInChatBar
            inputId={findController.inputId}
            query={findController.query}
            onQueryChange={findController.setQuery}
            matchCount={findController.matches.length}
            activeMatchIndex={
              findController.activeMatchIndex >= 0 ? findController.activeMatchIndex : 0
            }
            shortcutLabel={chatFindShortcutLabel ?? ""}
            onPrevious={() => findController.cycleMatch(-1)}
            onNext={() => findController.cycleMatch(1)}
            onClose={findController.closeFind}
          />
        ) : null}
        <MessagesTimeline
          key={threadId}
          rows={timelineRows}
          isWorking={isWorking}
          activeTurnInProgress={timelineActiveWork}
          activeTurnId={latestTurn?.turnId ?? null}
          activeTurnStartedAt={activeWorkStartedAt}
          listRef={listRef}
          timelineEntries={timelineEntries}
          completionDividerBeforeEntryId={completionDividerBeforeEntryId}
          completionSummary={completionSummary}
          copilotResumeCommand={copilotResumeCommand}
          turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
          responseMetaByTurnId={responseMetaByTurnId}
          activeThreadEnvironmentId={threadEnvironmentId}
          activeThreadId={threadId}
          routeThreadKey={routeThreadKey}
          onOpenTurnDiff={onOpenTurnDiff}
          revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
          onRevertUserMessage={onRevertUserMessage}
          onForkAssistantMessage={onForkAssistantMessage}
          isRevertingCheckpoint={isRevertingCheckpoint}
          onImageExpand={onImageExpand}
          markdownCwd={gitCwd}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          onIsAtEndChange={onIsAtEndChange}
          hasMoreOlder={hasMoreOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlder}
          activeChatFindRowId={
            findController.open ? (findController.activeMatch?.rowId ?? null) : null
          }
          highlightedMessageId={highlightedMessageId}
          reviewResultActive={reviewResultActive}
        />
      </>
    );
  },
);
