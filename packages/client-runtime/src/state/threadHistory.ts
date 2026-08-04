import type { OrchestrationThread, OrchestrationThreadHistoryPage } from "@t3tools/contracts";

import { THREAD_TURN_PAGE_SIZE } from "./threadSnapshotHttp.ts";
import type { EnvironmentThreadHistoryState } from "./threadState.ts";

const THREAD_HISTORY_WINDOW_MAX_TURNS = THREAD_TURN_PAGE_SIZE * 5;

export function boundLiveThread(thread: OrchestrationThread): OrchestrationThread {
  if (thread.messageHistory === undefined) {
    return thread;
  }
  const turnStarts = thread.messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );
  const startOffset = turnStarts.at(-THREAD_TURN_PAGE_SIZE);
  const messages = startOffset === undefined ? thread.messages : thread.messages.slice(startOffset);
  const firstMessage = messages[0];
  if (firstMessage === undefined) {
    return thread;
  }
  const visibleTurnIds = new Set(
    messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  const activeTurnId = thread.session?.activeTurnId ?? null;
  if (activeTurnId !== null) {
    visibleTurnIds.add(activeTurnId);
  }
  return {
    ...thread,
    messages,
    activities: thread.activities.filter(
      (activity) =>
        activity.createdAt >= firstMessage.createdAt &&
        (activity.turnId === null || visibleTurnIds.has(activity.turnId)),
    ),
    proposedPlans: thread.proposedPlans.filter((plan) => plan.createdAt >= firstMessage.createdAt),
    messageHistory: {
      hasMoreBefore: thread.messageHistory.endIndex - messages.length > 0,
      hasMoreAfter: thread.messageHistory.endIndex < thread.messageHistory.totalMessages,
      startIndex: thread.messageHistory.endIndex - messages.length,
      endIndex: thread.messageHistory.endIndex,
      totalMessages: thread.messageHistory.totalMessages,
      cursor: {
        createdAt: firstMessage.createdAt,
        messageId: firstMessage.id,
      },
    },
  };
}

export function mergeThreadHistoryPages(input: {
  readonly older: OrchestrationThreadHistoryPage;
  readonly newer: OrchestrationThreadHistoryPage;
}): OrchestrationThreadHistoryPage {
  const messages = [
    ...new Map(
      [...input.older.messages, ...input.newer.messages].map((message) => [message.id, message]),
    ).values(),
  ].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const activities = [
    ...new Map(
      [...input.older.activities, ...input.newer.activities].map((activity) => [
        activity.id,
        activity,
      ]),
    ).values(),
  ].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const proposedPlans = [
    ...new Map(
      [...input.older.proposedPlans, ...input.newer.proposedPlans].map((plan) => [plan.id, plan]),
    ).values(),
  ].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const firstMessage = messages[0];
  const startIndex = Math.min(
    input.older.messageHistory.startIndex,
    input.newer.messageHistory.startIndex,
  );
  const endIndex = Math.max(
    input.older.messageHistory.endIndex,
    input.newer.messageHistory.endIndex,
  );
  const totalMessages = Math.max(
    input.older.messageHistory.totalMessages,
    input.newer.messageHistory.totalMessages,
  );
  return {
    messages,
    activities,
    proposedPlans,
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < totalMessages,
      startIndex,
      endIndex,
      totalMessages,
      cursor:
        firstMessage === undefined
          ? null
          : {
              createdAt: firstMessage.createdAt,
              messageId: firstMessage.id,
            },
    },
  };
}

export function boundThreadHistoryPage(
  page: OrchestrationThreadHistoryPage,
  preserve: "older" | "newer",
): OrchestrationThreadHistoryPage {
  const turnStarts = page.messages.flatMap((message, index) =>
    message.role === "user" ? [index] : [],
  );
  if (turnStarts.length <= THREAD_HISTORY_WINDOW_MAX_TURNS) {
    return page;
  }
  const sliceStart =
    preserve === "older" ? 0 : turnStarts[turnStarts.length - THREAD_HISTORY_WINDOW_MAX_TURNS]!;
  const sliceEnd =
    preserve === "older" ? turnStarts[THREAD_HISTORY_WINDOW_MAX_TURNS]! : page.messages.length;
  const messages = page.messages.slice(sliceStart, sliceEnd);
  const firstMessage = messages[0];
  if (firstMessage === undefined) {
    return page;
  }
  // Turn telemetry can land after the turn's final message, so timestamps alone
  // cannot decide whether it belongs to the retained window.
  const visibleTurnIds = new Set(
    messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  const endBoundary = preserve === "older" ? (page.messages[sliceEnd]?.createdAt ?? null) : null;
  const startIndex =
    preserve === "older"
      ? page.messageHistory.startIndex
      : page.messageHistory.startIndex + sliceStart;
  const endIndex =
    preserve === "older" ? page.messageHistory.startIndex + sliceEnd : page.messageHistory.endIndex;
  return {
    messages,
    activities: page.activities.filter((activity) =>
      activity.turnId !== null
        ? visibleTurnIds.has(activity.turnId)
        : activity.createdAt >= firstMessage.createdAt &&
          (endBoundary === null || activity.createdAt < endBoundary),
    ),
    proposedPlans: page.proposedPlans.filter((plan) =>
      plan.turnId !== null
        ? visibleTurnIds.has(plan.turnId)
        : plan.createdAt >= firstMessage.createdAt &&
          (endBoundary === null || plan.createdAt < endBoundary),
    ),
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < page.messageHistory.totalMessages,
      startIndex,
      endIndex,
      totalMessages: page.messageHistory.totalMessages,
      cursor: {
        createdAt: firstMessage.createdAt,
        messageId: firstMessage.id,
      },
    },
  };
}

export function displayThreadHistory(
  liveThread: OrchestrationThread,
  history: EnvironmentThreadHistoryState,
): OrchestrationThread {
  if (history.kind === "disabled" || history.window === null) {
    return liveThread;
  }
  const historyTurnIds = new Set(
    history.window.messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  const visibleHistoryWindow = {
    ...history.window,
    activities: history.window.activities.filter(
      (activity) => activity.turnId === null || historyTurnIds.has(activity.turnId),
    ),
  };
  if (visibleHistoryWindow.messageHistory.hasMoreAfter) {
    const totalMessages = Math.max(
      visibleHistoryWindow.messageHistory.totalMessages,
      liveThread.messageHistory?.totalMessages ?? liveThread.messages.length,
    );
    return {
      ...liveThread,
      messages: visibleHistoryWindow.messages,
      activities: visibleHistoryWindow.activities,
      proposedPlans: visibleHistoryWindow.proposedPlans,
      messageHistory: {
        ...visibleHistoryWindow.messageHistory,
        hasMoreAfter: visibleHistoryWindow.messageHistory.endIndex < totalMessages,
        totalMessages,
      },
    };
  }
  const merged = mergeThreadHistoryPages({
    older: visibleHistoryWindow,
    newer: {
      messages: liveThread.messages,
      activities: liveThread.activities,
      proposedPlans: liveThread.proposedPlans,
      messageHistory: liveThread.messageHistory ?? {
        hasMoreBefore: false,
        hasMoreAfter: false,
        startIndex: 0,
        endIndex: liveThread.messages.length,
        totalMessages: liveThread.messages.length,
        cursor: null,
      },
    },
  });
  return {
    ...liveThread,
    messages: merged.messages,
    activities: merged.activities,
    proposedPlans: merged.proposedPlans,
    messageHistory: merged.messageHistory,
  };
}
