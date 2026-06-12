/**
 * The `Take` module provides the stored representation of one pull result from
 * a stream-like producer. A `Take<A, E, Done>` is either a non-empty batch of
 * emitted values, a failed `Exit`, or a successful `Exit` carrying the
 * completion value.
 *
 * **Mental model**
 *
 * - A value batch represents elements that were pulled successfully
 * - A failed `Exit` represents an ordinary pull failure
 * - A successful `Exit` represents normal completion and carries `Done`
 * - {@link toPull} interprets the stored result as a `Pull.Pull` step
 *
 * **Common tasks**
 *
 * - Store or transfer one pull result as {@link Take}
 * - Turn a stored result back into a pull step with {@link toPull}
 *
 * **Gotchas**
 *
 * - Value batches are `NonEmptyReadonlyArray` values; empty arrays are not
 *   valid `Take` values
 * - Successful `Exit` values do not emit elements; they signal completion
 * - `Take` is a representation, not a queue or stream by itself
 *
 * **See also**
 *
 * - {@link Pull.Pull} for the pull-step effect interpreted by {@link toPull}
 * - {@link Exit.Exit} for the success and failure outcomes stored by `Take`
 *
 * @since 2.0.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import * as Cause from "./Cause.ts"
import * as Effect from "./Effect.ts"
import * as Exit from "./Exit.ts"
import type * as Pull from "./Pull.ts"

/**
 * Represents one pull result: either a non-empty batch of values, a failure
 * `Exit`, or a successful `Exit` that signals completion with a `Done` value.
 *
 * **When to use**
 *
 * Use to store, transfer, or interpret pull results later while preserving
 * emitted values, failures, and normal completion.
 *
 * @see {@link toPull} for interpreting a `Take` as a `Pull` step
 *
 * @category models
 * @since 2.0.0
 */
export type Take<A, E = never, Done = void> = NonEmptyReadonlyArray<A> | Exit.Exit<Done, E>

/**
 * Converts a `Take` into a `Pull`, succeeding with value batches, failing with
 * failure exits, and translating successful exits into pull completion.
 *
 * **When to use**
 *
 * Use to interpret a stored or transferred `Take` as a `Pull` step while
 * preserving emitted batches, ordinary failures, and completion values.
 *
 * @category converting
 * @since 4.0.0
 */
export const toPull = <A, E, Done>(take: Take<A, E, Done>): Pull.Pull<NonEmptyReadonlyArray<A>, E, Done> =>
  Exit.isExit(take)
    ? Exit.isSuccess(take) ? Cause.done(take.value) : (take as Exit.Exit<never, E>)
    : Effect.succeed(take)
