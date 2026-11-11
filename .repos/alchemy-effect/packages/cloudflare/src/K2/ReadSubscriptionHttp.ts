import * as k2 from "@distilled.cloud/cloudflare/k2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { fromConsumedRecords } from "./K2Codec.ts";
import { type K2Auth, makeK2HttpAuth } from "./K2Http.ts";
import type { Batch } from "./K2Types.ts";
import { ReadSubscription, type ReadSubscriptionClient } from "./ReadSubscription.ts";
import type { Subscription } from "./Subscription.ts";

/** Default `maxRecords` per `consume`. */
export const DEFAULT_MAX_RECORDS = 100;

/**
 * HTTP-backed implementation of the {@link ReadSubscription} service. Mints
 * a scoped `K2 Consume` {@link AccountApiToken}, binds it into the host, and
 * leases batches through the stream's data-plane API
 * (`https://<id>.k2.cloudflarestorage.com/subscriptions/...`).
 * ### Providing the Layer
 * **Example:** Pull from a container
 * ```typescript
 * Effect.gen(function* () {
 *   const inbox = yield* Cloudflare.K2.ReadSubscription(Analytics);
 *   // ...
 * }).pipe(Effect.provide(Cloudflare.K2.ReadSubscriptionHttp));
 * ```
 *
 * @layer
 * @provides Cloudflare.K2.ReadSubscription
 * @product K2
 * @category Storage & Databases
 */
export const ReadSubscriptionHttp = Layer.effect(
  ReadSubscription,
  Effect.gen(function* () {
    const auth = yield* makeK2HttpAuth;
    return Effect.fn(function* (subscription: Subscription) {
      const subscriptionAuth = yield* auth(subscription, "K2 Consume");
      return makeReadSubscriptionClient(subscriptionAuth, {
        streamId: yield* subscription.streamId,
        subscriptionId: yield* subscription.subscriptionId,
      });
    });
  }),
);

/**
 * Build the pull client over the K2 subscription HTTP API. Shared by
 * {@link ReadSubscriptionHttp} and `ReadSubscriptionLocal`.
 */
export const makeReadSubscriptionClient = (
  auth: K2Auth,
  ids: {
    streamId: Effect.Effect<string>;
    subscriptionId: Effect.Effect<string>;
  },
): ReadSubscriptionClient => {
  const target = Effect.all({ streamId: ids.streamId, subscriptionId: ids.subscriptionId });
  const onBatch = (batch: Batch) =>
    target.pipe(Effect.map((t) => ({ ...t, batchId: batch.batchId, workerId: batch.workerId })));
  return {
    consume: ({ workerId, maxRecords }) =>
      target.pipe(
        Effect.flatMap((t) =>
          auth.authorize(
            k2.consume({ ...t, workerId, maxRecords: maxRecords ?? DEFAULT_MAX_RECORDS }),
          ),
        ),
        Effect.map((response) =>
          response.batchId
            ? Option.some<Batch>({
                batchId: response.batchId,
                workerId,
                leasedUntil: new Date(response.leasedUntilMs ?? 0),
                records: fromConsumedRecords(response.records),
              })
            : Option.none(),
        ),
      ),
    ack: (batch) =>
      onBatch(batch).pipe(
        Effect.flatMap((request) => auth.authorize(k2.ackBatch(request))),
        Effect.asVoid,
      ),
    nack: (batch) =>
      onBatch(batch).pipe(
        Effect.flatMap((request) => auth.authorize(k2.nackBatch(request))),
        Effect.asVoid,
      ),
    extend: (batch) =>
      onBatch(batch).pipe(
        Effect.flatMap((request) => auth.authorize(k2.extendLease(request))),
        Effect.map((response): Batch => ({
          ...batch,
          leasedUntil: new Date(response.leasedUntilMs),
        })),
      ),
  };
};
