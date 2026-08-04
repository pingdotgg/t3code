import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationThreadHistoryPage,
  type ThreadId,
} from "@t3tools/contracts";
import { LRUCache } from "@t3tools/shared/LRUCache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ConnectionPersistenceError } from "./persistence.ts";

export interface ThreadHistoryCacheLookup {
  readonly page: Option.Option<OrchestrationThreadHistoryPage>;
  readonly requestLimit: number;
}

export class ThreadHistoryCacheStore extends Context.Reference<{
  readonly loadPrevious: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    endIndex: number,
    limit: number,
  ) => Effect.Effect<ThreadHistoryCacheLookup, ConnectionPersistenceError>;
  readonly loadNext: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    startIndex: number,
    limit: number,
  ) => Effect.Effect<ThreadHistoryCacheLookup, ConnectionPersistenceError>;
  readonly loadAround: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    messageId: MessageId,
    limit: number,
  ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryPage>, ConnectionPersistenceError>;
  readonly captureWriteToken: () => Effect.Effect<number>;
  readonly save: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    page: OrchestrationThreadHistoryPage,
    writeToken: number,
  ) => Effect.Effect<void, ConnectionPersistenceError>;
  readonly remove: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Effect.Effect<void, ConnectionPersistenceError>;
  readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void, ConnectionPersistenceError>;
  readonly clearAll: () => Effect.Effect<void, ConnectionPersistenceError>;
}>("@t3tools/client-runtime/platform/threadHistoryCache/ThreadHistoryCacheStore", {
  defaultValue: () => ({
    loadPrevious: (_environmentId, _threadId, _endIndex, limit) =>
      Effect.succeed({ page: Option.none(), requestLimit: limit }),
    loadNext: (_environmentId, _threadId, _startIndex, limit) =>
      Effect.succeed({ page: Option.none(), requestLimit: limit }),
    loadAround: () => Effect.succeed(Option.none()),
    captureWriteToken: () => Effect.succeed(0),
    save: () => Effect.void,
    remove: () => Effect.void,
    clear: () => Effect.void,
    clearAll: () => Effect.void,
  }),
}) {}

interface CachedHistoryPage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly page: OrchestrationThreadHistoryPage;
}

