import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"
import * as ServiceMap from "effect/ServiceMap"
import * as Stream from "effect/Stream"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlSchema from "effect/unstable/sql/SqlSchema"
import type { Todo, TodoChange, TodoEvent, TodoSnapshot } from "./contracts.ts"
import { Todo as TodoSchema, TodoChange as TodoChangeSchema } from "./contracts.ts"
import { MigrationsReady } from "./migrations.ts"

export interface TodoStoreApi {
  readonly list: (input: {
    readonly includeArchived: boolean
  }) => Effect.Effect<TodoSnapshot, never, SqlClient.SqlClient>
  readonly rename: (input: {
    readonly id: string
    readonly title: string
  }) => Effect.Effect<TodoEvent, never, SqlClient.SqlClient>
  readonly complete: (input: {
    readonly id: string
    readonly completed: boolean
  }) => Effect.Effect<TodoEvent, never, SqlClient.SqlClient>
  readonly archive: (input: {
    readonly id: string
    readonly archived: boolean
  }) => Effect.Effect<TodoEvent, never, SqlClient.SqlClient>
  readonly subscribe: (input: {
    readonly fromOffset: number
    readonly includeArchived: boolean
  }) => Stream.Stream<TodoEvent, never, SqlClient.SqlClient>
}

export class TodoStore extends ServiceMap.Service<TodoStore, TodoStoreApi>()(
  "effect-http-ws-cli/TodoStore"
) {}

const TodoRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  completed: Schema.BooleanFromBit,
  archived: Schema.BooleanFromBit,
  revision: Schema.Number,
  updatedAt: Schema.String
})

const TodoEventRow = Schema.Struct({
  offset: Schema.Number,
  at: Schema.String,
  todo: Schema.fromJsonString(TodoSchema),
  change: Schema.fromJsonString(TodoChangeSchema)
})

const EventInsertRequest = Schema.Struct({
  at: Schema.String,
  todo: Schema.fromJsonString(TodoSchema),
  change: Schema.fromJsonString(TodoChangeSchema),
  archived: Schema.BooleanFromBit
})

const ListRequest = Schema.Struct({
  includeArchived: Schema.Boolean
})

const CatchupRequest = Schema.Struct({
  fromOffset: Schema.Number,
  includeArchived: Schema.Boolean
})

const OffsetRow = Schema.Struct({
  offset: Schema.Number
})

const makeQueries = (sql: SqlClient.SqlClient) => {
  const listTodoRows = SqlSchema.findAll({
    Request: ListRequest,
    Result: TodoRow,
    execute: (request) =>
      request.includeArchived
        ? sql<Todo>`
          SELECT id, title, completed, archived, revision, updated_at AS updatedAt
          FROM todos
          ORDER BY id
        `
        : sql<Todo>`
          SELECT id, title, completed, archived, revision, updated_at AS updatedAt
          FROM todos
          WHERE archived = 0
          ORDER BY id
        `
  })

  const findTodoById = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: TodoRow,
    execute: (id) => sql<Todo>`
      SELECT id, title, completed, archived, revision, updated_at AS updatedAt
      FROM todos
      WHERE id = ${id}
    `
  })

  const upsertTodo = SqlSchema.void({
    Request: TodoRow,
    execute: (todo) => sql`
      INSERT INTO todos (id, title, completed, archived, revision, updated_at)
      VALUES (${todo.id}, ${todo.title}, ${todo.completed}, ${todo.archived}, ${todo.revision}, ${todo.updatedAt})
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        completed = excluded.completed,
        archived = excluded.archived,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `
  })

  const loadEventsSince = SqlSchema.findAll({
    Request: CatchupRequest,
    Result: TodoEventRow,
    execute: (request) =>
      request.includeArchived
        ? sql<TodoEvent>`
          SELECT event_offset AS "offset", at, todo_json AS todo, change_json AS change
          FROM todo_events
          WHERE event_offset > ${request.fromOffset}
          ORDER BY event_offset
        `
        : sql<TodoEvent>`
          SELECT event_offset AS "offset", at, todo_json AS todo, change_json AS change
          FROM todo_events
          WHERE event_offset > ${request.fromOffset} AND archived = 0
          ORDER BY event_offset
        `
  })

  const insertTodoEvent = SqlSchema.findOne({
    Request: EventInsertRequest,
    Result: TodoEventRow,
    execute: (request) => sql<TodoEvent>`
      INSERT INTO todo_events (at, todo_json, change_json, archived)
      VALUES (${request.at}, ${request.todo}, ${request.change}, ${request.archived})
      RETURNING event_offset AS "offset", at, todo_json AS todo, change_json AS change
    `
  })

  const currentOffset = SqlSchema.findOne({
    Request: Schema.Undefined,
    Result: OffsetRow,
    execute: () => sql<{ readonly offset: number }>`
      SELECT COALESCE(MAX(event_offset), 0) AS "offset"
      FROM todo_events
    `
  })

  return {
    listTodoRows,
    findTodoById,
    upsertTodo,
    loadEventsSince,
    insertTodoEvent,
    currentOffset
  } as const
}

