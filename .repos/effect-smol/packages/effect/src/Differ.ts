/**
 * The `Differ` module defines the core abstraction for describing changes to a
 * value. A `Differ<T, Patch>` knows how to compare two `T` values, produce a
 * patch that represents the difference, combine multiple patches, and apply a
 * patch to an old value to obtain the updated value.
 *
 * **Mental model**
 *
 * - A differ separates "what changed" from "the value after the change"
 * - `diff(oldValue, newValue)` produces a `Patch` that can later be applied
 * - `patch(oldValue, patch)` replays a patch against a value of the same domain
 * - `empty` is the identity patch: applying it should leave the value unchanged
 * - `combine(first, second)` composes patches in sequence, where `second`
 *   represents changes that happen after `first`
 * - Patch types are chosen by the differ implementation and may be compact,
 *   domain-specific, or compatible with a serialization format such as JSON
 *   Patch
 *
 * **Common tasks**
 *
 * - Construct a differ by providing the four operations of the {@link Differ}
 *   interface
 * - Compute a patch with `diff` when you have an old value and a new value
 * - Store, transmit, or aggregate patches instead of storing full replacement
 *   values
 * - Combine incremental updates with `combine` before applying them
 * - Apply updates with `patch` to reconstruct the next value from a previous
 *   value and a patch
 *
 * **Gotchas**
 *
 * - `combine` is order-sensitive for most patch formats
 * - A patch is generally meaningful only for values that belong to the same
 *   domain and assumptions used by the differ that created it
 * - Differs should make `empty` a true identity and should make combined
 *   patches behave the same as applying the original patches in order
 *
 * @since 4.0.0
 */

/**
 * Describes how to compute, combine, and apply patches for values of type `T`.
 *
 * **When to use**
 *
 * Use to model patch-based updates for a value type when callers need to
 * compute a patch from two values, combine patches, and apply a patch later.
 *
 * **Details**
 *
 * A `Differ` provides an empty patch, computes the patch between two values,
 * combines patches, and applies a patch to an old value to produce an updated
 * value.
 *
 * @category models
 * @since 2.0.0
 */
export interface Differ<in out T, in out Patch> {
  readonly empty: Patch
  diff(oldValue: T, newValue: T): Patch
  combine(first: Patch, second: Patch): Patch
  patch(oldValue: T, patch: Patch): T
}
