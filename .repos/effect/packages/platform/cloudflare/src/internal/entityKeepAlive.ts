/**
 * Keep-alive for one entity Durable Object, in three separate pieces of
 * state:
 *
 * - `wanted` mirrors the persisted `keep_alive` flag that a restart restores.
 * - `hold` is the fiber running the self `hold()` RPC while one is in flight.
 * - The holder count belongs to the current handler build only. Persisting it
 *   would break on restart: an `EntityResource` re-acquired by the rebuild
 *   adds a holder on top of the stored count, which then never returns to 0.
 *
 * @internal
 */
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Fiber from "effect/Fiber"
import * as Latch from "effect/Latch"
import * as Schedule from "effect/Schedule"

/** @internal */
export interface EntityKeepAlive {
  /** The `Entity.keepAlive` handler. */
  readonly update: (enabled: boolean) => Effect.Effect<void>
  /** The body of the self `hold()` RPC; resolves once the hold is released. */
  readonly await: Effect.Effect<void>
  /** Forgets the holders of a closed handler build. The hold stays. */
  readonly resetHolders: () => void
  /** Starts the self hold when keep-alive is wanted and none is in flight. */
  readonly restore: () => void
}

/** @internal */
export interface EntityKeepAliveOptions {
  /** Starts the self `hold()` RPC; the promise settles when the hold ends. */
  readonly startHold: () => Promise<void>
  /** The persisted flag, read when the Durable Object starts. */
  readonly wanted: boolean
  /**
   * Persists each requested flag in a forked fiber. The hold is released only
   * after a successful `false` write while keep-alive is still unwanted.
   */
  readonly persist: (wanted: boolean) => Effect.Effect<void>
  /** Upper bound of the retry delay after a failed hold RPC. */
  readonly retryCapMillis: () => number
}

/** @internal */
export const makeEntityKeepAlive = (options: EntityKeepAliveOptions): EntityKeepAlive => {
  const latch = Latch.makeUnsafe(true)
  let holders = 0
  let wanted = options.wanted
  let hold: Fiber.Fiber<void, unknown> | undefined

  // A safeguard only: production probes never saw a rejected hold.
  const runHold = Effect.tryPromise(() => options.startHold()).pipe(
    Effect.tapError((error) => Effect.logWarning("Entity keep-alive hold failed, retrying", error)),
    Effect.retry(
      Schedule.exponential(100).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.millis(options.retryCapMillis())))
        ),
        Schedule.jittered
      )
    )
  )

  const restore = () => {
    if (!wanted || hold !== undefined) return
    latch.closeUnsafe()
    const fiber = Effect.runFork(runHold)
    hold = fiber
    fiber.addObserver(() => {
      if (hold === fiber) hold = undefined
    })
  }

  const release = () => {
    if (hold === undefined) return
    hold.interruptUnsafe()
    hold = undefined
    latch.openUnsafe()
  }

  const setWanted = (next: boolean) => {
    if (wanted === next) return
    wanted = next
    // Mailbox writes wait for an open user transaction, so writing inline
    // would deadlock `Entity.keepAlive` called inside `withTransaction`.
    Effect.runFork(
      Effect.suspend(() => options.persist(next)).pipe(
        Effect.andThen(Effect.sync(() => {
          if (!next && !wanted) release()
        })),
        Effect.catchCause((cause) => Effect.logError("Entity keep-alive persistence failed", cause))
      )
    )
  }

  const update = (enabled: boolean): Effect.Effect<void> =>
    Effect.sync(() => {
      if (enabled) {
        holders++
        setWanted(true)
        // Also restarts a hold that ended without a release.
        restore()
        return
      }
      // With no holders in memory the flag may still be set: a fresh object
      // after a restart has count 0 while its stored row says 1.
      if (holders > 0) holders--
      if (holders === 0) setWanted(false)
    })

  return {
    update,
    await: latch.await,
    resetHolders: () => {
      holders = 0
    },
    restore
  }
}
