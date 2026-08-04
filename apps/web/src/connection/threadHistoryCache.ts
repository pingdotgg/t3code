import {
  ConnectionPersistenceError,
  ThreadHistoryCacheStore,
} from "@t3tools/client-runtime/platform";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  NonNegativeInt,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const DATABASE_NAME = "t3code:tarik02-thread-history-cache";
const DATABASE_VERSION = 2;
const LEGACY_STORE_NAME = "thread-history";
const THREAD_STORE_NAME = "thread";
const MESSAGE_STORE_NAME = "message";
const ACTIVITY_STORE_NAME = "activity";
const PLAN_STORE_NAME = "plan";
const MESSAGE_ID_INDEX_NAME = "by-message-id";
const ACTIVITY_POSITION_INDEX_NAME = "by-position";
const PLAN_POSITION_INDEX_NAME = "by-position";
const CACHE_SCHEMA_VERSION = 1;

const StoredThreadHistoryRange = Schema.Struct({
  startIndex: NonNegativeInt,
  endIndex: NonNegativeInt,
});
const StoredThreadHistoryThread = Schema.Struct({
  schemaVersion: Schema.Literal(CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  totalMessages: NonNegativeInt,
  ranges: Schema.Array(StoredThreadHistoryRange),
  turnStarts: Schema.Array(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
const StoredThreadHistoryMessage = Schema.Struct({
  schemaVersion: Schema.Literal(CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  index: NonNegativeInt,
  messageId: OrchestrationMessage.fields.id,
  message: OrchestrationMessage,
});
const StoredThreadHistoryActivity = Schema.Struct({
  schemaVersion: Schema.Literal(CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  position: NonNegativeInt,
  activityId: OrchestrationThreadActivity.fields.id,
  activity: OrchestrationThreadActivity,
});
const StoredThreadHistoryPlan = Schema.Struct({
  schemaVersion: Schema.Literal(CACHE_SCHEMA_VERSION),
  scope: Schema.String,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  position: NonNegativeInt,
  planId: OrchestrationProposedPlan.fields.id,
  plan: OrchestrationProposedPlan,
});

const decodeStoredThreadHistoryThread = Schema.decodeUnknownEffect(StoredThreadHistoryThread);
const decodeStoredThreadHistoryMessages = Schema.decodeUnknownEffect(
  Schema.Array(StoredThreadHistoryMessage),
);
const decodeStoredThreadHistoryActivities = Schema.decodeUnknownEffect(
  Schema.Array(StoredThreadHistoryActivity),
);
const decodeStoredThreadHistoryPlans = Schema.decodeUnknownEffect(
  Schema.Array(StoredThreadHistoryPlan),
);

function transientError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the thread history cache: ${String(cause)}`,
  });
}

function persistenceError(
  operation:
    | "load-thread-history"
    | "save-thread-history"
    | "remove-thread"
    | "clear-thread-history"
    | "clear-environment",
  cause: unknown,
) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

const openDatabase = Effect.fn("web.threadHistoryCache.openDatabase")(function* () {
  return yield* Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (globalThis.indexedDB === undefined) {
      resume(Effect.fail(transientError("open", "IndexedDB is unavailable.")));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (request.result.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        request.result.deleteObjectStore(LEGACY_STORE_NAME);
      }
      if (!request.result.objectStoreNames.contains(THREAD_STORE_NAME)) {
        request.result.createObjectStore(THREAD_STORE_NAME, {
          keyPath: "scope",
        });
      }
      if (!request.result.objectStoreNames.contains(MESSAGE_STORE_NAME)) {
        const store = request.result.createObjectStore(MESSAGE_STORE_NAME, {
          keyPath: ["scope", "index"],
        });
        store.createIndex(MESSAGE_ID_INDEX_NAME, ["scope", "messageId"], {
          unique: true,
        });
      }
      if (!request.result.objectStoreNames.contains(ACTIVITY_STORE_NAME)) {
        const store = request.result.createObjectStore(ACTIVITY_STORE_NAME, {
          keyPath: ["scope", "activityId"],
        });
        store.createIndex(
          ACTIVITY_POSITION_INDEX_NAME,
          ["scope", "position", "activity.createdAt", "activityId"],
          { unique: true },
        );
      }
      if (!request.result.objectStoreNames.contains(PLAN_STORE_NAME)) {
        const store = request.result.createObjectStore(PLAN_STORE_NAME, {
          keyPath: ["scope", "planId"],
        });
        store.createIndex(
          PLAN_POSITION_INDEX_NAME,
          ["scope", "position", "plan.createdAt", "planId"],
          { unique: true },
        );
      }
    });
    request.addEventListener("error", () => {
      resume(Effect.fail(transientError("open", request.error ?? "Unknown IndexedDB error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  });
});

function readValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.addEventListener("error", () => {
      resume(Effect.fail(transientError("read", request.error ?? "Unknown IndexedDB read error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.threadHistoryCache.readValue"));
}

function readValuesInRange(
  database: IDBDatabase,
  storeName: string,
  range: IDBKeyRange,
  indexName?: string,
) {
  return Effect.callback<ReadonlyArray<unknown>, ConnectionTransientError>((resume) => {
    const store = database.transaction(storeName, "readonly").objectStore(storeName);
    const request = (indexName === undefined ? store : store.index(indexName)).getAll(range);
    request.addEventListener("error", () => {
      resume(Effect.fail(transientError("read", request.error ?? "Unknown IndexedDB read error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.threadHistoryCache.readValuesInRange"));
}

function writePage(
  database: IDBDatabase,
  thread: object,
  messages: ReadonlyArray<object>,
  activities: ReadonlyArray<object>,
  plans: ReadonlyArray<object>,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [THREAD_STORE_NAME, MESSAGE_STORE_NAME, ACTIVITY_STORE_NAME, PLAN_STORE_NAME],
      "readwrite",
    );
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(transientError("write", transaction.error ?? "Unknown IndexedDB write error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(THREAD_STORE_NAME).put(thread);
    const messageStore = transaction.objectStore(MESSAGE_STORE_NAME);
    for (const message of messages) {
      messageStore.put(message);
    }
    const activityStore = transaction.objectStore(ACTIVITY_STORE_NAME);
    for (const activity of activities) {
      activityStore.put(activity);
    }
    const planStore = transaction.objectStore(PLAN_STORE_NAME);
    for (const plan of plans) {
      planStore.put(plan);
    }
  }).pipe(Effect.withSpan("web.threadHistoryCache.writePage"));
}

function removeValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(
          transientError("remove", transaction.error ?? "Unknown IndexedDB remove error"),
        ),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).delete(key);
  }).pipe(Effect.withSpan("web.threadHistoryCache.removeValue"));
}

function removeValuesInRange(database: IDBDatabase, storeName: string, range: IDBKeyRange) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(
          transientError("remove", transaction.error ?? "Unknown IndexedDB cursor error"),
        ),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    const request = transaction.objectStore(storeName).openCursor(range);
    request.addEventListener("error", () => {
      resume(
        Effect.fail(transientError("remove", request.error ?? "Unknown IndexedDB cursor error")),
      );
    });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        return;
      }
      cursor.delete();
      cursor.continue();
    });
  }).pipe(Effect.withSpan("web.threadHistoryCache.removeValuesInRange"));
}

const clearDatabase = Effect.fn("web.threadHistoryCache.clearDatabase")(function* (
  database: IDBDatabase,
) {
  yield* Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(
      [THREAD_STORE_NAME, MESSAGE_STORE_NAME, ACTIVITY_STORE_NAME, PLAN_STORE_NAME],
      "readwrite",
    );
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(transientError("clear", transaction.error ?? "Unknown IndexedDB clear error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(THREAD_STORE_NAME).clear();
    transaction.objectStore(MESSAGE_STORE_NAME).clear();
    transaction.objectStore(ACTIVITY_STORE_NAME).clear();
    transaction.objectStore(PLAN_STORE_NAME).clear();
  });
});

function threadScope(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}

const loadThread = Effect.fn("web.threadHistoryCache.loadThread")(function* (
  database: IDBDatabase,
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const scope = threadScope(environmentId, threadId);
  const raw = yield* readValue(database, THREAD_STORE_NAME, scope);
  if (raw === undefined) {
    return Option.none();
  }
  const thread = yield* decodeStoredThreadHistoryThread(raw);
  return thread.scope === scope &&
    thread.environmentId === environmentId &&
    thread.threadId === threadId
    ? Option.some(thread)
    : Option.none();
});

const loadPage = Effect.fn("web.threadHistoryCache.loadPage")(function* (
  database: IDBDatabase,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  startIndex: number,
  endIndex: number,
  totalMessages: number,
) {
  if (endIndex <= startIndex) {
    return Option.none();
  }
  const scope = threadScope(environmentId, threadId);
  const [rawMessages, rawActivities, rawPlans] = yield* Effect.all([
    readValuesInRange(
      database,
      MESSAGE_STORE_NAME,
      IDBKeyRange.bound([scope, startIndex], [scope, endIndex - 1]),
    ),
    readValuesInRange(
      database,
      ACTIVITY_STORE_NAME,
      IDBKeyRange.bound([scope, startIndex], [scope, endIndex, "\uffff", "\uffff"]),
      ACTIVITY_POSITION_INDEX_NAME,
    ),
    readValuesInRange(
      database,
      PLAN_STORE_NAME,
      IDBKeyRange.bound([scope, startIndex], [scope, endIndex, "\uffff", "\uffff"]),
      PLAN_POSITION_INDEX_NAME,
    ),
  ]);
  const messageRecords = yield* decodeStoredThreadHistoryMessages(rawMessages);
  const activityRecords = yield* decodeStoredThreadHistoryActivities(rawActivities);
  const planRecords = yield* decodeStoredThreadHistoryPlans(rawPlans);
  if (
    messageRecords.length !== endIndex - startIndex ||
    messageRecords.some(
      (record, offset) =>
        record.scope !== scope ||
        record.environmentId !== environmentId ||
        record.threadId !== threadId ||
        record.index !== startIndex + offset,
    )
  ) {
    return Option.none();
  }
  const messages = messageRecords.map((record) => record.message);
  const firstMessage = messages[0];
  if (firstMessage === undefined) {
    return Option.none();
  }
  return Option.some({
    messages,
    activities: activityRecords
      .filter(
        (record) =>
          record.scope === scope &&
          record.environmentId === environmentId &&
          record.threadId === threadId,
      )
      .map((record) => record.activity)
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    proposedPlans: planRecords
      .filter(
        (record) =>
          record.scope === scope &&
          record.environmentId === environmentId &&
          record.threadId === threadId,
      )
      .map((record) => record.plan)
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < totalMessages,
      startIndex,
      endIndex,
      totalMessages,
      cursor: {
        createdAt: firstMessage.createdAt,
        messageId: firstMessage.id,
      },
    },
  });
});

export const makeWebThreadHistoryCacheStore = Effect.fn("web.threadHistoryCache.make")(
  function* () {
    const database = yield* Effect.acquireRelease(openDatabase(), (database) =>
      Effect.sync(() => database.close()),
    );
    const writeLock = yield* Semaphore.make(1);
    let activeWriteToken = 0;

    return ThreadHistoryCacheStore.of({
      loadPrevious: (environmentId, threadId, endIndex, limit) =>
        Effect.gen(function* () {
          const thread = yield* loadThread(database, environmentId, threadId);
          if (Option.isNone(thread)) {
            return { page: Option.none(), requestLimit: limit };
          }
          const range = thread.value.ranges.find(
            (candidate) => candidate.startIndex < endIndex && candidate.endIndex >= endIndex,
          );
          if (range !== undefined) {
            const turnStarts = thread.value.turnStarts.filter(
              (index) => index >= range.startIndex && index < endIndex,
            );
            const startIndex = turnStarts.at(-limit);
            return {
              page:
                startIndex === undefined
                  ? Option.none()
                  : yield* loadPage(
                      database,
                      environmentId,
                      threadId,
                      startIndex,
                      endIndex,
                      thread.value.totalMessages,
                    ),
              requestLimit: limit,
            };
          }
          return { page: Option.none(), requestLimit: limit };
        }).pipe(Effect.mapError((cause) => persistenceError("load-thread-history", cause))),
      loadNext: (environmentId, threadId, startIndex, limit) =>
        Effect.gen(function* () {
          const thread = yield* loadThread(database, environmentId, threadId);
          if (Option.isNone(thread)) {
            return { page: Option.none(), requestLimit: limit };
          }
          const range = thread.value.ranges.find(
            (candidate) => candidate.startIndex <= startIndex && candidate.endIndex > startIndex,
          );
          if (range !== undefined) {
            const turnStarts = thread.value.turnStarts.filter(
              (index) => index >= startIndex && index < range.endIndex,
            );
            const pageStartIndex = turnStarts[0];
            return {
              page:
                pageStartIndex === undefined
                  ? Option.none()
                  : yield* loadPage(
                      database,
                      environmentId,
                      threadId,
                      pageStartIndex,
                      turnStarts[limit] ?? range.endIndex,
                      thread.value.totalMessages,
                    ),
              requestLimit: limit,
            };
          }
          return { page: Option.none(), requestLimit: limit };
        }).pipe(Effect.mapError((cause) => persistenceError("load-thread-history", cause))),
      loadAround: (environmentId, threadId, messageId, limit) =>
        Effect.gen(function* () {
          const scope = threadScope(environmentId, threadId);
          const [thread, rawTargets] = yield* Effect.all([
            loadThread(database, environmentId, threadId),
            readValuesInRange(
              database,
              MESSAGE_STORE_NAME,
              IDBKeyRange.only([scope, messageId]),
              MESSAGE_ID_INDEX_NAME,
            ),
          ]);
          const targets = yield* decodeStoredThreadHistoryMessages(rawTargets);
          const target = targets[0];
          if (
            Option.isNone(thread) ||
            target === undefined ||
            target.scope !== scope ||
            target.environmentId !== environmentId ||
            target.threadId !== threadId
          ) {
            return Option.none();
          }
          const range = thread.value.ranges.find(
            (candidate) =>
              candidate.startIndex <= target.index && candidate.endIndex > target.index,
          );
          if (range === undefined) {
            return Option.none();
          }
          const turnStarts = thread.value.turnStarts.filter(
            (index) => index >= range.startIndex && index < range.endIndex,
          );
          const targetTurn = turnStarts.findLastIndex((index) => index <= target.index);
          if (targetTurn === -1) {
            return Option.none();
          }
          const startTurn = Math.max(
            0,
            Math.min(targetTurn - Math.floor((limit - 1) / 2), turnStarts.length - limit),
          );
          const startIndex = turnStarts[startTurn]!;
          const endIndex = turnStarts[startTurn + limit] ?? range.endIndex;
          return yield* loadPage(
            database,
            environmentId,
            threadId,
            startIndex,
            endIndex,
            thread.value.totalMessages,
          );
        }).pipe(Effect.mapError((cause) => persistenceError("load-thread-history", cause))),
      captureWriteToken: () => Effect.sync(() => activeWriteToken),
      save: (environmentId, threadId, page, writeToken) =>
        writeLock
          .withPermits(1)(
            Effect.gen(function* () {
              if (writeToken !== activeWriteToken || page.messages.length === 0) {
                return;
              }
              const scope = threadScope(environmentId, threadId);
              const current = yield* loadThread(database, environmentId, threadId);
              const ranges = [
                ...(Option.isSome(current) ? current.value.ranges : []),
                {
                  startIndex: page.messageHistory.startIndex,
                  endIndex: page.messageHistory.endIndex,
                },
              ].toSorted((left, right) => left.startIndex - right.startIndex);
              const turnStarts = [
                ...(Option.isSome(current) ? current.value.turnStarts : []),
                ...page.messages.flatMap((message, offset) =>
                  message.role === "user" ? [page.messageHistory.startIndex + offset] : [],
                ),
              ].toSorted((left, right) => left - right);
              const mergedRanges: Array<{ readonly startIndex: number; endIndex: number }> = [];
              for (const range of ranges) {
                const previous = mergedRanges.at(-1);
                if (previous === undefined || previous.endIndex < range.startIndex) {
                  mergedRanges.push({ ...range });
                } else {
                  previous.endIndex = Math.max(previous.endIndex, range.endIndex);
                }
              }
              let activityMessageOffset = 0;
              const activities = page.activities.map((activity) => {
                while (
                  activityMessageOffset < page.messages.length &&
                  page.messages[activityMessageOffset]!.createdAt <= activity.createdAt
                ) {
                  activityMessageOffset += 1;
                }
                return {
                  schemaVersion: CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  position: page.messageHistory.startIndex + activityMessageOffset,
                  activityId: activity.id,
                  activity,
                };
              });
              let planMessageOffset = 0;
              const plans = page.proposedPlans.map((plan) => {
                while (
                  planMessageOffset < page.messages.length &&
                  page.messages[planMessageOffset]!.createdAt <= plan.createdAt
                ) {
                  planMessageOffset += 1;
                }
                return {
                  schemaVersion: CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  position: page.messageHistory.startIndex + planMessageOffset,
                  planId: plan.id,
                  plan,
                };
              });
              yield* writePage(
                database,
                {
                  schemaVersion: CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  totalMessages: Math.max(
                    Option.isSome(current) ? current.value.totalMessages : 0,
                    page.messageHistory.totalMessages,
                  ),
                  ranges: mergedRanges,
                  turnStarts: [...new Set(turnStarts)],
                },
                page.messages.map((message, offset) => ({
                  schemaVersion: CACHE_SCHEMA_VERSION,
                  scope,
                  environmentId,
                  threadId,
                  index: page.messageHistory.startIndex + offset,
                  messageId: message.id,
                  message,
                })),
                activities,
                plans,
              );
            }),
          )
          .pipe(Effect.mapError((cause) => persistenceError("save-thread-history", cause))),
      remove: (environmentId, threadId) =>
        writeLock
          .withPermits(1)(
            Effect.gen(function* () {
              activeWriteToken += 1;
              yield* Effect.all(
                [
                  removeValue(database, THREAD_STORE_NAME, threadScope(environmentId, threadId)),
                  removeValuesInRange(
                    database,
                    MESSAGE_STORE_NAME,
                    IDBKeyRange.bound(
                      [threadScope(environmentId, threadId), 0],
                      [threadScope(environmentId, threadId), Number.MAX_SAFE_INTEGER],
                    ),
                  ),
                  removeValuesInRange(
                    database,
                    ACTIVITY_STORE_NAME,
                    IDBKeyRange.bound(
                      [threadScope(environmentId, threadId)],
                      [threadScope(environmentId, threadId), "\uffff"],
                    ),
                  ),
                  removeValuesInRange(
                    database,
                    PLAN_STORE_NAME,
                    IDBKeyRange.bound(
                      [threadScope(environmentId, threadId)],
                      [threadScope(environmentId, threadId), "\uffff"],
                    ),
                  ),
                ],
                { concurrency: "unbounded", discard: true },
              );
            }),
          )
          .pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause))),
      clear: (environmentId) =>
        writeLock
          .withPermits(1)(
            Effect.gen(function* () {
              activeWriteToken += 1;
              yield* Effect.all(
                [
                  removeValuesInRange(
                    database,
                    THREAD_STORE_NAME,
                    IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
                  ),
                  removeValuesInRange(
                    database,
                    MESSAGE_STORE_NAME,
                    IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
                  ),
                  removeValuesInRange(
                    database,
                    ACTIVITY_STORE_NAME,
                    IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
                  ),
                  removeValuesInRange(
                    database,
                    PLAN_STORE_NAME,
                    IDBKeyRange.bound([`${environmentId}:`], [`${environmentId}:\uffff`]),
                  ),
                ],
                { concurrency: "unbounded", discard: true },
              );
            }),
          )
          .pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause))),
      clearAll: () =>
        writeLock
          .withPermits(1)(
            Effect.gen(function* () {
              activeWriteToken += 1;
              yield* clearDatabase(database);
            }),
          )
          .pipe(Effect.mapError((cause) => persistenceError("clear-thread-history", cause))),
    });
  },
);
