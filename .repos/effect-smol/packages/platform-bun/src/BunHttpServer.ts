/**
 * Bun implementation of the Effect `HttpServer`.
 *
 * This module builds an Effect HTTP server from `Bun.serve`, translating Bun's
 * Web `Request` objects into `HttpServerRequest` values and Effect
 * `HttpServerResponse` values back into Web `Response` objects. It is the Bun
 * runtime entry point for serving `HttpApp`s, streaming responses, file
 * responses through `BunHttpPlatform`, multipart requests, and websocket
 * endpoints through `HttpServerRequest.upgrade`.
 *
 * Common use cases include using {@link layer} or {@link layerConfig} to serve
 * an application from Bun configuration, {@link layerServer} when only the
 * `HttpServer` service is needed, and {@link layerTest} for tests that need an
 * ephemeral Bun listener and fetch-compatible client.
 *
 * Bun supplies absolute request URLs and Web-standard request bodies. This
 * adapter stores the normalized path-and-query URL on `HttpServerRequest.url`,
 * while the underlying `Request` still follows Web body rules: pick the
 * streamed, text, JSON, URL-encoded, or multipart view that matches the route
 * instead of consuming the same body in incompatible ways. Because `Bun.serve`
 * has a single active `fetch` handler, each `serve` call reloads that handler
 * and restores the previous one when the serve scope finalizes.
 *
 * WebSocket upgrades must happen from the Bun request handler. The
 * `HttpServerRequest.upgrade` effect calls `server.upgrade`, fails when Bun says
 * the request is not upgradeable, buffers messages that arrive before the
 * Effect socket handler is installed, and maps non-normal close codes into
 * `Socket` errors. The server is stopped with `server.stop()` when its
 * acquisition scope closes; unless preemptive shutdown is disabled, finalizing
 * a serve scope also starts that stop with the configured graceful shutdown
 * timeout or the default timeout.
 *
 * @since 4.0.0
 */
import type { Server as BunServer, ServerWebSocket } from "bun"
import * as Config from "effect/Config"
import type { ConfigError } from "effect/Config"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FiberSet from "effect/FiberSet"
import type * as FileSystem from "effect/FileSystem"
import { flow } from "effect/Function"
import * as Inspectable from "effect/Inspectable"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import type * as Record from "effect/Record"
import type * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Cookies from "effect/unstable/http/Cookies"
import * as Etag from "effect/unstable/http/Etag"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as IncomingMessage from "effect/unstable/http/HttpIncomingMessage"
import type { HttpMethod } from "effect/unstable/http/HttpMethod"
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform"
import * as Server from "effect/unstable/http/HttpServer"
import * as Error from "effect/unstable/http/HttpServerError"
import * as ServerRequest from "effect/unstable/http/HttpServerRequest"
import type * as ServerResponse from "effect/unstable/http/HttpServerResponse"
import type * as Multipart from "effect/unstable/http/Multipart"
import * as UrlParams from "effect/unstable/http/UrlParams"
import * as Socket from "effect/unstable/socket/Socket"
import * as Platform from "./BunHttpPlatform.ts"
import * as BunMultipart from "./BunMultipart.ts"
import * as BunServices from "./BunServices.ts"
import * as BunStream from "./BunStream.ts"

/**
 * Bun serve options accepted by the HTTP server, extended with typed route definitions.
 *
 * @category Options
 * @since 4.0.0
 */
export type ServeOptions<R extends string> =
  & (
    | Bun.Serve.UnixServeOptions<WebSocketContext>
    | Bun.Serve.HostnamePortServeOptions<WebSocketContext>
  )
  & { readonly routes?: Bun.Serve.Routes<WebSocketContext, R> }

