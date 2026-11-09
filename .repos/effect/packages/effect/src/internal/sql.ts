import { Clock } from "../Clock.ts"
import * as Context from "../Context.ts"
import type * as Fiber from "../Fiber.ts"
import type * as Tracer from "../Tracer.ts"
import { TracerTimingEnabled } from "./references.ts"

/**
 * The transaction service of the innermost transaction started with
 * `SqlClient.makeWithTransaction`. `SqlResolver` reads it to find that
 * transaction when the request's context has no `SqlClient` for it. Removing
 * the service from a context also hides the transaction from this lookup.
 *
 * @internal
 */
export const CurrentTransactionService = Context.Reference<Context.Key<any, object> | undefined>(
  "effect/sql/CurrentTransactionService",
  { defaultValue: () => undefined }
)

/**
 * The clock to measure connection wait time with, or `undefined` without span
 * timing, when the span has no start time to measure from.
 *
 * @internal
 */
export const waitClock = (fiber: Fiber.Fiber<unknown, unknown>): Clock | undefined =>
  fiber.getRef(TracerTimingEnabled) ? fiber.getRef(Clock) : undefined

/**
 * Records the time from the span's start to the connection hand-off as
 * `db.client.connection.wait_time_ms`.
 *
 * @internal
 */
export const recordConnectionWait = (span: Tracer.Span, clock: Clock): void =>
  span.attribute(
    "db.client.connection.wait_time_ms",
    Number(clock.currentTimeNanosUnsafe() - span.status.startTime) / 1e6
  )
