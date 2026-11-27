/**
 * Storage glue for the durable queue Durable Object. The constructor must stay
 * cheap: open SQLite, ensure the queue table, and re-arm the single alarm from
 * the earliest pending lease expiry or initial visibility deadline.
 *
 * Completed rows are retained (not deleted) so custom-id deduplication
 * survives completion, matching the SQL-backed store. A failed item moves to
 * the back of the queue, so a poisoned item cannot hot-loop the head while
 * still being retried ahead of items offered after its failure.
 *
 * `completed` holds the row state: 0 while pending, processing, or waiting to
 * retry, 1 once completed, and 2 once its final attempt failed. An
 * `"untilExecuted"` offer replaces a row in state 1 or 2.
 *
 * Each lease records its taker in `lease_owner` and the taker's
 * `max_attempts`. Settling or extending a lease only applies while that taker
 * still owns the row, so a taker whose lease expired cannot settle work another
 * taker now holds or a row an `"untilExecuted"` offer re-created.
 *
 * Leasing a row counts an attempt, so a taker that crashes still consumes one.
 * An expired lease keeps its owner until another taker leases the row; if it
 * used the row's last attempt the row moves to the failed state (2). A release
 * refunds the attempt. A recorded failure or release clears the owner, so a
 * retried `fail` or `release` cannot settle the same attempt twice.
 * A recorded failure that leaves the row pending stores its retry delay in
 * `lease_until` with no owner, the same delayed visibility an offer uses.
 * Lookups by taker go through `lease_owner`, so a retried take or a cancel
 * finds its row after the object restarts.
 *
 * @internal
 */
import type { SqlStorage } from "@cloudflare/workers-types"
import type { DurableQueueItem } from "../CloudflareDurableObjectPrograms.ts"

const ddl = [
  `CREATE TABLE IF NOT EXISTS queue_items (
    id TEXT PRIMARY KEY,
    element TEXT NOT NULL,
    position INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    lease_owner TEXT,
    max_attempts INTEGER,
    last_failure TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS queue_items_take_idx
    ON queue_items (completed, position)`,
  `CREATE INDEX IF NOT EXISTS queue_items_lease_idx
    ON queue_items (lease_until)`,
  // MAX(position) in offerItem/failItem needs a bare position index; the
  // (completed, position) index cannot serve it and completed rows are
  // retained forever for dedup.
  `CREATE INDEX IF NOT EXISTS queue_items_position_idx
    ON queue_items (position)`,
  // A retried take and a cancel look the taker's row up by owner.
  `CREATE INDEX IF NOT EXISTS queue_items_owner_idx
    ON queue_items (lease_owner)`
]

/** @internal */
export const ensureQueueStorage = (sql: SqlStorage): void => {
  for (const statement of ddl) {
    sql.exec(statement)
  }
}

/** @internal */
export type QueueItem = DurableQueueItem

type QueueItemRow = {
  readonly id: string
  readonly element: string
  readonly attempts: number
}

type LeaseExpiryRow = {
  readonly lease_until: number | null
}

/** @internal */
export const offerItem = (
  sql: SqlStorage,
  id: string,
  element: string,
  visibleAt: number | null,
  deduplicate?: "untilExecuted" | "untilRemoved" | undefined
): void => {
  if (deduplicate === "untilExecuted") {
    // A completed or failed row releases the id. Deleting it lets the insert
    // below store the offer as new work after every existing row. Both
    // statements run synchronously, so no other offer can interleave.
    sql.exec("DELETE FROM queue_items WHERE id = ? AND completed <> 0", id)
  }
  // Reuse lease_until for initial visibility; INSERT OR IGNORE preserves the
  // original deadline and payload when an id is offered again.
  sql.exec(
    `INSERT OR IGNORE INTO queue_items (id, element, position, lease_until)
     VALUES (?, ?, (SELECT IFNULL(MAX(position), 0) + 1 FROM queue_items), ?)`,
    id,
    element,
    visibleAt
  )
}

/**
 * Leases the next available item and counts the attempt. The returned
 * `attempts` is the number of earlier attempts, not counting this one.
 *
 * @internal
 */
export const leaseNextItem = (
  sql: SqlStorage,
  now: number,
  leaseUntil: number,
  maxAttempts: number,
  owner: string
): QueueItem | undefined => {
  const row = sql.exec<QueueItemRow>(
    `SELECT id, element, attempts FROM queue_items
     WHERE completed = 0 AND attempts < ? AND (lease_until IS NULL OR lease_until <= ?)
     ORDER BY position ASC LIMIT 1`,
    maxAttempts,
    now
  ).toArray()[0]
  if (row === undefined) return undefined
  sql.exec(
    `UPDATE queue_items SET attempts = attempts + 1, lease_until = ?, lease_owner = ?, max_attempts = ?
     WHERE id = ?`,
    leaseUntil,
    owner,
    maxAttempts,
    row.id
  )
  return row
}

