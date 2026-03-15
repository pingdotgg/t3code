import { NodeHttpServer } from "@effect/platform-node"
import * as SqliteNode from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as FileSystem from "node:fs"
import * as OS from "node:os"
import * as NodePath from "node:path"
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpServer,
  HttpRouter
} from "effect/unstable/http"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { ServerConfig } from "../src/config.ts"
import { MigrationsLive } from "../src/migrations.ts"
import { ServerMessage } from "../src/messages.ts"
import { withWsRpcClient } from "../src/client.ts"
import { makeRoutesLayer } from "../src/server.ts"

const testServerConfig = {
  host: "127.0.0.1",
  port: 0,
  assetsDir: new URL("../../public", import.meta.url).pathname,
  dbFilename: ":memory:",
  requestLogging: false,
  frontendDevOrigin: undefined
}

const AppUnderTest = HttpRouter.serve(
  makeRoutesLayer,
  {
    disableListenLog: true,
    disableLogger: true
  }
)

const persistenceLayer = (dbFilename: string) => {
  const sqliteLayer = SqliteNode.SqliteClient.layer({ filename: dbFilename })
  return MigrationsLive.pipe(Layer.provideMerge(sqliteLayer))
}

const appLayer = (dbFilename: string) =>
  AppUnderTest.pipe(Layer.provideMerge(persistenceLayer(dbFilename)))

const insertTodo = (dbFilename: string, id: string, title: string) =>
  Effect.scoped(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) => {
      const now = new Date().toISOString()
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
      Effect.provide(persistenceLayer(dbFilename))
    )
  )

