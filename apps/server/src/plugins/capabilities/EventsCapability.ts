/**
 * Read-only delivery of host domain events to a plugin.
 *
 * A plugin could already act when the USER asked (tools, HTTP routes) but not when
 * the SYSTEM did something, so "notify me when a turn finishes" or "mirror threads
 * into a tracker" was impossible. The host already publishes the stream; this hands
 * a filtered view of it to plugins that hold the `events` capability.
 *
 * @module plugins/capabilities/EventsCapability
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import type { EventsCapability, PluginLogger } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * How many events a single subscriber may fall behind before the oldest are
 * dropped. Sized for a plugin that is briefly busy, not one that is broken.
 */
const SUBSCRIBER_BUFFER = 256;

/**
 * How long one handler invocation may run before it is abandoned.
 *
 * A handler that hangs must not silently stop delivery for the rest of the process
 * lifetime — that looks exactly like "the event never fired" and is undebuggable.
 */
const HANDLER_TIMEOUT = Duration.seconds(30);

export const makeEventsCapability = (input: {
  readonly pluginId: string;
  readonly logger: PluginLogger;
  readonly events: Stream.Stream<OrchestrationEvent>;
}): EventsCapability => ({
  subscribe: (subscription) =>
    Effect.gen(function* () {
      const wanted = new Set(subscription.types);
      // Filter in the HOST, before the handler sees anything: holding the
      // capability grants the event stream, but a plugin still only observes the
      // types it named.
      const selected = input.events.pipe(Stream.filter((event) => wanted.has(event.type)));

      // Hand off through a SLIDING queue rather than consuming the host stream
      // directly.
      //
      // This is the decision with real teeth. An unbounded buffer lets a stuck
      // plugin grow memory until the host dies. Blocking (a bounded, suspending
      // queue) lets a third-party plugin apply backpressure to the host's own event
      // stream and stall orchestration for everyone. Neither is acceptable: the
      // host's liveness outranks one plugin's completeness, and a plugin that cannot
      // keep up is already broken. So the OLDEST events are dropped instead — and
      // counted, because a silently lossy bus would have plugin authors reporting
      // "the event never fired" with no way to tell truth from bug.
      const queue = yield* Queue.sliding<OrchestrationEvent, Cause.Done>(SUBSCRIBER_BUFFER);
      const dropped = yield* Ref.make(0);

      const pump = yield* selected.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const size = yield* Queue.size(queue);
            if (size >= SUBSCRIBER_BUFFER) {
              // Sliding discards silently, so the drop is counted here, before the
              // offer that causes it.
              const total = yield* Ref.updateAndGet(dropped, (count) => count + 1);
              if (total === 1 || total % 100 === 0) {
                yield* input.logger.warn("plugin fell behind on events; dropping oldest", {
                  pluginId: input.pluginId,
                  dropped: total,
                });
              }
            }
            yield* Queue.offer(queue, event);
          }),
        ),
        // End the queue when the host's stream ends, so the subscription ends with
        // it. Without this the consumer below waits on a queue nothing will ever
        // fill again, and `subscribe` would hang forever on host shutdown instead of
        // returning — the plugin's service would then have to be interrupted to stop.
        Effect.ensuring(Queue.end(queue)),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Effect.addFinalizer(() => Fiber.interrupt(pump).pipe(Effect.orDie));

      return yield* Stream.fromQueue(queue).pipe(
        Stream.runForEach((event) =>
          // Recover PER EVENT, not per stream. `Stream.catchCause(() =>
          // Stream.empty)` would end the whole subscription on the first handler
          // failure: later events would still reach the host's PubSub, but this
          // plugin would never see another one for the process lifetime. A plugin
          // handler is also the one piece of code here the host does not own, so it
          // must not be able to take delivery down.
          subscription.handler(event).pipe(
            Effect.timeout(HANDLER_TIMEOUT),
            Effect.catchCause((cause) =>
              input.logger.warn("plugin event handler failed", {
                pluginId: input.pluginId,
                type: event.type,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
});
