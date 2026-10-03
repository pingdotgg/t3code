import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { WorktreeInventoryChange } from "@t3tools/contracts";

/**
 * The inventory revision that settings clients subscribe to. Every service
 * that adds or removes a worktree bumps it, so this stays a leaf with no
 * dependencies. Mutations coordinate through the per-path workspace lease,
 * not here.
 */
export class WorktreeLifecycle extends Context.Service<
  WorktreeLifecycle,
  {
    readonly markInventoryChanged: Effect.Effect<void>;
    readonly revision: Effect.Effect<number>;
    readonly changes: Stream.Stream<WorktreeInventoryChange>;
  }
>()("t3/vcs/WorktreeLifecycle") {}

const make = Effect.gen(function* () {
  // Seeded from the clock so a restarted server never repeats a revision a
  // client still holds a list for: any difference tells it to read again.
  const revision = yield* SubscriptionRef.make(yield* Clock.currentTimeMillis);

  return WorktreeLifecycle.of({
    markInventoryChanged: SubscriptionRef.update(revision, (current) => current + 1),
    revision: SubscriptionRef.get(revision),
    changes: SubscriptionRef.changes(revision).pipe(
      Stream.map((currentRevision) => ({ revision: currentRevision })),
    ),
  });
});

export const layer = Layer.effect(WorktreeLifecycle, make);
