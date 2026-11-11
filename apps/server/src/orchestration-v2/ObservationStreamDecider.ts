import {
  type ObservationItem,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export type ObservationStreamCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "observation.append"
      | "observation.subscribe"
      | "observation.unsubscribe"
      | "observation.link-work"
      | "observation.decline"
      | "observation.duplicate";
  }
>;

const itemsOf = (thread: OrchestrationV2AppThread): ReadonlyArray<ObservationItem> =>
  thread.observationItems ?? [];

const subscribersOf = (thread: OrchestrationV2AppThread): ReadonlyArray<ThreadId> =>
  thread.observationStreamSubscribers ?? [];

const withStream = (
  thread: OrchestrationV2AppThread,
  items: ReadonlyArray<ObservationItem>,
  subscribers: ReadonlyArray<ThreadId>,
  now: DateTime.Utc,
) =>
  Result.succeed({
    ...thread,
    observationItems: [...items],
    observationStreamSubscribers: [...subscribers],
    updatedAt: now,
  });

const findItem = (items: ReadonlyArray<ObservationItem>, itemId: ObservationItem["id"]) => {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return Result.fail(`Observation ${itemId} was not found.`);
  return Result.succeed({ item: items[index]!, index });
};

const replaceAt = (
  items: ReadonlyArray<ObservationItem>,
  index: number,
  item: ObservationItem,
): ReadonlyArray<ObservationItem> => items.map((candidate, i) => (i === index ? item : candidate));

/**
 * Applies an observation-stream command to the home thread. Append is intake only;
 * subscribe opts a seat into the stream; act closes an open item without creating ownership.
 */
export function decideObservationStreamCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: ObservationStreamCommand;
  readonly now: DateTime.Utc;
}): Result.Result<OrchestrationV2AppThread, string> {
  const { thread, command, now } = input;
  if (thread.deletedAt !== null) return Result.fail(`Thread ${thread.id} is deleted.`);
  if (thread.archivedAt !== null) {
    return Result.fail("Archived threads cannot change the observation stream.");
  }

  const items = itemsOf(thread);
  const subscribers = subscribersOf(thread);
  const nowIso = DateTime.formatIso(now);

  switch (command.type) {
    case "observation.append": {
      if (items.some((item) => item.id === command.itemId)) {
        return Result.fail(`Observation ${command.itemId} already exists.`);
      }
      const item: ObservationItem = {
        id: command.itemId,
        title: command.title,
        body: command.body,
        status: "open",
        createdByThreadId: command.createdByThreadId,
        linkedThreadId: null,
        duplicateOfObservationId: null,
        actedByThreadId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        actedAt: null,
      };
      return withStream(thread, [...items, item], subscribers, now);
    }
    case "observation.subscribe": {
      if (subscribers.includes(command.subscriberThreadId)) return Result.succeed(thread);
      return withStream(thread, items, [...subscribers, command.subscriberThreadId], now);
    }
    case "observation.unsubscribe": {
      if (!subscribers.includes(command.subscriberThreadId)) return Result.succeed(thread);
      return withStream(
        thread,
        items,
        subscribers.filter((id) => id !== command.subscriberThreadId),
        now,
      );
    }
    case "observation.link-work": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (item.status !== "open") {
        return Result.fail(`Observation ${command.itemId} is already closed (${item.status}).`);
      }
      return withStream(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "linked",
          linkedThreadId: command.linkedThreadId,
          actedByThreadId: command.actorThreadId,
          actedAt: nowIso,
          updatedAt: nowIso,
        }),
        subscribers,
        now,
      );
    }
    case "observation.decline": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (item.status !== "open") {
        return Result.fail(`Observation ${command.itemId} is already closed (${item.status}).`);
      }
      return withStream(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "declined",
          actedByThreadId: command.actorThreadId,
          actedAt: nowIso,
          updatedAt: nowIso,
        }),
        subscribers,
        now,
      );
    }
    case "observation.duplicate": {
      const found = findItem(items, command.itemId);
      if (Result.isFailure(found)) return Result.fail(found.failure);
      const { item, index } = found.success;
      if (item.status !== "open") {
        return Result.fail(`Observation ${command.itemId} is already closed (${item.status}).`);
      }
      if (command.duplicateOfObservationId === command.itemId) {
        return Result.fail("An observation cannot be marked as a duplicate of itself.");
      }
      if (!items.some((candidate) => candidate.id === command.duplicateOfObservationId)) {
        return Result.fail(
          `Duplicate target observation ${command.duplicateOfObservationId} was not found.`,
        );
      }
      return withStream(
        thread,
        replaceAt(items, index, {
          ...item,
          status: "duplicated",
          duplicateOfObservationId: command.duplicateOfObservationId,
          actedByThreadId: command.actorThreadId,
          actedAt: nowIso,
          updatedAt: nowIso,
        }),
        subscribers,
        now,
      );
    }
  }
}
