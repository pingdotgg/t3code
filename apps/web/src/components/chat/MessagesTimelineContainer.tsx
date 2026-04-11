import {
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type TurnId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  formatElapsed,
  hasToolActivityForTurn,
  inferCheckpointTurnCountByTurnId,
} from "../../session-logic";
import {
  type SessionPhase,
  type ChatMessage,
  type Thread,
  type TurnDiffSummary,
} from "../../types";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import {
  HistoricalMessagesTimelineSection,
  LiveMessagesTimelineSection,
  TimelineEmptyState,
} from "./MessagesTimeline";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { createThreadTimelineSliceSelectorByRef } from "../../storeSelectors";
import { useStore } from "../../store";
import { useUiStateStore } from "../../uiStateStore";

const EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID: Record<string, boolean> = {};
const EMPTY_CHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];
const EMPTY_WORK_LOG_ENTRIES: ReturnType<typeof deriveWorkLogEntries> = [];
const EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID = new Map<MessageId, number>();
const NOOP_REVERT_USER_MESSAGE = (_messageId: MessageId) => {};

interface MessagesTimelineContainerProps {
  activeLatestTurn: Thread["latestTurn"] | null;
  activeTurnId: TurnId | null;
  activeTurnInProgress: boolean;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadSession: Parameters<typeof deriveActiveWorkStartedAt>[1];
  draftActivities: Thread["activities"];
  isRevertingCheckpoint: boolean;
  isWorking: boolean;
  latestTurnSettled: boolean;
  localDispatchStartedAt: string | null;
  markdownCwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRevertToTurnCount: (turnCount: number) => void;
  phase: SessionPhase;
  resolvedTheme: "light" | "dark";
  scheduleStickToBottom: () => void;
  scrollContainer: HTMLDivElement | null;
  shouldAutoScrollRef: React.MutableRefObject<boolean>;
  timestampFormat: TimestampFormat;
  threadRef: ScopedThreadRef | null;
  draftMessages: ChatMessage[];
  draftProposedPlans: Thread["proposedPlans"];
  draftTurnDiffSummaries: Thread["turnDiffSummaries"];
  optimisticUserMessages: ChatMessage[];
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  clearAttachmentPreviewHandoff: (
    messageId: MessageId,
    previewUrls?: ReadonlyArray<string>,
  ) => void;
  workspaceRoot: string | undefined;
}

