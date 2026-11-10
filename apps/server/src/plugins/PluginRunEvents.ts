import type { ApplicationStoredEvent } from "@t3tools/contracts";
import type { PluginRunEvent } from "@t3tools/plugin-sdk/server";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import type { OrchestrationEventStoreError } from "../persistence/Errors.ts";

export class PluginRunEventCursorError extends Schema.TaggedError<PluginRunEventCursorError>()(
  "PluginRunEventCursorError",
  {},
) {
  override get message(): string {
    return "A plugin event cursor must be a nonnegative safe integer.";
  }
}

export class PluginRunEventHistoryPrunedError extends Schema.TaggedError<PluginRunEventHistoryPrunedError>()(
  "PluginRunEventHistoryPrunedError",
  { afterSequence: Schema.Number, prunedThroughSequence: Schema.Number },
) {
  override get message(): string {
    return "The plugin event cursor is older than the retained event history.";
  }
}

export class PluginRunEvents extends Context.Service<
  PluginRunEvents,
  {
    readonly runs: (options?: {
      readonly afterSequence?: number;
    }) => Stream.Stream<
      PluginRunEvent,
      OrchestrationEventStoreError | PluginRunEventCursorError | PluginRunEventHistoryPrunedError
    >;
  }
>()("t3/plugins/PluginRunEvents") {}

const isFinishedRunEvent = (stored: ApplicationStoredEvent) =>
  "event" in stored &&
  stored.event.type === "run.updated" &&
  ["completed", "failed", "cancelled", "interrupted"].includes(stored.event.payload.status);

const projectRunEvent = (stored: ApplicationStoredEvent): PluginRunEvent | undefined => {
  if (!("event" in stored)) return;
  const { event, sequence } = stored;
  if (event.type !== "run.updated") return;
  const run = event.payload;
  if (
    run.status !== "completed" &&
    run.status !== "failed" &&
    run.status !== "cancelled" &&
    run.status !== "interrupted"
  )
    return;
  return {
    sequence,
    deliveryId: event.id,
    type: "run.finished",
    threadId: run.threadId,
    runId: run.id,
    status: run.status,
    completedAt: DateTime.formatIso(run.completedAt ?? event.occurredAt),
  };
};

const make = Effect.gen(function* () {
  const store = yield* OrchestrationEventStore.OrchestrationEventStore;
  const checkCursor = Effect.fn("PluginRunEvents.checkCursor")(function* (cursor: number) {
    const prunedThroughSequence = yield* store.prunedThroughSequence;
    if (cursor < prunedThroughSequence) {
      return yield* new PluginRunEventHistoryPrunedError({
        afterSequence: cursor,
        prunedThroughSequence,
      });
    }
  });
  return PluginRunEvents.of({
    runs: (options) => {
      const afterSequence = options?.afterSequence;
      if (
        afterSequence !== undefined &&
        (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      ) {
        return Stream.fail(new PluginRunEventCursorError());
      }
      return Stream.unwrap(
        Effect.gen(function* () {
          const cursor = afterSequence ?? (yield* store.latestApplicationSequence);
          yield* checkCursor(cursor);
          return store.streamProjectedApplicationEvents({
            afterSequence: cursor,
            project: (stored) => projectRunEvent(stored)!,
            filter: isFinishedRunEvent,
            onReplayComplete: checkCursor(cursor),
          });
        }),
      );
    },
  });
});

export const layer = Layer.effect(PluginRunEvents, make);
