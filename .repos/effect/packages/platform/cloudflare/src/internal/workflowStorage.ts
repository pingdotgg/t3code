/**
 * Storage glue for the workflow Durable Object. The constructor must stay
 * cheap: open SQLite, ensure the tables, and re-arm the single alarm from the
 * earliest pending clock. No workflow handlers are built here.
 *
 * @internal
 */
import type { SqlStorage } from "@cloudflare/workers-types"

// `parent_name` and `parent_execution_id` are legacy: nothing writes them, and
// `ensureWorkflowStorage` moves any stored value into `workflow_parents`.
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
  )`,
  `CREATE INDEX IF NOT EXISTS workflow_clocks_pending_idx
    ON workflow_clocks (wake_up) WHERE fired = 0`,
  `CREATE TABLE IF NOT EXISTS workflow_parents (
    workflow_name TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    PRIMARY KEY (workflow_name, execution_id)
  )`
]

/** @internal */
export const isComplete = (result: string | undefined): boolean =>
  result !== undefined && (JSON.parse(result) as { readonly _tag?: unknown })._tag === "Complete"

/** @internal */
export const ensureWorkflowStorage = (sql: SqlStorage): void => {
  for (const statement of ddl) {
    sql.exec(statement)
  }
  const legacy = sql.exec<LegacyParentRow>(
    `SELECT parent_name, parent_execution_id, result, resume_pending
     FROM workflow_execution
     WHERE id = 0 AND parent_name IS NOT NULL AND parent_execution_id IS NOT NULL`
  ).toArray()[0]
  if (legacy === undefined) return
  // Once complete, `resume_pending` used to mean the parent wake was undelivered.
  const complete = isComplete(legacy.result ?? undefined)
  if (!complete || legacy.resume_pending !== 0) {
    addParent(sql, { workflowName: legacy.parent_name, executionId: legacy.parent_execution_id })
  }
  sql.exec("UPDATE workflow_execution SET parent_name = NULL, parent_execution_id = NULL WHERE id = 0")
  if (complete) setResumePending(sql, undefined)
}

/**
 * How a replay was requested. An explicit wake (`resume`, `interrupt`) always
 * replays; an automatic wake (deferred or clock completion, a child's
 * completion) leaves a failure-suspended execution parked.
 *
 * @internal
 */
export type WakeMode = "explicit" | "automatic"

/** @internal */
export interface ParentRef {
  readonly workflowName: string
  readonly executionId: string
}

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
  readonly result: string | undefined
  /**
   * The pending replay of an incomplete execution.
   */
  readonly resumePending: WakeMode | undefined
}

type StoredExecutionRow = {
  readonly workflow_name: string
  readonly execution_id: string
  readonly payload: string
  readonly result: string | null
  readonly resume_pending: number
}

type LegacyParentRow = {
  readonly parent_name: string
  readonly parent_execution_id: string
  readonly result: string | null
  readonly resume_pending: number
}

type ParentRow = {
  readonly workflow_name: string
  readonly execution_id: string
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
    `SELECT workflow_name, execution_id, payload, result, resume_pending
     FROM workflow_execution WHERE id = 0`
  ).toArray()[0]
  if (row === undefined) return undefined
  return {
    workflowName: row.workflow_name,
    executionId: row.execution_id,
    payload: row.payload,
    result: row.result ?? undefined,
    resumePending: decodeWakeMode(row.resume_pending)
  }
}

/** @internal */
export const createExecution = (
  sql: SqlStorage,
  workflowName: string,
  executionId: string,
  payload: string
): void => {
  sql.exec(
    `INSERT OR IGNORE INTO workflow_execution
       (id, workflow_name, execution_id, payload, result)
     VALUES (0, ?, ?, ?, NULL)`,
    workflowName,
    executionId,
    payload
  )
}

/** @internal */
export const addParent = (sql: SqlStorage, parent: ParentRef): void => {
  sql.exec(
    "INSERT OR IGNORE INTO workflow_parents (workflow_name, execution_id) VALUES (?, ?)",
    parent.workflowName,
    parent.executionId
  )
}

/** @internal */
export const loadParents = (sql: SqlStorage): Array<ParentRef> =>
  sql.exec<ParentRow>(
    "SELECT workflow_name, execution_id FROM workflow_parents"
  ).toArray().map((row) => ({
    workflowName: row.workflow_name,
    executionId: row.execution_id
  }))

/** @internal */
export const hasParents = (sql: SqlStorage): boolean =>
  sql.exec("SELECT 1 FROM workflow_parents LIMIT 1").toArray().length > 0

/** @internal */
export const deleteParent = (sql: SqlStorage, parent: ParentRef): void => {
  sql.exec(
    "DELETE FROM workflow_parents WHERE workflow_name = ? AND execution_id = ?",
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
export const saveCompletion = (sql: SqlStorage, result: string): void => {
  sql.exec("UPDATE workflow_execution SET result = ?, resume_pending = 0 WHERE id = 0", result)
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

/**
 * Returns whether the clock was newly saved.
 *
 * @internal
 */
export const saveClock = (sql: SqlStorage, name: string, deferredName: string, wakeUp: number): boolean =>
  sql.exec(
    "INSERT OR IGNORE INTO workflow_clocks (name, deferred_name, wake_up, fired) VALUES (?, ?, ?, 0) RETURNING 1",
    name,
    deferredName,
    wakeUp
  ).toArray().length > 0

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