export const MessagesTimelineContainer = memo(function MessagesTimelineContainer(
  props: MessagesTimelineContainerProps,
) {
  const {
    activeLatestTurn,
    activeTurnId,
    activeTurnInProgress,
    activeThreadEnvironmentId,
    activeThreadId,
    activeThreadSession,
    draftActivities,
    isRevertingCheckpoint,
    isWorking,
    latestTurnSettled,
    localDispatchStartedAt,
    markdownCwd,
    onImageExpand,
    onOpenTurnDiff,
    onRevertToTurnCount,
    phase,
    resolvedTheme,
    scheduleStickToBottom,
    scrollContainer,
    shouldAutoScrollRef,
    timestampFormat,
    threadRef,
    draftMessages,
    draftProposedPlans,
    draftTurnDiffSummaries,
    optimisticUserMessages,
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoff,
    workspaceRoot,
  } = props;
  const serverTimelineSlices = useStore(
    useMemo(() => createThreadTimelineSliceSelectorByRef(threadRef), [threadRef]),
  );
  const changedFilesExpandedByTurnId = useUiStateStore((store) =>
    threadRef
      ? (store.threadChangedFilesExpandedById[scopedThreadKey(threadRef)] ??
        EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID)
      : EMPTY_CHANGED_FILES_EXPANDED_BY_TURN_ID,
  );
  const setThreadChangedFilesExpanded = useUiStateStore(
    (store) => store.setThreadChangedFilesExpanded,
  );
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const applyPreviewHandoff = useCallback(
    (messages: ChatMessage[]) => {
      let messagesWithPreviewHandoff = messages;
      if (Object.keys(attachmentPreviewHandoffByMessageId).length > 0) {
        let nextMessages: ChatMessage[] | null = null;

        for (const [messageIndex, message] of messages.entries()) {
          if (message.role !== "user" || !message.attachments || message.attachments.length === 0) {
            if (nextMessages) {
              nextMessages.push(message);
            }
            continue;
          }

          const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
          if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
            if (nextMessages) {
              nextMessages.push(message);
            }
            continue;
          }

          let changed = false;
          let imageIndex = 0;
          const attachments = [...message.attachments];

          for (
            let attachmentIndex = 0;
            attachmentIndex < attachments.length;
            attachmentIndex += 1
          ) {
            const attachment = attachments[attachmentIndex];
            if (!attachment || attachment.type !== "image") {
              continue;
            }

            const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
            imageIndex += 1;
            if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
              continue;
            }

            changed = true;
            attachments[attachmentIndex] = {
              ...attachment,
              previewUrl: handoffPreviewUrl,
            };
          }

          if (!changed) {
            if (nextMessages) {
              nextMessages.push(message);
            }
            continue;
          }

          if (!nextMessages) {
            nextMessages = messages.slice(0, messageIndex);
          }

          nextMessages.push({
            ...message,
            attachments,
          });
        }

        messagesWithPreviewHandoff = nextMessages ?? messages;
      }

      return messagesWithPreviewHandoff;
    },
    [attachmentPreviewHandoffByMessageId],
  );
  const historicalTimelineMessages = useMemo(() => {
    const baseMessages = threadRef
      ? (serverTimelineSlices.historicalMessages ?? EMPTY_CHAT_MESSAGES)
      : draftMessages;
    return applyPreviewHandoff(baseMessages);
  }, [applyPreviewHandoff, draftMessages, serverTimelineSlices.historicalMessages, threadRef]);
  const activeWorkEntries = threadRef
    ? (serverTimelineSlices.activeWorkEntries ?? EMPTY_WORK_LOG_ENTRIES)
    : deriveWorkLogEntries(draftActivities, activeLatestTurn?.turnId ?? undefined);
  const liveTimelineMessages = useMemo(() => {
    const baseMessages = threadRef
      ? (serverTimelineSlices.liveMessages ?? EMPTY_CHAT_MESSAGES)
      : EMPTY_CHAT_MESSAGES;
    const messagesWithPreviewHandoff = applyPreviewHandoff(baseMessages);
    if (optimisticUserMessages.length === 0) {
      return messagesWithPreviewHandoff;
    }
    const historicalServerIds = new Set(historicalTimelineMessages.map((message) => message.id));
    const liveServerIds = new Set(messagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter(
      (message) => !historicalServerIds.has(message.id) && !liveServerIds.has(message.id),
    );
    if (pendingMessages.length === 0) {
      return messagesWithPreviewHandoff;
    }
    const liveSectionIsAwaitingNextTurn =
      activeWorkEntries.length === 0 &&
      messagesWithPreviewHandoff.length > 0 &&
      messagesWithPreviewHandoff.every(
        (message) => message.role === "assistant" && !message.streaming,
      );
    return liveSectionIsAwaitingNextTurn
      ? [...messagesWithPreviewHandoff, ...pendingMessages]
      : [...pendingMessages, ...messagesWithPreviewHandoff];
  }, [
    activeWorkEntries,
    applyPreviewHandoff,
    historicalTimelineMessages,
    optimisticUserMessages,
    serverTimelineSlices.liveMessages,
    threadRef,
  ]);
  const historicalProposedPlans = threadRef
    ? (serverTimelineSlices.historicalProposedPlans ?? EMPTY_PROPOSED_PLANS)
    : draftProposedPlans;
  const liveProposedPlans = threadRef
    ? (serverTimelineSlices.liveProposedPlans ?? EMPTY_PROPOSED_PLANS)
    : EMPTY_PROPOSED_PLANS;
  const turnDiffSummaries = threadRef
    ? (serverTimelineSlices.turnDiffSummaries ?? draftTurnDiffSummaries)
    : draftTurnDiffSummaries;
  const latestTurnHasToolActivity = threadRef
    ? serverTimelineSlices.latestTurnHasToolActivity
    : hasToolActivityForTurn(draftActivities, activeLatestTurn?.turnId);
  const historicalTimelineEntries = useMemo(
    () => deriveTimelineEntries(historicalTimelineMessages, historicalProposedPlans, []),
    [historicalProposedPlans, historicalTimelineMessages],
  );
  const liveTimelineEntries = useMemo(
    () => deriveTimelineEntries(liveTimelineMessages, liveProposedPlans, activeWorkEntries),
    [activeWorkEntries, liveProposedPlans, liveTimelineMessages],
  );
  const timelineEntries = useMemo(
    () => [...historicalTimelineEntries, ...liveTimelineEntries],
    [historicalTimelineEntries, liveTimelineEntries],
  );
  const activeWorkStartedAt = useMemo(
    () => deriveActiveWorkStartedAt(activeLatestTurn, activeThreadSession, localDispatchStartedAt),
    [activeLatestTurn, activeThreadSession, localDispatchStartedAt],
  );
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) {
        continue;
      }
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );
  const historicalRevertTurnCountByUserMessageId = useMemo(
    () =>
      deriveRevertTurnCountByUserMessageId({
        inferredCheckpointTurnCountByTurnId,
        timelineEntries: historicalTimelineEntries,
        turnDiffSummaryByAssistantMessageId,
      }),
    [
      historicalTimelineEntries,
      inferredCheckpointTurnCountByTurnId,
      turnDiffSummaryByAssistantMessageId,
    ],
  );
  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const messageCount = historicalTimelineMessages.length + liveTimelineMessages.length;
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = historicalRevertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      onRevertToTurnCount(targetTurnCount);
    },
    [historicalRevertTurnCountByUserMessageId, onRevertToTurnCount],
  );
  const onRevertLiveUserMessage = useCallback((messageId: MessageId) => {
    NOOP_REVERT_USER_MESSAGE(messageId);
  }, []);
  const onSetChangedFilesExpanded = useCallback(
    (turnId: TurnId, expanded: boolean) => {
      if (!threadRef) {
        return;
      }
      setThreadChangedFilesExpanded(scopedThreadKey(threadRef), turnId, expanded);
    },
    [setThreadChangedFilesExpanded, threadRef],
  );
  const activeThreadIdRef = useRef(activeThreadId);

  useEffect(() => {
    const serverMessages = [
      ...serverTimelineSlices.historicalMessages,
      ...serverTimelineSlices.liveMessages,
    ];
    if (!threadRef || typeof Image === "undefined" || serverMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      const serverMessage = serverMessages.find(
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
        .catch(() => undefined);

      cleanups.push(() => {
        cancelled = true;
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
  }, [
    attachmentPreviewHandoffByMessageId,
    clearAttachmentPreviewHandoff,
    serverTimelineSlices.historicalMessages,
    serverTimelineSlices.liveMessages,
    threadRef,
  ]);

  useEffect(() => {
    if (activeThreadIdRef.current === activeThreadId) {
      return;
    }
    activeThreadIdRef.current = activeThreadId;
    setExpandedWorkGroups({});
  }, [activeThreadId]);

  useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [messageCount, scheduleStickToBottom, shouldAutoScrollRef]);

  useEffect(() => {
    if (phase !== "running") return;
    if (!shouldAutoScrollRef.current) return;
    scheduleStickToBottom();
  }, [liveTimelineEntries, phase, scheduleStickToBottom, shouldAutoScrollRef]);

  if (timelineEntries.length === 0 && !isWorking) {
    return <TimelineEmptyState />;
  }

  return (
    <div key={activeThreadId} className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden">
      <HistoricalMessagesTimelineSection
        scrollContainer={scrollContainer}
        historicalTimelineEntries={historicalTimelineEntries}
        turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
        expandedWorkGroups={expandedWorkGroups}
        onToggleWorkGroup={onToggleWorkGroup}
        changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={onSetChangedFilesExpanded}
        onOpenTurnDiff={onOpenTurnDiff}
        revertTurnCountByUserMessageId={historicalRevertTurnCountByUserMessageId}
        onRevertUserMessage={onRevertUserMessage}
        isRevertingCheckpoint={isRevertingCheckpoint}
        onImageExpand={onImageExpand}
        activeThreadEnvironmentId={activeThreadEnvironmentId}
        markdownCwd={markdownCwd}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        workspaceRoot={workspaceRoot}
      />
      <LiveMessagesTimelineSection
        isWorking={isWorking}
        activeTurnInProgress={activeTurnInProgress}
        activeTurnId={activeTurnId}
        activeTurnStartedAt={activeWorkStartedAt}
        liveTimelineEntries={liveTimelineEntries}
        completionDividerBeforeEntryId={completionDividerBeforeEntryId}
        completionSummary={completionSummary}
        turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
        expandedWorkGroups={expandedWorkGroups}
        onToggleWorkGroup={onToggleWorkGroup}
        changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={onSetChangedFilesExpanded}
        onOpenTurnDiff={onOpenTurnDiff}
        revertTurnCountByUserMessageId={EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID}
        onRevertUserMessage={onRevertLiveUserMessage}
        isRevertingCheckpoint={isRevertingCheckpoint}
        onImageExpand={onImageExpand}
        activeThreadEnvironmentId={activeThreadEnvironmentId}
        markdownCwd={markdownCwd}
        resolvedTheme={resolvedTheme}
        timestampFormat={timestampFormat}
        workspaceRoot={workspaceRoot}
      />
    </div>
  );
});

function deriveRevertTurnCountByUserMessageId({
  inferredCheckpointTurnCountByTurnId,
  timelineEntries,
  turnDiffSummaryByAssistantMessageId,
}: {
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
}): Map<MessageId, number> {
  if (timelineEntries.length === 0) {
    return EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID;
  }

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

  return byUserMessageId.size === 0 ? EMPTY_REVERT_TURN_COUNT_BY_USER_MESSAGE_ID : byUserMessageId;
}
