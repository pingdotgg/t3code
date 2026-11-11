import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeK2LocalAuth } from "./K2Http.ts";
import { ReadSubscription } from "./ReadSubscription.ts";
import { makeReadSubscriptionClient } from "./ReadSubscriptionHttp.ts";
import type { Subscription } from "./Subscription.ts";

/**
 * Local implementation of the {@link ReadSubscription} service — leases
 * batches over the K2 subscription HTTP API with the **current
 * credentials** instead of a scoped token. Provide it on an Action (or any
 * deploy-time Effect), or on a polling event source run in-process.
 *
 * The subscription's ids are resolved at apply time, so the subscription
 * can be created in the same deploy.
 * ### Providing the Layer
 * **Example:** Drain a subscription from an Action
 * ```typescript
 * const Drain = Alchemy.Action(
 *   "Drain",
 *   Effect.gen(function* () {
 *     const inbox = yield* Cloudflare.K2.ReadSubscription(Analytics);
 *     return Effect.fn(function* () {
 *       const batch = yield* inbox.consume({ workerId: "drain" });
 *       if (Option.isSome(batch)) yield* inbox.ack(batch.value);
 *     });
 *   }).pipe(Effect.provide(Cloudflare.K2.ReadSubscriptionLocal)),
 * );
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.ReadSubscription
 * @product K2
 * @category Storage & Databases
 */
export const ReadSubscriptionLocal = Layer.effect(
  ReadSubscription,
  Effect.gen(function* () {
    const auth = yield* makeK2LocalAuth;
    return Effect.fn(function* (subscription: Subscription) {
      // Deferred accessors — resolved at apply time. No `host.bind`: the
      // local variant registers no binding.
      return makeReadSubscriptionClient(auth, {
        streamId: yield* subscription.streamId,
        subscriptionId: yield* subscription.subscriptionId,
      });
    });
  }),
);
