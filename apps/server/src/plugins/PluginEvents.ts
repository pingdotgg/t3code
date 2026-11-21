import { PluginError, type OrchestrationV2StoredEvent, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { EventSinkV2Shape } from "../orchestration-v2/EventSink.ts";
import { executePlugin, type ExternalPluginEffect } from "./pluginBoundary.ts";

export interface PluginEventFilter {
  readonly eventType?: OrchestrationV2StoredEvent["event"]["type"];
  readonly threadId?: ThreadId;
}

export type PluginEventHandler = (
  event: OrchestrationV2StoredEvent,
) => ExternalPluginEffect | Promise<unknown> | void;

export interface PluginEventSubscription {
  readonly filter: PluginEventFilter;
  readonly handler: PluginEventHandler;
  readonly cursor: { afterSequence?: number };
}

/** Start only after generation commit; closing its scope stops delivery and releases live buffers. */
export const startPluginEventSubscriptions = Effect.fn("PluginEvents.startSubscriptions")(
  function* (input: {
    readonly id: string;
    readonly eventSink: EventSinkV2Shape;
    readonly scope: Scope.Closeable;
    readonly subscriptions: ReadonlyArray<PluginEventSubscription>;
    readonly afterSequence?: number;
  }) {
    if (input.subscriptions.length === 0) return;

    // EventSink defaults to replaying from sequence zero. This boundary excludes
    // history while its subscribe-before-replay path covers commits during setup.
    const afterSequence =
      input.afterSequence ??
      (yield* Effect.suspend(() => input.eventSink.latestSequence()).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new PluginError({
              id: input.id,
              message: `Could not start plugin event subscriptions: ${Cause.pretty(cause)}`,
            }),
          ),
        ),
      ));

    const prepared: Array<{
      subscription: PluginEventSubscription;
      events: ReturnType<EventSinkV2Shape["stream"]>;
    }> = [];
    for (const subscription of input.subscriptions) {
      const subscriptionAfterSequence = subscription.cursor.afterSequence ?? afterSequence;
      subscription.cursor.afterSequence = subscriptionAfterSequence;
      const events = yield* Effect.try({
        try: () =>
          input.eventSink.stream({
            ...subscription.filter,
            afterSequence: subscriptionAfterSequence,
            bounded: true,
            projection: "raw",
          }),
        catch: (cause) =>
          new PluginError({
            id: input.id,
            message: `Could not construct plugin event stream: ${String(cause)}`,
          }),
      });
      prepared.push({ subscription, events });
    }
    // A failing constructor must not leave earlier subscriptions running twice on retry.
    for (const { subscription, events } of prepared) {
      yield* events.pipe(
        Stream.runForEach((stored) =>
          executePlugin(() => subscription.handler(stored)).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Plugin event handler failed", {
                pluginId: input.id,
                sequence: stored.sequence,
                eventType: stored.event.type,
                threadId: stored.event.threadId,
                error,
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Plugin event subscription stopped", {
                pluginId: input.id,
                filter: subscription.filter,
                cause,
              }),
        ),
        Effect.forkIn(input.scope, { startImmediately: true }),
      );
    }
  },
);
