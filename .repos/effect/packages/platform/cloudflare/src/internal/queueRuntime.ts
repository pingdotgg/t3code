/**
 * The durable queue Durable Object runtime. One object holds one named queue:
 * items live in SQLite, and every lease arms the single alarm at its expiry so
 * an item whose worker died is redelivered once the watchdog fires. Takers
 * with no available item wait in memory until an offer, a retry, or a lease
 * expiry wakes them; a crash or hibernation drops those waiters, whose broken
 * RPCs are retried from the Worker side. An interrupted taker cancels its wait
 * by taker id, releasing an item that was already leased to it.
 *
 * `take` is idempotent per taker id: a retried take replaces the taker's
 * waiter, or returns the item still leased to it. Leases are found by owner in
 * SQLite, so a retry or cancel still finds its item after a restart.
 *
 * @internal
 */
import type { SqlStorage } from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"
import { armAlarm, type EntityAlarm } from "./entityStorage.ts"
import {
  completeItem,
  earliestLeaseExpiry,
  ensureQueueStorage,
  expireLeases,
  extendLease,
  failItem,
  leasedItem,
  leaseNextItem,
  offerItem,
  type QueueItem,
  releaseItem,
  releaseOwnedItem
} from "./queueStorage.ts"

/** @internal */
export interface QueueRuntimeOptions {
  readonly sql: SqlStorage
  readonly alarm: EntityAlarm
  readonly now: () => number
}

/** @internal */
export interface QueueRuntime {
  readonly offer: (
    id: string,
    element: string,
    delayMillis?: number,
    deduplicate?: "untilExecuted" | "untilRemoved"
  ) => Promise<void>
  readonly take: (takerId: string, maxAttempts: number, leaseMillis: number) => Promise<QueueItem>
  readonly cancelTake: (takerId: string) => Promise<void>
  readonly complete: (id: string, takerId: string) => Promise<void>
  readonly fail: (
    id: string,
    lastFailure: string,
    takerId: string,
    terminal?: boolean,
    retryDelayMillis?: number
  ) => Promise<void>
  readonly release: (id: string, takerId: string) => Promise<void>
  readonly extend: (id: string, leaseMillis: number, takerId: string) => Promise<void>
  readonly runAlarm: () => Promise<void>
}

interface Waiter {
  readonly takerId: string
  readonly maxAttempts: number
  readonly leaseMillis: number
  resolve: (item: QueueItem) => void
}

/** @internal */
export const makeQueueRuntime = (options: QueueRuntimeOptions): QueueRuntime => {
  const sql = options.sql
  ensureQueueStorage(sql)

  const waiters: Array<Waiter> = []

  // Waiters differ in maxAttempts, so one waiter finding nothing does not mean
  // a later one will; every waiter gets its own lease attempt. Leasing stays
  // fully synchronous so concurrent wake-ups cannot interleave on the waiter
  // list; only the final alarm arm is asynchronous.
  const wakeWaiters = Effect.suspend(() => {
    const now = options.now()
    let index = 0
    while (index < waiters.length) {
      const waiter = waiters[index]
      const item = leaseNextItem(sql, now, now + waiter.leaseMillis, waiter.maxAttempts, waiter.takerId)
      if (item === undefined) {
        index++
        continue
      }
      waiters.splice(index, 1)
      waiter.resolve(item)
    }
    // Include initial visibility deadlines even when no taker is waiting.
    const earliest = earliestLeaseExpiry(sql)
    return earliest === undefined ? Effect.void : armAlarm(options.alarm, earliest)
  })

  const mutateAndWake = (mutate: () => void): Promise<void> =>
    Effect.runPromise(Effect.suspend(() => {
      mutate()
      return wakeWaiters
    }))

  return {
    offer: (id, element, delayMillis = 0, deduplicate) =>
      mutateAndWake(() => {
        offerItem(sql, id, element, delayMillis > 0 ? options.now() + delayMillis : null, deduplicate)
      }),

    // The taker joins the waiter list and the shared wake pass leases to it,
    // so an immediate take and a woken one follow the same code path.
    take: (takerId, maxAttempts, leaseMillis) => {
      // A broken take RPC is retried with the same taker id. The retry must
      // not leave a second waiter that leases an item nobody handles.
      const leased = leasedItem(sql, takerId, options.now())
      if (leased !== undefined) return Promise.resolve(leased)
      const existing = waiters.find((waiter) => waiter.takerId === takerId)
      const item = new Promise<QueueItem>((resolve) => {
        if (existing === undefined) {
          waiters.push({ takerId, maxAttempts, leaseMillis, resolve })
        } else {
          existing.resolve = resolve
        }
      })
      return Effect.runPromise(wakeWaiters).then(() => item)
    },

    cancelTake: (takerId) => {
      const index = waiters.findIndex((waiter) => waiter.takerId === takerId)
      if (index >= 0) {
        waiters.splice(index, 1)
        return Promise.resolve()
      }
      // The cancel can race the delivery; release an item already leased to
      // the taker instead of stranding it.
      return mutateAndWake(() => {
        releaseOwnedItem(sql, takerId, options.now())
      })
    },

    complete: (id, takerId) => Promise.resolve(completeItem(sql, id, takerId)),

    fail: (id, lastFailure, takerId, terminal = false, retryDelayMillis = 0) =>
      mutateAndWake(() => {
        failItem(
          sql,
          id,
          lastFailure,
          takerId,
          terminal,
          retryDelayMillis > 0 ? options.now() + retryDelayMillis : null
        )
      }),

    release: (id, takerId) =>
      mutateAndWake(() => {
        releaseItem(sql, id, takerId)
      }),

    extend: (id, leaseMillis, takerId) => Promise.resolve(extendLease(sql, id, options.now() + leaseMillis, takerId)),

    runAlarm: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          expireLeases(sql, options.now())
          yield* wakeWaiters
          const next = earliestLeaseExpiry(sql)
          if (next !== undefined) yield* armAlarm(options.alarm, next)
        })
      )
  }
}