/**
 * Creates a scoped Bun `HttpServer` from `Bun.serve` options, stopping the server on scope finalization with optional graceful shutdown settings.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(
  function*<R extends string>(
    options: ServeOptions<R> & {
      readonly disablePreemptiveShutdown?: boolean | undefined
      readonly gracefulShutdownTimeout?: Duration.Input | undefined
    }
  ) {
    const scope = yield* Effect.scope
    const handlerStack: Array<(request: Request, server: BunServer<WebSocketContext>) => Response | Promise<Response>> =
      [
        function(_request, _server) {
          return new Response("not found", { status: 404 })
        }
      ]
    const server = Bun.serve<WebSocketContext, R>({
      ...options as ServeOptions<R>,
      fetch: handlerStack[0],
      websocket: {
        open(ws) {
          Deferred.doneUnsafe(ws.data.deferred, Exit.succeed(ws))
        },
        message(ws, message) {
          ws.data.run(message)
        },
        close(ws, code, closeReason) {
          code = typeof code === "number" ? code : 1001
          Deferred.doneUnsafe(
            ws.data.closeDeferred,
            Socket.defaultCloseCodeIsError(code)
              ? Exit.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketCloseError({ code, closeReason })
                })
              )
              : Exit.void
          )
        }
      }
    })

    const shutdown = yield* Effect.promise(() => server.stop()).pipe(
      Effect.cached
    )
    const preemptiveShutdown = options.disablePreemptiveShutdown ? Effect.void : Effect.timeoutOrElse(shutdown, {
      duration: options.gracefulShutdownTimeout ?? Duration.seconds(20),
      orElse: () => Effect.void
    })

    yield* Scope.addFinalizer(scope, shutdown)

    return Server.make({
      address: { _tag: "TcpAddress", port: server.port!, hostname: server.hostname! },
      serve: Effect.fnUntraced(function*(httpApp, middleware) {
        const parent = yield* Effect.fiber
        const services = parent.context
        const serveScope = Context.getUnsafe(services, Scope.Scope)
        const scope = Scope.forkUnsafe(serveScope, "parallel")

        const httpEffect = HttpEffect.toHandled(httpApp, (request, response) =>
          Effect.sync(() => {
            ;(request as BunServerRequest).resolve(makeResponse(request, response, services, scope))
          }), middleware)

        function handler(request: Request, server: BunServer<WebSocketContext>) {
          return new Promise<Response>((resolve, _reject) => {
            const map = new Map(services.mapUnsafe)
            map.set(
              ServerRequest.HttpServerRequest.key,
              new BunServerRequest(request, resolve, removeHost(request.url), server)
            )
            const fiber = Fiber.runIn(Effect.runForkWith(Context.makeUnsafe<any>(map))(httpEffect), scope)
            request.signal.addEventListener("abort", () => {
              fiber.interruptUnsafe(parent.id, Error.ClientAbort.annotation)
            }, { once: true })
          })
        }

        yield* Scope.addFinalizerExit(serveScope, () => {
          handlerStack.pop()
          server.reload({ fetch: handlerStack[handlerStack.length - 1] })
          return preemptiveShutdown
        })
        handlerStack.push(handler)
        server.reload({ fetch: handler })
      })
    })
  }
)

const makeResponse = (
  request: ServerRequest.HttpServerRequest,
  response: ServerResponse.HttpServerResponse,
  context: Context.Context<never>,
  scope: Scope.Scope
): Response => {
  const fields: {
    headers: globalThis.Headers
    status?: number
    statusText?: string
  } = {
    headers: new globalThis.Headers(response.headers),
    status: response.status
  }

  if (!Cookies.isEmpty(response.cookies)) {
    for (const header of Cookies.toSetCookieHeaders(response.cookies)) {
      fields.headers.append("set-cookie", header)
    }
  }

  if (response.statusText !== undefined) {
    fields.statusText = response.statusText
  }

  if (request.method === "HEAD") {
    return new Response(undefined, fields)
  }
  response = HttpEffect.scopeTransferToStream(response)
  const body = response.body
  switch (body._tag) {
    case "Empty": {
      return new Response(undefined, fields)
    }
    case "Uint8Array":
    case "Raw": {
      if (body.body instanceof Response) {
        for (const [key, value] of fields.headers.entries()) {
          body.body.headers.set(key, value)
        }
        return body.body
      }
      return new Response(body.body as any, fields)
    }
    case "FormData": {
      return new Response(body.formData as any, fields)
    }
    case "Stream": {
      return new Response(
        Stream.toReadableStreamWith(
          Stream.unwrap(Effect.withFiber((fiber) => {
            Fiber.runIn(fiber, scope)
            return Effect.succeed(body.stream)
          })),
          context
        ),
        fields
      )
    }
  }
}

/**
 * Layer that provides only `HttpServer` by constructing a scoped Bun server from the supplied serve options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerServer: <R extends string>(
  options: ServeOptions<R> & {
    readonly disablePreemptiveShutdown?: boolean | undefined
    readonly gracefulShutdownTimeout?: Duration.Input | undefined
  }
) => Layer.Layer<Server.HttpServer> = flow(make, Layer.effect(Server.HttpServer)) as any

/**
 * Layer that provides Bun HTTP support services: `HttpPlatform`, weak ETag generation, and `BunServices`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerHttpServices: Layer.Layer<
  | HttpPlatform
  | Etag.Generator
  | BunServices.BunServices
> = Layer.mergeAll(
  Platform.layer,
  Etag.layerWeak,
  BunServices.layer
)

/**
 * Layer that provides a Bun `HttpServer` together with the Bun HTTP platform, ETag generator, and Bun services.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = <R extends string>(
  options: ServeOptions<R> & {
    readonly disablePreemptiveShutdown?: boolean | undefined
    readonly gracefulShutdownTimeout?: Duration.Input | undefined
  }
): Layer.Layer<
  | Server.HttpServer
  | HttpPlatform
  | Etag.Generator
  | BunServices.BunServices
> => Layer.mergeAll(layerServer(options), layerHttpServices)

/**
 * Layer that starts a Bun HTTP server on an ephemeral port for tests.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTest: Layer.Layer<
  Server.HttpServer | HttpPlatform | FileSystem.FileSystem | Etag.Generator | Path.Path | HttpClient
> = Server.layerTestClient.pipe(
  Layer.provide(FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false }))
  )),
  Layer.provideMerge(layer({ port: 0 }))
)

/**
 * Creates the Bun HTTP server and support-services layer from configurable serve options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = <R extends string>(
  options: Config.Wrap<
    ServeOptions<R> & {
      readonly disablePreemptiveShutdown?: boolean | undefined
      readonly gracefulShutdownTimeout?: Duration.Input | undefined
    }
  >
): Layer.Layer<
  Server.HttpServer | HttpPlatform | FileSystem.FileSystem | Etag.Generator | Path.Path,
  ConfigError
> =>
  Layer.mergeAll(
    Layer.effect(Server.HttpServer)(Effect.flatMap(Config.unwrap(options), make)),
    layerHttpServices
  )

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

interface WebSocketContext {
  readonly deferred: Deferred.Deferred<ServerWebSocket<WebSocketContext>>
  readonly closeDeferred: Deferred.Deferred<void, Socket.SocketError>
  readonly buffer: Array<Uint8Array | string>
  run: (_: Uint8Array | string) => void
}

function wsDefaultRun(this: WebSocketContext, _: Uint8Array | string) {
  this.buffer.push(_)
}

class BunServerRequest extends Inspectable.Class implements ServerRequest.HttpServerRequest {
  readonly [ServerRequest.TypeId]: typeof ServerRequest.TypeId
  readonly [IncomingMessage.TypeId]: typeof IncomingMessage.TypeId
  readonly source: Request
  public resolve: (response: Response) => void
  readonly url: string
  private bunServer: BunServer<WebSocketContext>
  public headersOverride?: Headers.Headers | undefined
  private remoteAddressOverride?: Option.Option<string> | undefined

  constructor(
    source: Request,
    resolve: (response: Response) => void,
    url: string,
    bunServer: BunServer<WebSocketContext>,
    headersOverride?: Headers.Headers,
    remoteAddressOverride?: Option.Option<string>
  ) {
    super()
    this[ServerRequest.TypeId] = ServerRequest.TypeId
    this[IncomingMessage.TypeId] = IncomingMessage.TypeId
    this.source = source
    this.resolve = resolve
    this.url = url
    this.bunServer = bunServer
    this.headersOverride = headersOverride
    this.remoteAddressOverride = remoteAddressOverride
  }
  toJSON(): unknown {
    return IncomingMessage.inspect(this, {
      _id: "HttpServerRequest",
      method: this.method,
      url: this.originalUrl
    })
  }
  modify(
    options: {
      readonly url?: string | undefined
      readonly headers?: Headers.Headers | undefined
      readonly remoteAddress?: Option.Option<string> | undefined
    }
  ) {
    return new BunServerRequest(
      this.source,
      this.resolve,
      options.url ?? this.url,
      this.bunServer,
      options.headers ?? this.headersOverride,
      "remoteAddress" in options ? options.remoteAddress : this.remoteAddressOverride
    )
  }
  get method(): HttpMethod {
    return this.source.method.toUpperCase() as HttpMethod
  }
  get originalUrl() {
    return this.source.url
  }
  get remoteAddress(): Option.Option<string> {
    return this.remoteAddressOverride ?? Option.fromNullishOr(this.bunServer.requestIP(this.source)?.address)
  }
  get headers(): Headers.Headers {
    this.headersOverride ??= Headers.fromInput(this.source.headers)
    return this.headersOverride
  }

  private cachedCookies: Record.ReadonlyRecord<string, string> | undefined
  get cookies() {
    if (this.cachedCookies) {
      return this.cachedCookies
    }
    return this.cachedCookies = Cookies.parseHeader(this.headers.cookie ?? "")
  }

  get stream(): Stream.Stream<Uint8Array, Error.HttpServerError> {
    return this.source.body
      ? BunStream.fromReadableStream({
        evaluate: () => this.source.body ?? emptyReadbleStream,
        onError: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({
              request: this,
              cause
            })
          })
      })
      : Stream.fail(
        new Error.HttpServerError({
          reason: new Error.RequestParseError({
            request: this,
            description: "can not create stream from empty body"
          })
        })
      )
  }

  private textEffect: Effect.Effect<string, Error.HttpServerError> | undefined
  get text(): Effect.Effect<string, Error.HttpServerError> {
    if (this.textEffect) {
      return this.textEffect
    }
    this.textEffect = Effect.runSync(Effect.cached(
      Effect.tryPromise({
        try: () => this.source.text(),
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({
              request: this,
              cause
            })
          })
      })
    ))
    return this.textEffect
  }

  get json(): Effect.Effect<Schema.Json, Error.HttpServerError> {
    return Effect.flatMap(this.text, (_) =>
      Effect.try({
        try: () => JSON.parse(_) as Schema.Json,
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({
              request: this,
              cause
            })
          })
      }))
  }

  get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, Error.HttpServerError> {
    return Effect.flatMap(this.text, (_) =>
      Effect.try({
        try: () => UrlParams.fromInput(new URLSearchParams(_)),
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({
              request: this,
              cause
            })
          })
      }))
  }

  private multipartEffect:
    | Effect.Effect<
      Multipart.Persisted,
      Multipart.MultipartError,
      Scope.Scope | FileSystem.FileSystem | Path.Path
    >
    | undefined
  get multipart(): Effect.Effect<
    Multipart.Persisted,
    Multipart.MultipartError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    if (this.multipartEffect) {
      return this.multipartEffect
    }
    this.multipartEffect = Effect.runSync(Effect.cached(
      BunMultipart.persisted(this.source)
    ))
    return this.multipartEffect
  }

  get multipartStream(): Stream.Stream<Multipart.Part, Multipart.MultipartError> {
    return BunMultipart.stream(this.source)
  }

  private arrayBufferEffect: Effect.Effect<ArrayBuffer, Error.HttpServerError> | undefined
  get arrayBuffer(): Effect.Effect<ArrayBuffer, Error.HttpServerError> {
    if (this.arrayBufferEffect) {
      return this.arrayBufferEffect
    }
    this.arrayBufferEffect = Effect.runSync(Effect.cached(
      Effect.tryPromise({
        try: () => this.source.arrayBuffer(),
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({
              request: this,
              cause
            })
          })
      })
    ))
    this.textEffect = Effect.map(this.arrayBufferEffect, (_) => new TextDecoder().decode(_))
    return this.arrayBufferEffect
  }

  get upgrade(): Effect.Effect<Socket.Socket, Error.HttpServerError> {
    return Effect.callback<Socket.Socket, Error.HttpServerError>((resume) => {
      const deferred = Deferred.makeUnsafe<ServerWebSocket<WebSocketContext>>()
      const closeDeferred = Deferred.makeUnsafe<void, Socket.SocketError>()
      const semaphore = Semaphore.makeUnsafe(1)

      const success = this.bunServer.upgrade(this.source, {
        data: {
          deferred,
          closeDeferred,
          buffer: [],
          run: wsDefaultRun
        }
      })
      if (!success) {
        resume(Effect.fail(
          new Error.HttpServerError({
            reason: new Error.RequestParseError({
              request: this,
              description: "Not an upgradeable ServerRequest"
            })
          })
        ))
        return
      }
      resume(Effect.map(Deferred.await(deferred), (ws) => {
        const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
          Effect.sync(() => {
            if (typeof chunk === "string") {
              ws.sendText(chunk)
            } else if (Socket.isCloseEvent(chunk)) {
              ws.close(chunk.code, chunk.reason)
            } else {
              ws.sendBinary(chunk)
            }

            return true
          })
        const writer = Effect.succeed(write)
        const runRaw = Effect.fnUntraced(
          function*<R, E, _>(
            handler: (_: Uint8Array | string) => Effect.Effect<_, E, R> | void,
            opts?: { readonly onOpen?: Effect.Effect<void> | undefined }
          ) {
            const set = yield* FiberSet.make<any, E>()
            const run = yield* FiberSet.runtime(set)<R>()
            function runRaw(data: Uint8Array | string) {
              const result = handler(data)
              if (Effect.isEffect(result)) {
                run(result)
              }
            }
            ws.data.run = runRaw
            ws.data.buffer.forEach(runRaw)
            ws.data.buffer.length = 0
            if (opts?.onOpen) yield* opts.onOpen
            return yield* FiberSet.join(set)
          },
          Effect.scoped,
          Effect.onExit((exit) => Effect.sync(() => ws.close(exit._tag === "Success" ? 1000 : 1011))),
          Effect.raceFirst(Deferred.await(closeDeferred)),
          semaphore.withPermits(1)
        )

        return Socket.make({
          runRaw,
          writer
        })
      }))
    })
  }
}

const emptyReadbleStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new Uint8Array())
    controller.close()
  }
})

const removeHost = (url: string) => {
  if (url[0] === "/") {
    return url
  }
  const index = url.indexOf("/", url.indexOf("//") + 2)
  return index === -1 ? "/" : url.slice(index)
}