describe("server", () => {
  it.effect("routes HTTP messages validated by Schema", () =>
    Effect.gen(function*() {
      yield* Layer.build(appLayer(testServerConfig.dbFilename)).pipe(
        Effect.provideService(ServerConfig, testServerConfig)
      )
      const client = yield* HttpClient.HttpClient
      const response = yield* client.post("/api/dispatch", {
        body: HttpBody.jsonUnsafe({ kind: "sum", left: 20, right: 22 })
      })

      const parsed = yield* HttpClientResponse.schemaBodyJson(ServerMessage)(response)
      expect(parsed).toEqual({ kind: "sumResult", total: 42 })
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )

  it.effect("serves static files from local filesystem", () =>
    Effect.gen(function*() {
      yield* Layer.build(appLayer(testServerConfig.dbFilename)).pipe(
        Effect.provideService(ServerConfig, testServerConfig)
      )
      const text = yield* HttpClient.get("/").pipe(
        Effect.flatMap((response) => response.text)
      )

      expect(text).toContain("effect-http-ws-cli")
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )

  it.effect("redirects frontend requests to the Vite dev server when enabled", () =>
    Effect.gen(function*() {
      yield* Layer.build(appLayer(testServerConfig.dbFilename)).pipe(
        Effect.provideService(ServerConfig, {
          ...testServerConfig,
          frontendDevOrigin: "http://127.0.0.1:5173"
        })
      )

      const server = yield* HttpServer.HttpServer
      const address = server.address as HttpServer.TcpAddress
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${address.port}/todos?filter=active`, {
          redirect: "manual"
        })
      )

      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe("http://127.0.0.1:5173/todos?filter=active")
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )

  it.effect("routes WebSocket RPC messages with shared contracts", () =>
    Effect.gen(function*() {
      yield* Layer.build(appLayer(testServerConfig.dbFilename)).pipe(
        Effect.provideService(ServerConfig, testServerConfig)
      )
      const server = yield* HttpServer.HttpServer
      const address = server.address as HttpServer.TcpAddress
      const wsUrl = `ws://127.0.0.1:${address.port}/ws`

      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client.echo({ text: "hello from ws" }))
      )

      expect(response).toEqual({ text: "hello from ws" })
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )

  it.effect("routes WebSocket RPC calls for multiple procedures", () =>
    Effect.gen(function*() {
      yield* Layer.build(appLayer(testServerConfig.dbFilename)).pipe(
        Effect.provideService(ServerConfig, testServerConfig)
      )
      const server = yield* HttpServer.HttpServer
      const address = server.address as HttpServer.TcpAddress
      const wsUrl = `ws://127.0.0.1:${address.port}/ws`

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all({
            sum: client.sum({ left: 1, right: 2 }),
            time: client.time(undefined)
          })
        )
      )

      expect(result.sum).toEqual({ total: 3 })
      expect(typeof result.time.iso).toBe("string")
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )

  it.effect("lists todos and streams todo updates from offset", () =>
    Effect.gen(function*() {
      const dbFilename = NodePath.join(
        OS.tmpdir(),
        `effect-http-ws-cli-stream-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
      )

      yield* insertTodo(dbFilename, "todo-stream-test", "stream-seed")

      const events = yield* Effect.scoped(
        Effect.gen(function*() {
          yield* Layer.build(appLayer(dbFilename)).pipe(
            Effect.provideService(ServerConfig, {
              ...testServerConfig,
              dbFilename
            })
          )
          const server = yield* HttpServer.HttpServer
          const address = server.address as HttpServer.TcpAddress
          const wsUrl = `ws://127.0.0.1:${address.port}/ws`

          return yield* withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function*() {
              const snapshot = yield* client.listTodos({ includeArchived: true })
              const firstTodo = snapshot.todos[0]
              if (!firstTodo) {
                return yield* Effect.die("Expected a todo fixture")
              }

              yield* client.renameTodo({ id: firstTodo.id, title: "alpha" })
              yield* client.completeTodo({ id: firstTodo.id, completed: true })
              yield* client.archiveTodo({ id: firstTodo.id, archived: true })

              return yield* client.subscribeTodos({
                fromOffset: snapshot.offset,
                includeArchived: true
              }).pipe(
                Stream.take(3),
                Stream.runCollect
              )
            })
          )
        })
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            try {
              FileSystem.rmSync(dbFilename, { force: true })
            } catch {
              // ignore cleanup failures in tests
            }
          })
        )
      )

      expect(events).toHaveLength(3)
      expect(events[0]?.change).toEqual({ _tag: "TodoRenamed", title: "alpha" })
      expect(events[1]?.change).toEqual({ _tag: "TodoCompleted", completed: true })
      expect(events[2]?.change).toEqual({ _tag: "TodoArchived", archived: true })
      expect(events[0]?.todo.title).toBe("alpha")
      expect(events[1]?.todo.completed).toBe(true)
      expect(events[2]?.todo.archived).toBe(true)
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )

  it.effect("persists todos across server restarts when using a file database", () =>
    Effect.gen(function*() {
      const dbFilename = NodePath.join(
        OS.tmpdir(),
        `effect-http-ws-cli-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
      )

      yield* insertTodo(dbFilename, "todo-persist-test", "persist-seed")

      const withServer = <A, E, R>(f: (wsUrl: string) => Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.gen(function*() {
            yield* Layer.build(appLayer(dbFilename)).pipe(
              Effect.provideService(ServerConfig, {
                ...testServerConfig,
                dbFilename
              })
            )

            const server = yield* HttpServer.HttpServer
            const address = server.address as HttpServer.TcpAddress
            const wsUrl = `ws://127.0.0.1:${address.port}/ws`
            return yield* f(wsUrl)
          })
        )

      const renamedTodoId = yield* withServer((wsUrl) =>
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function*() {
              const snapshot = yield* client.listTodos({ includeArchived: true })
              const firstTodo = snapshot.todos[0]
              if (!firstTodo) {
                return yield* Effect.die("Expected a todo fixture")
              }

              yield* client.renameTodo({ id: firstTodo.id, title: "persisted-title" })
              return firstTodo.id
            })
          )
        )
      )

      const persistedTitle = yield* withServer((wsUrl) =>
        Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function*() {
              const snapshot = yield* client.listTodos({ includeArchived: true })
              const persisted = snapshot.todos.find((todo) => todo.id === renamedTodoId)
              if (!persisted) {
                return yield* Effect.die("Expected persisted todo")
              }
              return persisted.title
            })
          )
        )
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            try {
              FileSystem.rmSync(dbFilename, { force: true })
            } catch {
              // ignore cleanup failures in tests
            }
          })
        )
      )

      expect(persistedTitle).toBe("persisted-title")
    }).pipe(Effect.provide(NodeHttpServer.layerTest))
  )
})
