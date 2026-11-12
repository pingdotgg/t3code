import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { AckError, Batch, ConsumeError, ExtendError, NackError } from "./K2Types.ts";
import type { Subscription } from "./Subscription.ts";

/** Options for {@link ReadSubscriptionClient.consume}. */
export interface ConsumeOptions {
  /**
   * The consumer requesting the lease, 1 to 256 characters. A worker that
   * already holds a lease gets the same batch back. Use a distinct id per
   * concurrent consumer.
   */
  workerId: string;
  /**
   * At most this many records, from 1 to 10000.
   * @default 100
   */
  maxRecords?: number;
}

/**
 * Binding service that turns a K2 {@link Subscription} into a pull client:
 * lease a batch of records, then acknowledge it (advance the subscription),
 * nack it (redeliver), or extend its five-minute lease.
 *
 * The native `k2` Worker binding can only produce, so this service ships
 * HTTP implementations only: {@link ReadSubscriptionHttp} (scoped
 * `K2 Consume` token) and {@link ReadSubscriptionLocal} (current
 * credentials). For a long-running consumer loop, see
 * `consumeStreamRecords`.
 * ### Pulling Records
 * **Example:** Lease, process, and acknowledge a batch
 * ```typescript
 * const inbox = yield* Cloudflare.K2.ReadSubscription(Analytics);
 *
 * const batch = yield* inbox.consume({ workerId: "worker-1", maxRecords: 100 });
 * if (Option.isSome(batch)) {
 *   yield* Effect.forEach(batch.value.records, (record) =>
 *     Effect.log(new TextDecoder().decode(record.content)),
 *   );
 *   yield* inbox.ack(batch.value);
 * }
 * ```
 *
 * ### Redelivery
 * **Example:** Release a batch for redelivery
 * ```typescript
 * yield* process(batch.records).pipe(
 *   Effect.andThen(inbox.ack(batch)),
 *   Effect.catch(() => inbox.nack(batch)),
 * );
 * ```
 *
 * @binding
 * @product K2
 * @category Storage & Databases
 */
export interface ReadSubscription extends Binding.Service<
  ReadSubscription,
  "Cloudflare.K2.ReadSubscription",
  (subscription: Subscription) => Effect.Effect<ReadSubscriptionClient>
> {}

export const ReadSubscription = Binding.Service<ReadSubscription>("Cloudflare.K2.ReadSubscription");

export interface ReadSubscriptionClient {
  /**
   * Lease the next batch of records for five minutes. `None` when there are
   * no records to read.
   */
  consume(
    options: ConsumeOptions,
  ): Effect.Effect<Option.Option<Batch>, ConsumeError, RuntimeContext>;
  /** Mark a batch processed and release its lease. Acknowledging twice succeeds. */
  ack(batch: Batch): Effect.Effect<void, AckError, RuntimeContext>;
  /** Release a batch for redelivery (under a new batch id). */
  nack(batch: Batch): Effect.Effect<void, NackError, RuntimeContext>;
  /**
   * Extend a held lease to five minutes from now. Fails with `K2LeaseLost`
   * when the worker no longer holds it.
   */
  extend(batch: Batch): Effect.Effect<Batch, ExtendError, RuntimeContext>;
}
