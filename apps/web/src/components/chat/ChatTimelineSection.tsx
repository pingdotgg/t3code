import type {
  EnvironmentId,
  MessageId,
  OrchestrationThreadActivity,
  ScopedThreadRef,
  ThreadId,
  TurnDiffScope,
  TurnId,
  TimestampFormat,
  ValidationRun,
} from "@t3tools/contracts";
import {
  reduceValidationReadiness,
  validationGateStatusLabel,
  validationRunEffectiveStatus,
  validationRunStatusLabel,
} from "@t3tools/client-runtime/validation-lifecycle";
import type { MessagePreviewLineLimits } from "@t3tools/contracts/settings";
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
  deriveCrossThreadSendsBySourceMessageId,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  hasToolActivityForTurn,
  inferCheckpointTurnCountByTurnId,
} from "../../session-logic";
import { useStore } from "../../store";
import { useMemoEqual } from "../../lib/useMemoEqual";
import { createThreadMessagesSelectorByRef } from "../../storeSelectors";
import {
  type ChatMessage,
  type ProposedPlan,
  type Thread,
  type TurnDiffSummary,
} from "../../types";
import type { ValidationTarget } from "@t3tools/contracts";
import { revokeBlobPreviewUrl } from "../../pendingTurnStore";
import {
  deriveMessagesTimelineRows,
  deriveRevertTurnCountByUserMessageId,
  stabilizeResponseMetaByTurnId,
} from "./MessagesTimeline.logic";
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
  validationRun: ValidationRun | null | undefined;
  currentValidationTarget: ValidationTarget | null;
  listRef: RefObject<LegendListRef | null>;
  messagesViewportRef: RefObject<HTMLDivElement | null>;
  gitCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  messagePreviewLineLimits: MessagePreviewLineLimits;
  workspaceRoot: string | undefined;
  chatFindShortcutLabel: string | null;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string, scope?: TurnDiffScope) => void;
  onRevertToTurnCount: (turnCount: number) => void | Promise<void>;
  onForkAssistantMessage?: (messageId: MessageId) => void;
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
      validationRun,
      currentValidationTarget,
      listRef,
      messagesViewportRef,
      gitCwd,
      resolvedTheme,
      timestampFormat,
      messagePreviewLineLimits,
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

    // Ref-equality memo: the store rebuilds the activities array on
    // unrelated updates (e.g. streaming text chunks) with identical item
    // refs. Reusing the previous derivation skips ~10ms of re-derive per
    // chunk on large threads; any real change recomputes like useMemo.
    const workLogEntries = useMemoEqual(
      () => deriveWorkLogEntries(threadActivities, latestTurn?.turnId ?? undefined),
      [threadActivities, latestTurn?.turnId ?? undefined],
    );

    const timelineEntries = useMemo(
      () => deriveTimelineEntries(timelineMessages, proposedPlans, workLogEntries),
      [proposedPlans, timelineMessages, workLogEntries],
    );

    const crossThreadSendsBySourceMessageId = useMemoEqual(
      () => deriveCrossThreadSendsBySourceMessageId(threadActivities),
      [threadActivities],
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

    // Stabilize entry identity: the loop below rebuilds fresh `{...existing}`
    // objects on every `threadActivities` change, which would otherwise give
    // settled turns a new identity per chunk and defeat the memoized assistant
    // presentational in MessagesTimeline.
    const responseMetaByTurnIdRef = useRef<ReadonlyMap<TurnId, AssistantResponseMeta> | undefined>(
      undefined,
    );
    // Ref-equality fast path around the rebuild: when activities are
    // ref-identical (e.g. streaming text chunks), reuse the previous map
    // without rescanning; the stabilization above still preserves settled
    // entry identity whenever a rebuild actually runs.
    const responseMetaByTurnId = useMemoEqual(() => {
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
      const stabilized = stabilizeResponseMetaByTurnId(metadata, responseMetaByTurnIdRef.current);
      responseMetaByTurnIdRef.current = stabilized;
      return stabilized;
    }, [threadActivities]);

    const revertTurnCountByUserMessageId = useMemo(
      () =>
        deriveRevertTurnCountByUserMessageId({
          timelineEntries,
          turnDiffSummaryByAssistantMessageId,
          inferredCheckpointTurnCountByTurnId,
        }),
      [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId],
    );

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

    // During optimistic send the server still reports the previous turn as
    // latestTurn. Passing its id as activeTurnId would uncollapse its
    // "Worked for..." receipt (and mark its assistant message live) until the
    // server acks the new turn. Null it out while the previous turn is
    // settled, mirroring completionSummary/divider above.
    const effectiveActiveTurnId =
      isSendBusy && latestTurnSettled ? null : (latestTurn?.turnId ?? null);

    const timelineRows = useMemo(() => {
      return deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking: timelineActiveWork,
        activeTurnId: effectiveActiveTurnId,
        activeTurnStartedAt: activeWorkStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
        crossThreadSendsBySourceMessageId,
      });
    }, [
      activeWorkStartedAt,
      completionDividerBeforeEntryId,
      crossThreadSendsBySourceMessageId,
      effectiveActiveTurnId,
      revertTurnCountByUserMessageId,
      timelineActiveWork,
      timelineEntries,
      turnDiffSummaryByAssistantMessageId,
    ]);

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

    const activeGate = validationRun?.gates.find((gate) => gate.status === "running") ?? null;
    return (
      <>
        {validationRun ? (
          <div className="mx-auto mb-2 w-full max-w-3xl px-4" data-testid="validation-matrix">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium">Validation</span>
                <span className="text-muted-foreground">
                  {validationRunStatusLabel(validationRunEffectiveStatus(validationRun))} ·{" "}
                  {currentValidationTarget
                    ? reduceValidationReadiness(validationRun, currentValidationTarget)
                    : "Readiness unavailable"}
                  {activeGate ? ` · Active: ${activeGate.label}` : ""}
                </span>
              </div>
              <div className="mb-2 text-muted-foreground">
                Tested revision <span className="font-mono">{validationRun.target.revision}</span>
                {validationRun.target.branch ? ` on ${validationRun.target.branch}` : ""} ·{" "}
                {validationRun.target.environmentIdentity}
              </div>
              <div className="grid gap-1.5">
                {validationRun.gates.map((gate) => (
                  <div
                    key={gate.id}
                    className="flex flex-col gap-1 rounded-md bg-background/60 px-2 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span>{gate.label}</span>
                      <span className="text-right text-muted-foreground">
                        {validationGateStatusLabel(gate.status)}
                        {gate.blockerReason ? ` - ${gate.blockerReason}` : ""}
                      </span>
                    </div>
                    {gate.exitCode !== null || gate.outputRef ? (
                      <div className="text-muted-foreground">
                        {gate.exitCode !== null ? `exit ${gate.exitCode} ` : ""}
                        {gate.outputRef ? `· ${gate.outputRef}` : ""}
                        {gate.attempts.length > 0 ? ` · attempts ${gate.attempts.length}` : ""}
                      </div>
                    ) : null}
                    {gate.diagnostics.length > 0 ? (
                      <div className="text-muted-foreground">
                        {gate.diagnostics.slice(0, 3).join(" | ").slice(0, 300)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
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
          activeTurnId={effectiveActiveTurnId}
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
          {...(onForkAssistantMessage ? { onForkAssistantMessage } : {})}
          isRevertingCheckpoint={isRevertingCheckpoint}
          onImageExpand={onImageExpand}
          markdownCwd={gitCwd}
          resolvedTheme={resolvedTheme}
          timestampFormat={timestampFormat}
          messagePreviewLineLimits={messagePreviewLineLimits}
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
