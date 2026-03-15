import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export default Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS todo_events (
      event_offset INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      todo_json TEXT NOT NULL,
      change_json TEXT NOT NULL,
      archived INTEGER NOT NULL
    )
  `

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_todo_events_archived_offset
    ON todo_events (archived, event_offset)
  `
})
