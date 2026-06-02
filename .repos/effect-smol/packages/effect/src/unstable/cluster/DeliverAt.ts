/**
 * The `DeliverAt` module defines the protocol used by cluster message payloads
 * that carry their own scheduled delivery time. A value implements the protocol
 * by exposing a method at the `DeliverAt` symbol that returns the target
 * `DateTime`.
 *
 * **Common tasks**
 *
 * - Mark a message payload as deliverable at a specific time by implementing
 *   {@link DeliverAt}
 * - Check whether an arbitrary value carries a scheduled delivery time with
 *   {@link isDeliverAt}
 * - Convert a scheduled delivery time to epoch milliseconds with
 *   {@link toMillis}
 *
 * **Gotchas**
 *
 * - The protocol records the requested delivery instant; cluster infrastructure
 *   may still deliver later because of clock skew, queue latency, or worker
 *   availability
 * - Values that do not implement the symbol method are treated as unscheduled;
 *   {@link toMillis} returns `null` for those values
 *
 * @since 4.0.0
 */
import type { DateTime } from "../../DateTime.ts"
import { hasProperty } from "../../Predicate.ts"

/**
 * Defines the property key used by values that provide a scheduled delivery time.
 *
 * **When to use**
 *
 * Use to implement the scheduled-delivery protocol on cluster message payloads
 * by defining a method at this property key.
 *
 * @category symbols
 * @since 4.0.0
 */
export const symbol = "~effect/cluster/DeliverAt"

/**
 * Interface for payloads that specify when a cluster message should be delivered
 * by returning the target delivery `DateTime` through the `DeliverAt` symbol
 * method.
 *
 * @category models
 * @since 4.0.0
 */
export interface DeliverAt {
  [symbol](): DateTime
}

/**
 * Returns `true` if the value implements the `DeliverAt` scheduled-delivery
 * protocol.
 *
 * @category guards
 * @since 4.0.0
 */
export const isDeliverAt = (self: unknown): self is DeliverAt => hasProperty(self, symbol)

/**
 * Returns the scheduled delivery time in epoch milliseconds when the value
 * implements `DeliverAt`, or `null` otherwise.
 *
 * @category accessors
 * @since 4.0.0
 */
export const toMillis = (self: unknown): number | null => {
  if (isDeliverAt(self)) {
    return self[symbol]().epochMilliseconds
  }
  return null
}
