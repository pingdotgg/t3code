import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ApprovalGate } from "../Services/ApprovalGate.ts";

export const ApprovalGateLive = Layer.effect(
  ApprovalGate,
  Effect.gen(function* () {
    const pending = yield* Ref.make(new Map<string, Deferred.Deferred<boolean>>());
    const activeWaiters = yield* Ref.make(new Map<string, number>());

    const getOrCreate = (stepRunId: string) =>
      Effect.gen(function* () {
        // Created speculatively, registered atomically: two concurrent
        // callers must end up waiting on the SAME deferred or the loser's
        // waiter could never be resolved.
        const fresh = yield* Deferred.make<boolean>();
        return yield* Ref.modify(pending, (current) => {
          const existing = current.get(stepRunId);
          if (existing) {
            return [existing, current] as const;
          }
          return [fresh, new Map(current).set(stepRunId, fresh)] as const;
        });
      });

    const incrementWaiter = (stepRunId: string) =>
      Ref.update(activeWaiters, (current) => {
        const next = new Map(current);
        next.set(stepRunId, (next.get(stepRunId) ?? 0) + 1);
        return next;
      });

    const decrementWaiter = (stepRunId: string) =>
      Ref.update(activeWaiters, (current) => {
        const next = new Map(current);
        const count = (next.get(stepRunId) ?? 0) - 1;
        if (count <= 0) {
          next.delete(stepRunId);
        } else {
          next.set(stepRunId, count);
        }
        return next;
      });

    // stepRunIds are unique per attempt and resolve is terminal (the engine
    // commits StepUserResolved before any further await could occur), so once a
    // wait is resolved its deferred is dead. Drop it to keep `pending` from
    // growing unbounded for the process lifetime. Any in-flight Deferred.await
    // already captured the deferred reference in getOrCreate, so the delete is
    // safe — it only evicts the resolved entry from the lookup map.
    const prune = (stepRunId: string) =>
      Ref.update(pending, (current) => {
        if (!current.has(stepRunId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(stepRunId);
        return next;
      });

    return ApprovalGate.of({
      park: (stepRunId) => getOrCreate(stepRunId).pipe(Effect.asVoid),
      await: (stepRunId) =>
        Effect.gen(function* () {
          const id = stepRunId as string;
          const deferred = yield* getOrCreate(id);
          return yield* incrementWaiter(id).pipe(
            Effect.andThen(Deferred.await(deferred)),
            Effect.ensuring(decrementWaiter(id)),
          );
        }),
      resolve: (stepRunId, approved) =>
        Effect.gen(function* () {
          const id = stepRunId as string;
          const deferred = yield* getOrCreate(id);
          const liveWaiters = (yield* Ref.get(activeWaiters)).get(id) ?? 0;
          yield* Deferred.succeed(deferred, approved);
          yield* prune(id);
          return liveWaiters > 0;
        }),
    });
  }),
);
