/**
 * @title Working with the Schedule module
 *
 * Build schedules, compose them, and use them with `Effect.retry` and `Effect.repeat`.
 */
import { Duration, Effect, Random, Schedule, Schema } from "effect"

export class HttpError extends Schema.TaggedErrorClass<HttpError>()("HttpError", {
  message: Schema.String,
  status: Schema.Number,
  retryable: Schema.Boolean
}) {}

// Start with a few schedule constructors.
export const maxRetries = Schedule.recurs(5)
export const spacedPolling = Schedule.spaced("30 seconds")
export const exponentialBackoff = Schedule.exponential("200 millis")

// `Schedule.both` continues only while both schedules continue.
// It is useful for combining a delay pattern with a hard attempt cap.
export const retryBackoffWithLimit = Schedule.both(
  Schedule.exponential("250 millis"),
  Schedule.recurs(6)
)

// `Schedule.either` continues while either schedule continues.
// It is useful for fallback behavior (e.g. stop only when both are exhausted).
export const keepTryingUntilBothStop = Schedule.either(
  Schedule.spaced("2 seconds"),
  Schedule.recurs(3)
)

// Use `Schedule.while` to continue only for retryable failures.
// This lets non-retryable errors fail fast, even if attempts remain.
export const retryableOnly = Schedule.exponential("200 millis").pipe(
  // You can use `setInputType` to specify the type of input the schedule will
  // receive.
  Schedule.setInputType<HttpError>(),
  Schedule.while(({ input }) => input.retryable)
)

// `tapInput` and `tapOutput` are useful for performing side effects like
// logging or metrics.
export const instrumentedRetrySchedule = retryableOnly.pipe(
  Schedule.setInputType<HttpError>(),
  Schedule.tapInput((error) => Effect.logDebug(`Retrying after ${error.status}: ${error.message}`)),
  Schedule.tapOutput((delay) => Effect.logDebug(`Next retry in ${Duration.toMillis(delay)}ms`))
)

// Production pattern: capped exponential backoff with jitter and max attempts.
// Delays start at 250ms, grow exponentially with jitter, and are capped at 10s.
export const productionRetrySchedule = Schedule.exponential("250 millis").pipe(
  // Cap the delay at 10 seconds to avoid excessively long waits.
  Schedule.either(Schedule.spaced("10 seconds")),
  Schedule.jittered,
  Schedule.setInputType<HttpError>(),
  Schedule.while(({ input }) => input.retryable)
)

export const fetchUserProfile = Effect.fn("fetchUserProfile")(
  function*(userId: string) {
    const random = yield* Random.next
    const status = random > 0.7
      ? 200
      : random > 0.3
      ? 503
      : 401

    if (status !== 200) {
      return yield* new HttpError({
        message: `Request for ${userId} failed`,
        status,
        retryable: status >= 500
      })
    }

    return {
      id: userId,
      name: "Ada Lovelace"
    } as const
  }
)

// Use the schedule with `Effect.retry` to retry failures.
export const loadUserWithRetry = fetchUserProfile("user-123").pipe(
  Effect.retry(productionRetrySchedule),
  // If the effect still fails after exhausting the schedule, turn the error
  // into a fatal one.
  Effect.orDie
)

export const loadUserWithInferredInput = fetchUserProfile("user-123").pipe(
  // You can also pass a schedule builder function that assists with inferring
  // the input type. This is especially useful when the schedule needs to
  // inspect the error to determine retryability.
  Effect.retry(($) =>
    $(Schedule.spaced("1 seconds")).pipe(
      Schedule.while(({ input }) => input.retryable)
    )
  ),
  Effect.orDie
)
