import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { WorktreeInventoryChange } from "@t3tools/contracts";

export class WorktreeLifecycle extends Context.Service<
  WorktreeLifecycle,
  {
    readonly withMutationPermit: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly markInventoryChanged: Effect.Effect<void>;
    readonly changes: Stream.Stream<WorktreeInventoryChange>;
  }
>()("t3/vcs/WorktreeLifecycle") {}

export const make = Effect.gen(function* () {
  const mutationSemaphore = yield* Semaphore.make(1);
  const revision = yield* SubscriptionRef.make(0);

  const withMutationPermit: WorktreeLifecycle["Service"]["withMutationPermit"] = (effect) =>
    mutationSemaphore.withPermit(effect);
  const markInventoryChanged = SubscriptionRef.update(revision, (current) => current + 1);
  const changes = SubscriptionRef.changes(revision).pipe(
    Stream.map((currentRevision) => ({ revision: currentRevision })),
  );

  return WorktreeLifecycle.of({
    withMutationPermit,
    markInventoryChanged,
    changes,
  });
});

export const layer = Layer.effect(WorktreeLifecycle, make);
