import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Paragraph streaming holds assistant text at a position it already reserved. A message placed
 * into the running turn publishes that text first, so it never appears above the message later.
 */
export class HeldAssistantText extends Context.Reference<{
  readonly register: (threadId: ThreadId, publish: Effect.Effect<void>) => Effect.Effect<void>;
  readonly unregister: (threadId: ThreadId, publish: Effect.Effect<void>) => Effect.Effect<void>;
  readonly publish: (threadId: ThreadId) => Effect.Effect<void>;
}>("t3/orchestration-v2/HeldAssistantText", {
  defaultValue: () => ({
    register: () => Effect.void,
    unregister: () => Effect.void,
    publish: () => Effect.void,
  }),
}) {}

export const layer = Layer.sync(HeldAssistantText, () => {
  const publishers = new Map<ThreadId, Set<Effect.Effect<void>>>();
  return {
    register: Effect.fn("HeldAssistantText.register")((threadId, publish) =>
      Effect.sync(() => {
        const current = publishers.get(threadId) ?? new Set();
        current.add(publish);
        publishers.set(threadId, current);
      }),
    ),
    unregister: Effect.fn("HeldAssistantText.unregister")((threadId, publish) =>
      Effect.sync(() => {
        const current = publishers.get(threadId);
        current?.delete(publish);
        if (current?.size === 0) publishers.delete(threadId);
      }),
    ),
    publish: Effect.fn("HeldAssistantText.publish")((threadId) =>
      // A copy: a run that ends while another publishes unregisters itself.
      Effect.forEach(Array.from(publishers.get(threadId) ?? []), (publish) => publish, {
        discard: true,
      }),
    ),
  };
});