export const layerTodoStore = Layer.effect(
  TodoStore,
  Effect.gen(function*() {
    yield* MigrationsReady
    const eventsPubSub = yield* PubSub.unbounded<TodoEvent>()

    const append = (
      todoId: string,
      change: TodoChange,
      update: (todo: Todo) => Todo
    ): Effect.Effect<TodoEvent, never, SqlClient.SqlClient> =>
      Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => {
        const queries = makeQueries(sql)
        return sql.withTransaction(
          queries.findTodoById(todoId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die(`Todo not found: ${todoId}`),
                onSome: (todo) => {
                  const updated = update(todo)
                  return queries.upsertTodo(updated).pipe(
                    Effect.flatMap(() =>
                      queries.insertTodoEvent({
                        at: updated.updatedAt,
                        todo: updated,
                        change,
                        archived: updated.archived
                      })
                    )
                  )
                }
              })
            )
          )
        )
      }).pipe(Effect.tap((event) => PubSub.publish(eventsPubSub, event)), Effect.orDie)

    const visible = (todo: Todo, includeArchived: boolean) => includeArchived || !todo.archived

    const subscribe = (input: {
      readonly fromOffset: number
      readonly includeArchived: boolean
    }): Stream.Stream<TodoEvent, never, SqlClient.SqlClient> => {
      const catchup = Stream.fromIterableEffect(
        Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => makeQueries(sql).loadEventsSince(input))
      ).pipe(Stream.orDie)

      const live = Stream.fromPubSub(eventsPubSub).pipe(
        Stream.filter((event) => visible(event.todo, input.includeArchived))
      )

      return Stream.concat(catchup, live)
    }

    return TodoStore.of({
      list: ({ includeArchived }) =>
        Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => {
          const queries = makeQueries(sql)
          return Effect.all({
            todos: queries.listTodoRows({ includeArchived }),
            offset: queries.currentOffset(undefined).pipe(Effect.map(({ offset }) => offset))
          }).pipe(
            Effect.map(({ offset, todos }) => ({ offset, todos }))
          )
        }).pipe(Effect.orDie),
      rename: ({ id, title }) =>
        append(
          id,
          { _tag: "TodoRenamed", title },
          (todo) => ({
            ...todo,
            title,
            revision: todo.revision + 1,
            updatedAt: new Date().toISOString()
          })
        ),
      complete: ({ id, completed }) =>
        append(
          id,
          { _tag: "TodoCompleted", completed },
          (todo) => ({
            ...todo,
            completed,
            revision: todo.revision + 1,
            updatedAt: new Date().toISOString()
          })
        ),
      archive: ({ id, archived }) =>
        append(
          id,
          { _tag: "TodoArchived", archived },
          (todo) => ({
            ...todo,
            archived,
            revision: todo.revision + 1,
            updatedAt: new Date().toISOString()
          })
        ),
      subscribe
    })
  })
)
