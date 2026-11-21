/** @internal */
import { PersistenceError } from "effect/cluster/ClusterError"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"

/**
 * The flags Cloudflare sets on the Error a failed Durable Object call rejects
 * with.
 *
 * @internal
 */
export interface TransportErrorFlags {
  readonly retryable?: boolean | undefined
  readonly overloaded?: boolean | undefined
  readonly remote?: boolean | undefined
}

/**
 * Whether a failed Durable Object call may be retried. Cloudflare marks
 * transient failures `retryable`, and an `overloaded` object must not be
 * retried, as retrying only adds load.
 *
 * @internal
 */
export const isRetryable = (error: PersistenceError): boolean => {
  const cause = error.cause as TransportErrorFlags | null | undefined
  return typeof cause === "object" && cause !== null && cause.retryable === true && cause.overloaded !== true
}

/**
 * The bounded retry policy for idempotent calls outside a workflow: a few
 * quick attempts, then the caller sees the typed error.
 *
 * @internal
 */
export const boundedRetry: Schedule.Schedule<unknown> = Schedule.max([
  Schedule.exponential(100, 2),
  Schedule.recurs(4)
])

/**
 * Makes one Worker-to-Durable Object stub call.
 *
 * **Details**
 *
 * A rejection becomes a `PersistenceError` whose `cause` is the rejected
 * value, so Cloudflare's `retryable`, `overloaded` and `remote` flags stay
 * readable. Each attempt resolves a fresh stub with `resolve`, because
 * Cloudflare advises against reusing a stub after it throws. With `retry`, the
 * call is retried on that schedule while the error is retryable; only pass it
 * for idempotent calls.
 *
 * @internal
 */
export const callDurableObject = <Stub, A>(options: {
  readonly resolve: () => Stub
  readonly call: (stub: Stub) => Promise<A>
  readonly retry?: Schedule.Schedule<unknown, PersistenceError> | undefined
}): Effect.Effect<A, PersistenceError> => {
  const attempt = Effect.tryPromise({
    try: () => options.call(options.resolve()),
    catch: (cause) => new PersistenceError({ cause })
  })
  return options.retry === undefined
    ? attempt
    : Effect.retry(attempt, { schedule: options.retry, while: isRetryable })
}
