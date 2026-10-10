import type { PromptSuggestion, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

interface PromptSuggestionChange {
  readonly threadId: ThreadId;
  readonly suggestion: PromptSuggestion | null;
}

/**
 * The latest suggested next prompt per thread, in memory only. Adapters
 * publish `null` when the next turn starts or the session closes, which bounds
 * the map to live sessions.
 *
 * The default reference drops everything, keeping adapter construction
 * dependency-free in tests. The live layer must be the same layer reference in
 * the adapter infrastructure and the WebSocket routes so layer memoization
 * yields one shared map.
 */
export class PromptSuggestions extends Context.Reference<{
  readonly publish: (
    threadId: ThreadId,
    suggestion: PromptSuggestion | null,
  ) => Effect.Effect<void>;
  readonly stream: (threadId: ThreadId) => Stream.Stream<PromptSuggestion | null>;
}>("t3/provider/PromptSuggestions", {
  defaultValue: () => ({
    publish: () => Effect.void,
    stream: () => Stream.make(null),
  }),
}) {}

export const make = Effect.gen(function* () {
  const suggestions = new Map<ThreadId, PromptSuggestion>();
  const changes = yield* PubSub.unbounded<PromptSuggestionChange>();

  const publish: (typeof PromptSuggestions.Service)["publish"] = (threadId, suggestion) =>
    Effect.gen(function* () {
      const existing = suggestions.get(threadId) ?? null;
      if (existing?.id === suggestion?.id) return;
      if (suggestion === null) {
        suggestions.delete(threadId);
      } else {
        suggestions.set(threadId, suggestion);
      }
      yield* PubSub.publish(changes, { threadId, suggestion });
    });

  /**
   * One-slot sliding mailbox per subscriber: each value replaces the last, so
   * a slow socket only ever holds the current suggestion.
   */
  const stream: (typeof PromptSuggestions.Service)["stream"] = (threadId) =>
    Stream.callback<PromptSuggestion | null>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = suggestions.get(threadId) ?? null;
          Queue.offerUnsafe(mailbox, initial);
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((change) =>
              Effect.sync(() => {
                if (change.threadId === threadId) Queue.offerUnsafe(mailbox, change.suggestion);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return { publish, stream } satisfies typeof PromptSuggestions.Service;
});

export const layer = Layer.effect(PromptSuggestions, make);
