import { NodeHttpServer } from "@effect/platform-node"
import * as SqliteNode from "@effect/sql-sqlite-node"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Http from "node:http"
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Stream from "effect/Stream"
import {
  ClientMessage,
  routeClientMessage,
  ServerMessage
} from "./messages.ts"
import { ServerConfig } from "./config.ts"
import { WsRpcGroup } from "./contracts.ts"
import { TodoStore, layerTodoStore } from "./model-store.ts"
import { MigrationsLive } from "./migrations.ts"

const respondMessage = HttpServerResponse.schemaJson(ServerMessage)

const messageDispatchRoute = HttpRouter.add(
  "POST",
  "/api/dispatch",
  HttpServerRequest.schemaBodyJson(ClientMessage).pipe(
    Effect.flatMap((message) => respondMessage(routeClientMessage(message))),
    Effect.catchTag(
      "SchemaError",
      () => Effect.succeed(HttpServerResponse.jsonUnsafe({ kind: "error", error: "Invalid message schema" }, { status: 400 }))
    ),
    Effect.catchTag(
      "HttpServerError",
      () => Effect.succeed(HttpServerResponse.jsonUnsafe({ kind: "error", error: "Invalid request body" }, { status: 400 }))
    )
  )
)

const websocketRpcRoute = RpcServer.layerHttp({
    group: WsRpcGroup,
    path: "/ws",
    protocol: "websocket"
  }).pipe(
    Layer.provide(WsRpcGroup.toLayer({
      echo: ({ text }) => Effect.succeed({ text }),
      sum: ({ left, right }) => Effect.succeed({ total: left + right }),
      time: () => Effect.sync(() => ({ iso: new Date().toISOString() })),
      listTodos: ({ includeArchived }) =>
        Effect.flatMap(Effect.service(TodoStore), (store) => store.list({ includeArchived })),
      renameTodo: ({ id, title }) =>
        Effect.flatMap(Effect.service(TodoStore), (store) => store.rename({ id, title })),
      completeTodo: ({ id, completed }) =>
        Effect.flatMap(Effect.service(TodoStore), (store) => store.complete({ id, completed })),
      archiveTodo: ({ id, archived }) =>
        Effect.flatMap(Effect.service(TodoStore), (store) => store.archive({ id, archived })),
      subscribeTodos: ({ fromOffset, includeArchived }) =>
        Stream.unwrap(
          Effect.map(
            Effect.service(TodoStore),
            (store) => store.subscribe({ fromOffset, includeArchived })
          )
        )
    })),
    Layer.provide(layerTodoStore),
    Layer.provide(RpcSerialization.layerJson)
  )

const staticRoute = HttpRouter.add(
  "GET",
  "*",
  (request) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const config = yield* ServerConfig
      const url = HttpServerRequest.toURL(request)
      if (!url) {
        return HttpServerResponse.text("Bad Request", { status: 400 })
      }

      if (config.frontendDevOrigin) {
        return HttpServerResponse.redirect(
          new URL(`${url.pathname}${url.search}`, config.frontendDevOrigin),
          {
            status: 307,
            headers: { "cache-control": "no-store" }
          }
        )
      }

      const root = path.resolve(config.assetsDir)
      const decodedPath = decodeURIComponent(url.pathname)
      const target = decodedPath === "/"
        ? "index.html"
        : decodedPath.endsWith("/")
        ? `${decodedPath.slice(1)}index.html`
        : decodedPath.slice(1)

      const normalizedTarget = path.normalize(target)
      const absoluteTarget = path.resolve(root, normalizedTarget)
      const relativeToRoot = path.relative(root, absoluteTarget)

      if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
        return HttpServerResponse.text("Forbidden", { status: 403 })
      }

      const exists = yield* fs.exists(absoluteTarget)
      if (!exists) {
        return HttpServerResponse.text("Not Found", { status: 404 })
      }

      return yield* HttpServerResponse.file(absoluteTarget)
    }).pipe(Effect.catchCause(() => Effect.succeed(HttpServerResponse.text("Bad Request", { status: 400 }))))
)

export const makeRoutesLayer =
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/health",
      HttpServerResponse.json({ ok: true })
    ),
    messageDispatchRoute,
    websocketRpcRoute,
    staticRoute
  )

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* ServerConfig
    const sqliteLayer = SqliteNode.SqliteClient.layer({
      filename: config.dbFilename
    })
    const persistenceLayer = MigrationsLive.pipe(
      Layer.provideMerge(sqliteLayer)
    )

    return HttpRouter.serve(makeRoutesLayer, {
      disableLogger: !config.requestLogging
    }).pipe(
      Layer.provideMerge(persistenceLayer),
      Layer.provide(NodeHttpServer.layer(Http.createServer, {
        host: config.host,
        port: config.port
      }))
    )
  })
)

export const runServer = Layer.launch(makeServerLayer)