/**
 * The item still leased to `owner` under a live lease, so a retried take can
 * return it. `attempts` counts earlier attempts, as `leaseNextItem` returns.
 *
 * @internal
 */
export const leasedItem = (sql: SqlStorage, owner: string, now: number): QueueItem | undefined =>
  sql.exec<QueueItemRow>(
    `SELECT id, element, attempts - 1 AS attempts FROM queue_items
     WHERE lease_owner = ? AND completed = 0 AND lease_until > ?
     LIMIT 1`,
    owner,
    now
  ).toArray()[0]

/** @internal */
export const completeItem = (sql: SqlStorage, id: string, owner: string): void => {
  sql.exec("UPDATE queue_items SET completed = 1, lease_until = NULL WHERE id = ? AND lease_owner = ?", id, owner)
}

/**
 * Records a failed attempt, which the lease already counted. When the attempt
 * reaches the `max_attempts` stored with the lease, or the failure is
 * `terminal`, the row moves to the failed state (2). A row that is already
 * completed is left alone, even when the caller was its last owner.
 * A row that stays pending is hidden until `visibleAt` (null for no delay).
 * Clearing `lease_owner` makes a replayed call a no-op until the next lease
 * assigns a new owner.
 *
 * @internal
 */
export const failItem = (
  sql: SqlStorage,
  id: string,
  lastFailure: string,
  owner: string,
  terminal: boolean,
  visibleAt: number | null
): void => {
  const failed = "? OR attempts >= max_attempts"
  sql.exec(
    `UPDATE queue_items
     SET lease_until = CASE WHEN ${failed} THEN NULL ELSE ? END, lease_owner = NULL, last_failure = ?,
         completed = CASE WHEN ${failed} THEN 2 ELSE 0 END,
         position = (SELECT IFNULL(MAX(position), 0) + 1 FROM queue_items)
     WHERE id = ? AND lease_owner = ? AND completed = 0`,
    terminal ? 1 : 0,
    visibleAt,
    lastFailure,
    terminal ? 1 : 0,
    id,
    owner
  )
}

/**
 * Returns the item to the queue and refunds the attempt its lease counted.
 *
 * @internal
 */
export const releaseItem = (sql: SqlStorage, id: string, owner: string): void => {
  sql.exec(
    `UPDATE queue_items SET attempts = attempts - 1, lease_until = NULL, lease_owner = NULL
     WHERE id = ? AND lease_owner = ? AND completed = 0`,
    id,
    owner
  )
}

/**
 * Releases the item `owner` holds under a live lease, as `releaseItem` does.
 * An expired lease can still carry the same owner until its alarm runs; it
 * keeps its spent attempt so it can fail on its own.
 *
 * @internal
 */
export const releaseOwnedItem = (sql: SqlStorage, owner: string, now: number): void => {
  sql.exec(
    `UPDATE queue_items SET attempts = attempts - 1, lease_until = NULL, lease_owner = NULL
     WHERE lease_owner = ? AND completed = 0 AND lease_until > ?`,
    owner,
    now
  )
}

/** @internal */
export const extendLease = (sql: SqlStorage, id: string, leaseUntil: number, owner: string): void => {
  sql.exec(
    "UPDATE queue_items SET lease_until = ? WHERE id = ? AND lease_owner = ? AND lease_until IS NOT NULL",
    leaseUntil,
    id,
    owner
  )
}

/**
 * Expires due leases and initial visibility deadlines. A lease that used the
 * row's last attempt moves the row to the failed state (2).
 *
 * @internal
 */
export const expireLeases = (sql: SqlStorage, now: number): void => {
  sql.exec(
    `UPDATE queue_items
     SET lease_until = NULL,
         completed = CASE WHEN lease_owner IS NOT NULL AND attempts >= max_attempts THEN 2 ELSE 0 END
     WHERE lease_until IS NOT NULL AND lease_until <= ? AND completed = 0`,
    now
  )
}

/** @internal */
export const earliestLeaseExpiry = (sql: SqlStorage): number | undefined => {
  const row = sql.exec<LeaseExpiryRow>(
    "SELECT min(lease_until) AS lease_until FROM queue_items WHERE lease_until IS NOT NULL"
  ).toArray()[0]
  return row?.lease_until ?? undefined
}
