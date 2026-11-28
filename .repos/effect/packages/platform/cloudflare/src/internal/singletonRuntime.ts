/**
 * Runs one singleton effect for each Worker Cron Trigger wake. Concurrent
 * duplicate wakes are ignored while the accepted wake is still running; once
 * it returns, the object has no live work and Cloudflare may hibernate it.
 *
 * While a wake runs, a watchdog alarm stays armed in the future. If it fires
 * mid-run it is re-armed, so losing the isolate never leaves the pending wake
 * without an alarm to resume it.
 *
 * @internal
 */
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"
import { armAlarm } from "./entityStorage.ts"
import {
  beginSingletonWake,
  completeSingletonWake,
  ensureSingletonStorage,
  loadSingletonState
} from "./singletonStorage.ts"

/**
 * How far ahead the watchdog alarm is armed while a wake is running.
 */
const watchdogMillis = 60_000

/** @internal */
export interface SingletonRuntimeOptions {
  readonly sql: SqlStorage
  readonly alarm: Pick<DurableObjectStorage, "deleteAlarm" | "getAlarm" | "setAlarm">
  readonly now: () => number
  readonly run: Effect.Effect<void, unknown>
}

/** @internal */
export interface SingletonRuntime {
  readonly wake: () => Promise<void>
  readonly runAlarm: () => Promise<void>
}

/** @internal */
export const makeSingletonRuntime = (options: SingletonRuntimeOptions): SingletonRuntime => {
  ensureSingletonStorage(options.sql)
  let inFlight: Promise<void> | undefined

  const armWatchdog = (): Effect.Effect<void> =>
    Effect.suspend(() => armAlarm(options.alarm, options.now() + watchdogMillis))

  const runPending = (arm: boolean): Promise<void> => {
    const run = options.run.pipe(
      Effect.ensuring(
        Effect.promise(() => options.alarm.deleteAlarm()).pipe(
          Effect.ensuring(Effect.sync(() => completeSingletonWake(options.sql)))
        )
      )
    )
    const operation = Effect.runPromise(arm ? Effect.andThen(armWatchdog(), run) : run)
    inFlight = operation
    void operation.then(
      () => {
        inFlight = undefined
      },
      () => {
        inFlight = undefined
      }
    )
    return operation
  }

  return {
    wake: () => {
      if (inFlight !== undefined) return Promise.resolve()
      const pending = loadSingletonState(options.sql).wakeAt
      if (pending !== undefined) return runPending(false)
      const now = options.now()
      if (!beginSingletonWake(options.sql, now)) return Promise.resolve()
      return runPending(true)
    },

    // Cloudflare consumes the alarm before invoking this handler, so an alarm
    // that fires during a run must arm the next watchdog before returning.
    runAlarm: () => {
      if (loadSingletonState(options.sql).wakeAt === undefined) return Promise.resolve()
      if (inFlight !== undefined) return Effect.runPromise(armWatchdog())
      return runPending(false)
    }
  }
}
