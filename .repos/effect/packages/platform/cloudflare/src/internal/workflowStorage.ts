/**
 * Storage glue for the workflow Durable Object. The constructor must stay
 * cheap: open SQLite, ensure the tables, and re-arm the single alarm from the
 * earliest pending clock. No workflow handlers are built here.
 *
 * @internal
 */
import type { SqlStorage } from "@cloudflare/workers-types"

const ddl = [
  `CREATE TABLE IF NOT EXISTS workflow_execution (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    workflow_name TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    parent_name TEXT,
    parent_execution_id TEXT,
    result TEXT,
    resume_pending INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_activities (
    key TEXT PRIMARY KEY,
    exit TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_deferreds (
    name TEXT PRIMARY KEY,
    exit TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_clocks (
    name TEXT PRIMARY KEY,
    deferred_name TEXT NOT NULL,
    wake_up INTEGER NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0
  )`
]

/** @internal */
export const ensureWorkflowStorage = (sql: SqlStorage): void => {
  for (const statement of ddl) {
    sql.exec(statement)
  }
}

/**
 * How a replay was requested. An explicit wake (`resume`, `interrupt`) always
 * replays; an automatic wake (deferred or clock completion, a child's
 * completion) leaves a failure-suspended execution parked.
 *
 * @internal
 */
export type WakeMode = "explicit" | "automatic"

/**
 * The stored `(workflowName, executionId)` also serve to recover the object
 * name on an alarm wake, where `ctx.id.name` is undefined.
 *
 * @internal
 */
export interface ExecutionRow {
  readonly workflowName: string
  readonly executionId: string
  readonly payload: string
  readonly parent: { readonly workflowName: string; readonly executionId: string } | undefined
  readonly result: string | undefined
  /**
   * The pending replay of an incomplete execution. Once complete, any value
   * means the parent completion wake is still undelivered.
   */
  readonly resumePending: WakeMode | undefined
}

type StoredExecutionRow = {
  readonly workflow_name: string
  readonly execution_id: string
  readonly payload: string
  readonly parent_name: string | null
  readonly parent_execution_id: string | null
  readonly result: string | null
  readonly resume_pending: number
}

type ExitRow = {
  readonly exit: string
}

type ClockWakeUpRow = {
  readonly wake_up: number | null
}

type ClockRow = {
  readonly name: string
  readonly deferred_name: string
}

// 1 predates wake modes, so a row written before them replays as explicit.
const encodeWakeMode = (mode: WakeMode | undefined): number => mode === undefined ? 0 : mode === "explicit" ? 1 : 2

const decodeWakeMode = (value: number): WakeMode | undefined =>
  value === 1 ? "explicit" : value === 2 ? "automatic" : undefined

/** @internal */
export const loadExecution = (sql: SqlStorage): ExecutionRow | undefined => {
  const row = sql.exec<StoredExecutionRow>(
    `SELECT workflow_name, execution_id, payload, parent_name, parent_execution_id, result, resume_pending
     FROM workflow_execution WHERE id = 0`
  ).toArray()[0]
  if (row === undefined) return undefined
  return {
    workflowName: row.workflow_name,
    executionId: row.execution_id,
    payload: row.payload,
    parent: row.parent_name !== null && row.parent_execution_id !== null
      ? { workflowName: row.parent_name, executionId: row.parent_execution_id }
      : undefined,
    result: row.result ?? undefined,
    resumePending: decodeWakeMode(row.resume_pending)
  }
}

/** @internal */
export const createExecution = (
  sql: SqlStorage,
  workflowName: string,
  executionId: string,
  payload: string,
  parent: { readonly workflowName: string; readonly executionId: string } | undefined
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO workflow_execution
       (id, workflow_name, execution_id, payload, parent_name, parent_execution_id, result)
     VALUES (0, ?, ?, ?, ?, ?, NULL)`,
    workflowName,
    executionId,
    payload,
    parent?.workflowName ?? null,
    parent?.executionId ?? null
  )
}

/** @internal */
export const setParent = (
  sql: SqlStorage,
  parent: { readonly workflowName: string; readonly executionId: string }
): void => {
  sql.exec(
    "UPDATE workflow_execution SET parent_name = ?, parent_execution_id = ? WHERE id = 0 AND parent_name IS NULL",
    parent.workflowName,
    parent.executionId
  )
}

/** @internal */
export const saveSuspension = (sql: SqlStorage, result: string, pending: WakeMode | undefined): void => {
  sql.exec(
    "UPDATE workflow_execution SET result = ?, resume_pending = ? WHERE id = 0",
    result,
    encodeWakeMode(pending)
  )
}

/** @internal */
export const saveCompletion = (sql: SqlStorage, result: string, wakeParent: boolean): void => {
  sql.exec("UPDATE workflow_execution SET result = ?, resume_pending = ? WHERE id = 0", result, wakeParent ? 1 : 0)
}

/** @internal */
export const setResumePending = (sql: SqlStorage, pending: WakeMode | undefined): void => {
  sql.exec("UPDATE workflow_execution SET resume_pending = ? WHERE id = 0", encodeWakeMode(pending))
}

/** @internal */
export const loadActivity = (sql: SqlStorage, key: string): string | undefined => {
  const row = sql.exec<ExitRow>("SELECT exit FROM workflow_activities WHERE key = ?", key).toArray()[0]
  return row?.exit
}

/** @internal */
export const saveActivity = (sql: SqlStorage, key: string, exit: string): void => {
  sql.exec("INSERT OR IGNORE INTO workflow_activities (key, exit) VALUES (?, ?)", key, exit)
}

/** @internal */
export const loadDeferred = (sql: SqlStorage, name: string): string | undefined => {
  const row = sql.exec<ExitRow>("SELECT exit FROM workflow_deferreds WHERE name = ?", name).toArray()[0]
  return row?.exit
}

/**
 * First write wins; safe without a conflict clause because a Durable Object's
 * SQLite access is single-threaded.
 *
 * @internal
 */
export const saveDeferred = (sql: SqlStorage, name: string, exit: string): boolean => {
  if (loadDeferred(sql, name) !== undefined) return false
  sql.exec("INSERT INTO workflow_deferreds (name, exit) VALUES (?, ?)", name, exit)
  return true
}

/** @internal */
export const saveClock = (sql: SqlStorage, name: string, deferredName: string, wakeUp: number): void => {
  sql.exec(
    "INSERT OR IGNORE INTO workflow_clocks (name, deferred_name, wake_up, fired) VALUES (?, ?, ?, 0)",
    name,
    deferredName,
    wakeUp
  )
}

/** @internal */
export const earliestClockWakeUp = (sql: SqlStorage): number | undefined => {
  const row = sql.exec<ClockWakeUpRow>(
    "SELECT min(wake_up) AS wake_up FROM workflow_clocks WHERE fired = 0"
  ).toArray()[0]
  return row?.wake_up ?? undefined
}

/** @internal */
export const dueClocks = (
  sql: SqlStorage,
  now: number
): Array<{ readonly name: string; readonly deferredName: string }> =>
  sql.exec<ClockRow>(
    "SELECT name, deferred_name FROM workflow_clocks WHERE fired = 0 AND wake_up <= ?",
    now
  ).toArray().map((row) => ({
    name: row.name,
    deferredName: row.deferred_name
  }))

/** @internal */
export const markClockFired = (sql: SqlStorage, name: string): void => {
  sql.exec("UPDATE workflow_clocks SET fired = 1 WHERE name = ?", name)
}