function sliceHistoryPage(
  page: OrchestrationThreadHistoryPage,
  startIndex: number,
  endIndex: number,
): OrchestrationThreadHistoryPage {
  if (startIndex === page.messageHistory.startIndex && endIndex === page.messageHistory.endIndex) {
    return page;
  }

  const messages = page.messages.slice(
    startIndex - page.messageHistory.startIndex,
    endIndex - page.messageHistory.startIndex,
  );
  const firstMessage = messages[0];
  const activityPosition = (createdAt: string) => {
    const offset = page.messages.findIndex((message) => message.createdAt > createdAt);
    return page.messageHistory.startIndex + (offset === -1 ? page.messages.length : offset);
  };

  return {
    messages,
    activities: page.activities.filter((activity) => {
      const position = activityPosition(activity.createdAt);
      return position >= startIndex && position <= endIndex;
    }),
    proposedPlans: page.proposedPlans.filter((plan) => {
      const position = activityPosition(plan.createdAt);
      return position >= startIndex && position <= endIndex;
    }),
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < page.messageHistory.totalMessages,
      startIndex,
      endIndex,
      totalMessages: page.messageHistory.totalMessages,
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

export function makeInMemoryThreadHistoryCacheStore(maxPages: number) {
  const pages = new LRUCache<CachedHistoryPage>(maxPages, maxPages);
  let activeWriteToken = 0;

  return ThreadHistoryCacheStore.of({
    loadPrevious: (environmentId, threadId, endIndex, limit) =>
      Effect.sync(() => {
        let match: readonly [string, CachedHistoryPage] | null = null;
        for (const entry of pages.entries()) {
          const cached = entry[1];
          if (cached.environmentId !== environmentId || cached.threadId !== threadId) {
            continue;
          }
          const history = cached.page.messageHistory;
          if (history.startIndex < endIndex && history.endIndex >= endIndex) {
            match = entry;
          }
        }
        if (match !== null) {
          const [key, cached] = match;
          void pages.get(key);
          const endOffset = endIndex - cached.page.messageHistory.startIndex;
          const turnStarts = cached.page.messages.flatMap((message, index) =>
            message.role === "user" && index < endOffset ? [index] : [],
          );
          return {
            page: Option.some(
              sliceHistoryPage(
                cached.page,
                cached.page.messageHistory.startIndex + (turnStarts.at(-limit) ?? 0),
                endIndex,
              ),
            ),
            requestLimit: limit,
          };
        }
        return { page: Option.none(), requestLimit: limit };
      }),
    loadNext: (environmentId, threadId, startIndex, limit) =>
      Effect.sync(() => {
        let match: readonly [string, CachedHistoryPage] | null = null;
        for (const entry of pages.entries()) {
          const cached = entry[1];
          if (cached.environmentId !== environmentId || cached.threadId !== threadId) {
            continue;
          }
          const history = cached.page.messageHistory;
          if (history.startIndex <= startIndex && history.endIndex > startIndex) {
            match = entry;
          }
        }
        if (match !== null) {
          const [key, cached] = match;
          void pages.get(key);
          const startOffset = startIndex - cached.page.messageHistory.startIndex;
          const turnStarts = cached.page.messages.flatMap((message, index) =>
            message.role === "user" && index >= startOffset ? [index] : [],
          );
          const sliceStart = turnStarts[0] ?? startOffset;
          const sliceEnd = turnStarts[limit] ?? cached.page.messages.length;
          return {
            page: Option.some(
              sliceHistoryPage(
                cached.page,
                cached.page.messageHistory.startIndex + sliceStart,
                cached.page.messageHistory.startIndex + sliceEnd,
              ),
            ),
            requestLimit: limit,
          };
        }
        return { page: Option.none(), requestLimit: limit };
      }),
    loadAround: (environmentId, threadId, messageId, limit) =>
      Effect.sync(() => {
        let match: readonly [string, CachedHistoryPage, number] | null = null;
        for (const [key, cached] of pages.entries()) {
          if (cached.environmentId !== environmentId || cached.threadId !== threadId) {
            continue;
          }
          const offset = cached.page.messages.findIndex((message) => message.id === messageId);
          if (offset !== -1) {
            match = [key, cached, cached.page.messageHistory.startIndex + offset];
          }
        }
        if (match === null) {
          return Option.none();
        }
        const [key, cached, targetIndex] = match;
        void pages.get(key);
        const turnStarts = cached.page.messages.flatMap((message, index) =>
          message.role === "user" ? [index] : [],
        );
        const targetOffset = targetIndex - cached.page.messageHistory.startIndex;
        const targetTurn = Math.max(
          0,
          turnStarts.findLastIndex((turnStart) => turnStart <= targetOffset),
        );
        const startTurn = Math.max(
          0,
          Math.min(targetTurn - Math.floor((limit - 1) / 2), turnStarts.length - limit),
        );
        const startIndex =
          cached.page.messageHistory.startIndex + (turnStarts[startTurn] ?? targetOffset);
        const endIndex =
          cached.page.messageHistory.startIndex +
          (turnStarts[startTurn + limit] ?? cached.page.messages.length);
        return Option.some(sliceHistoryPage(cached.page, startIndex, endIndex));
      }),
    captureWriteToken: () => Effect.sync(() => activeWriteToken),
    save: (environmentId, threadId, page, writeToken) =>
      Effect.sync(() => {
        if (writeToken !== activeWriteToken || page.messages.length === 0) {
          return;
        }
        const key = `${environmentId}:${threadId}:${page.messageHistory.startIndex}:${page.messageHistory.endIndex}`;
        pages.set(key, { environmentId, threadId, page }, 1);
      }),
    remove: (environmentId, threadId) =>
      Effect.sync(() => {
        activeWriteToken += 1;
        for (const [key, cached] of pages.entries()) {
          if (cached.environmentId === environmentId && cached.threadId === threadId) {
            pages.delete(key);
          }
        }
      }),
    clear: (environmentId) =>
      Effect.sync(() => {
        activeWriteToken += 1;
        for (const [key, cached] of pages.entries()) {
          if (cached.environmentId === environmentId) {
            pages.delete(key);
          }
        }
      }),
    clearAll: () =>
      Effect.sync(() => {
        activeWriteToken += 1;
        pages.clear();
      }),
  });
}
