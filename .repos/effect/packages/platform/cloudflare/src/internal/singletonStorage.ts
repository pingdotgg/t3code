/**
 * Storage glue for the singleton Durable Object. A pending row is a watchdog:
 * a normal wake clears it after the effect returns, while an isolate crash
 * leaves it for the constructor to re-arm on the next alarm wake.
 *
 * @internal
 */
import type { SqlStorage } from "@cloudflare/workers-types"

const ddl = `CREATE TABLE IF NOT EXISTS singleton_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT,
  wake_at INTEGER
)`

/** @internal */
export const ensureSingletonStorage = (sql: SqlStorage): void => {
  sql.exec(ddl)
}

/** @internal */
export interface SingletonState {
  readonly name: string | undefined
  readonly wakeAt: number | undefined
}

type SingletonStateRow = {
  readonly name: string | null
  readonly wake_at: number | null
}

/** @internal */
export const loadSingletonState = (sql: SqlStorage): SingletonState => {
  const row = sql.exec<SingletonStateRow>("SELECT name, wake_at FROM singleton_state WHERE id = 1").toArray()[0]
  return {
    name: row?.name ?? undefined,
    wakeAt: row?.wake_at ?? undefined
  }
}

/** @internal */
export const rememberSingletonName = (sql: SqlStorage, name: string): void => {
  sql.exec(
    `INSERT INTO singleton_state (id, name) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
    name
  )
}

/** @internal */
export const beginSingletonWake = (sql: SqlStorage, wakeAt: number): boolean => {
  if (loadSingletonState(sql).wakeAt !== undefined) return false
  sql.exec(
    `INSERT INTO singleton_state (id, wake_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET wake_at = excluded.wake_at`,
    wakeAt
  )
  return true
}

/** @internal */
export const completeSingletonWake = (sql: SqlStorage): void => {
  sql.exec("UPDATE singleton_state SET wake_at = NULL WHERE id = 1")
}
