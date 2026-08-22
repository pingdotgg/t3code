import { ProviderDriverKind, ProviderInteractionMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

export interface ProviderInteractionModeReflection {
  readonly threadId: ThreadId;
  readonly driver: ProviderDriverKind;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * Stable per-native-event key. The worker derives the command id from it, so
   * a replayed or duplicated native event dedupes through command receipts
   * instead of re-emitting a thread update.
   */
  readonly dedupeKey: string;
}

/**
 * Adapters offer a reflection when the provider itself moves a session between
 * its native plan and build modes (for example OpenCode's plan_exit flow
 * switching the session to the build agent) so the thread's interaction mode
 * follows reality instead of pushing the stale mode back on the next turn.
 * The default reference drops requests, keeping adapter construction
 * dependency-free in tests; the live layer must be shared with the
 * ProviderInteractionModeReflectionService worker that drains it.
 */
export class ProviderInteractionModeReflections extends Context.Reference<{
  readonly offer: (request: ProviderInteractionModeReflection) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderInteractionModeReflection>;
}>("t3/orchestration-v2/ProviderInteractionModeReflections", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderInteractionModeReflections,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderInteractionModeReflection>();
    return {
      offer: (request: ProviderInteractionModeReflection) =>
        Queue.offer(queue, request).pipe(Effect.asVoid),
      take: Queue.take(queue),
    };
  }),
);
