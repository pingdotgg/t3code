import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteNode from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as FileSystem from "node:fs"
import * as OS from "node:os"
import * as NodePath from "node:path"
import { resetDatabase } from "../src/cli.ts"
import { MigrationsLive } from "../src/migrations.ts"

const countRows = (dbFilename: string, tableName: string) =>
  Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(tableName)}`.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0)
    )
  ).pipe(
    Effect.provide(SqliteNode.SqliteClient.layer({ filename: dbFilename }))
  )

const insertTodo = (dbFilename: string) =>
  Effect.scoped(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => {
      const now = new Date().toISOString()
      const id = "todo-reset-test"
      const title = "before-reset"
      return sql.withTransaction(
        sql`
          INSERT INTO todos (id, title, completed, archived, revision, updated_at)
          VALUES (${id}, ${title}, 0, 0, 1, ${now})
        `.pipe(
          Effect.flatMap(() =>
            sql`
              INSERT INTO todo_events (at, todo_json, change_json, archived)
              VALUES (
                ${now},
                ${JSON.stringify({
                  id,
                  title,
                  completed: false,
                  archived: false,
                  revision: 1,
                  updatedAt: now
                })},
                ${JSON.stringify({ _tag: "TodoCreated" })},
                0
              )
            `
          )
        )
      )
    }).pipe(
      Effect.provide(MigrationsLive.pipe(Layer.provideMerge(SqliteNode.SqliteClient.layer({ filename: dbFilename }))))
    )
  )

describe("reset command", () => {
  it.effect("deletes the database and reruns migrations without reseeding todos", () =>
    Effect.gen(function*() {
      const dbFilename = NodePath.join(
        OS.tmpdir(),
        `effect-http-ws-cli-reset-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
      )

      yield* insertTodo(dbFilename)

      const beforeCount = yield* countRows(dbFilename, "todos")
      expect(beforeCount).toBe(1)

      yield* resetDatabase(dbFilename).pipe(
        Effect.provide(NodeServices.layer)
      )

      const todoCount = yield* countRows(dbFilename, "todos")
      const migrationCount = yield* countRows(dbFilename, "effect_sql_migrations")

      expect(todoCount).toBe(0)
      expect(migrationCount).toBe(1)

      yield* Effect.sync(() => {
        try {
          FileSystem.rmSync(dbFilename, { force: true })
        } catch {
          // ignore cleanup failures in tests
        }
      })
    })
  )
})
