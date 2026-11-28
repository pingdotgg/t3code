/**
 * Storage glue for the entity Durable Object constructor. The constructor must
 * stay cheap: open SQLite, ensure the mailbox tables, and re-arm the single
 * alarm. No user handlers are built here.
 *
 * @internal
 */
import type { DurableObjectStorage, SqlStorage } from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"

/** @internal */
export type EntityAlarm = Pick<DurableObjectStorage, "getAlarm" | "setAlarm">

type DeliverAtRow = {
  readonly deliver_at: number | null
}

/**
 * Runs a synchronous storage effect inside `transactionSync`. A defect throws
 * out of the callback and rolls the transaction back; a typed failure happens
 * before any write in the mailbox operations, so it is carried out as a plain
 * failure.
 *
 * @internal
 */
export const withTransaction = <A, E>(
  storage: Pick<DurableObjectStorage, "transactionSync">,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const result = storage.transactionSync(() => Effect.runSync(Effect.result(effect)))
    return Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure)
  })

const ddl = [
  `CREATE TABLE IF NOT EXISTS cluster_messages (
    request_id TEXT PRIMARY KEY,
    message_id TEXT UNIQUE,
    envelope TEXT NOT NULL,
    discard INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0,
    last_reply_id TEXT,
    deliver_at INTEGER,
    reply_to TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS cluster_replies (
    reply_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    reply TEXT NOT NULL,
    kind TEXT NOT NULL,
    sequence INTEGER,
    acked INTEGER NOT NULL DEFAULT 0,
    UNIQUE (request_id, sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS cluster_messages_deliver_at_idx
    ON cluster_messages (processed, deliver_at)`,
  `CREATE INDEX IF NOT EXISTS cluster_replies_unacked_idx
    ON cluster_replies (request_id) WHERE kind = 'Chunk' AND acked = 0`,
  // One row: whether the entity wants keep-alive across restarts, and the
  // encoded name for wakes that arrive without one.
  `CREATE TABLE IF NOT EXISTS cluster_entity_state (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    keep_alive INTEGER NOT NULL DEFAULT 0,
    name TEXT
  )`
]

/** @internal */
export const ensureEntityStorage = (sql: SqlStorage): void => {
  for (const statement of ddl) {
    sql.exec(statement)
  }
}

/** @internal */
export const earliestDeliverAt = (sql: SqlStorage): number | undefined => {
  const rows = sql.exec<DeliverAtRow>(
    "SELECT min(deliver_at) AS deliver_at FROM cluster_messages WHERE processed = 0 AND deliver_at IS NOT NULL"
  ).toArray()
  return rows[0]?.deliver_at ?? undefined
}

/** @internal */
export const armAlarm = (alarm: EntityAlarm, deliverAt: number): Effect.Effect<void> =>
  Effect.promise(() => alarm.getAlarm()).pipe(
    Effect.flatMap((current) =>
      current === null || current > deliverAt
        ? Effect.promise(() => alarm.setAlarm(deliverAt))
        : Effect.void
    )
  )

type EntityStateRow = {
  readonly keep_alive: number
  readonly name: string | null
}

/** @internal */
export interface EntityState {
  readonly keepAlive: boolean
  readonly name: string | undefined
}

/** @internal */
export const loadEntityState = (sql: SqlStorage): EntityState => {
  const row = sql.exec<EntityStateRow>("SELECT keep_alive, name FROM cluster_entity_state WHERE id = 0").toArray()[0]
  return { keepAlive: row?.keep_alive === 1, name: row?.name ?? undefined }
}

/** @internal */
export const saveKeepAlive = (sql: SqlStorage, enabled: boolean): Effect.Effect<void> =>
  Effect.sync(() => {
    sql.exec(
      `INSERT INTO cluster_entity_state (id, keep_alive) VALUES (0, ?)
       ON CONFLICT (id) DO UPDATE SET keep_alive = excluded.keep_alive`,
      enabled ? 1 : 0
    )
  })

/** @internal */
export const rememberEntityName = (sql: SqlStorage, name: string): void => {
  sql.exec(
    `INSERT INTO cluster_entity_state (id, name) VALUES (0, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
    name
  )
}

type UnprocessedRow = {
  readonly request_id: string
  readonly deliver_at: number | null
}

/**
 * The single alarm time covering every reason to wake this entity: the
 * earliest due row, `now` for an unprocessed row nothing is running, and a
 * heartbeat while a row is in flight or keep-alive is wanted. An in-flight row
 * counts as a heartbeat rather than `now`, so a long handler does not keep
 * re-firing the alarm.
 *
 * @internal
 */
export const nextAlarmAt = (
  sql: SqlStorage,
  options: {
    readonly now: number
    readonly heartbeatMillis: number
    readonly isRunning: (requestId: string) => boolean
  }
): number | undefined => {
  let next = Infinity
  let heartbeat = loadEntityState(sql).keepAlive
  const rows = sql.exec<UnprocessedRow>(
    "SELECT request_id, deliver_at FROM cluster_messages WHERE processed = 0"
  ).toArray()
  for (const row of rows) {
    if (options.isRunning(row.request_id)) {
      heartbeat = true
      continue
    }
    next = Math.min(next, row.deliver_at === null ? options.now : Math.max(row.deliver_at, options.now))
  }
  if (heartbeat) {
    next = Math.min(next, options.now + options.heartbeatMillis)
  }
  return Number.isFinite(next) ? next : undefined
}
