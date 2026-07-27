import * as Effect from "effect/Effect"
import { constVoid } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as McpServer from "effect/unstable/ai/McpServer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"

export const MCP_ENDPOINT = "http://localhost/mcp"

const noopLogger = Logger.make(constVoid)

export const makeServerLayer = (options: {
  readonly name: string
  readonly version?: string | undefined
  readonly extensions?: Record<`${string}/${string}`, unknown> | undefined
}) =>
  McpServer.layerHttp({
    name: options.name,
    version: options.version ?? "1.0.0",
    path: "/mcp",
    extensions: options.extensions
  }).pipe(
    Layer.provideMerge(Layer.succeed(
      References.CurrentLoggers,
      new Set([noopLogger])
    ))
  )

export const makeWebHandler = Effect.fnUntraced(function*<A>(
  serverLayer: Layer.Layer<A, never, HttpRouter.HttpRouter>,
  options?: {
    readonly routerLayer?: Layer.Layer<never, never, HttpRouter.HttpRouter> | undefined
  }
) {
  const appLayer = options?.routerLayer ? Layer.merge(serverLayer, options.routerLayer) : serverLayer
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
  return handler
})

export const makeRawHttpHarness = Effect.fnUntraced(function*<A>(
  serverLayer: Layer.Layer<A, never, HttpRouter.HttpRouter>
) {
  const handler = yield* makeWebHandler(serverLayer)
  const post = (body: unknown, headers?: HeadersInit) =>
    Effect.promise(() =>
      handler(
        new Request(MCP_ENDPOINT, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...headers
          },
          body: JSON.stringify(body)
        })
      )
    )
  return { post } as const
})
