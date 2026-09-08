/**
 * Native Deno implementation of the Effect `HttpServer`.
 *
 * @since 4.0.0
 */
import * as Config from "effect/Config"
import type { ConfigError } from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as FileSystem from "effect/FileSystem"
import { flow } from "effect/Function"
import * as Inspectable from "effect/Inspectable"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import type * as Record from "effect/Record"
import type * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Cookies from "effect/unstable/http/Cookies"
import * as Etag from "effect/unstable/http/Etag"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Headers from "effect/unstable/http/Headers"
import type * as HttpBody from "effect/unstable/http/HttpBody"
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
import * as Platform from "./DenoHttpPlatform.ts"
import * as DenoMultipart from "./DenoMultipart.ts"
import * as DenoServices from "./DenoServices.ts"

/**
 * Native Deno TCP, TLS, or Unix serve options managed by the scoped server.
 *
 * **Details**
 *
 * `signal` and `onError` are omitted because the scope and Effect HTTP handler
 * own server and failure lifecycles. Server constructors additionally accept
 * WebSocket settings that apply to every upgrade; `protocol` therefore cannot
 * vary per request.
 *
 * @category options
 * @since 4.0.0
 */
export type ServeOptions =
  | (Omit<Deno.ServeTcpOptions, "signal" | "onError"> & Partial<Deno.TlsCertifiedKeyPem>)
  | Omit<Deno.ServeUnixOptions, "signal" | "onError">

/**
 * Creates a scoped native Deno HTTP server.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(
  options: ServeOptions & {
    readonly disablePreemptiveShutdown?: boolean | undefined
    readonly gracefulShutdownTimeout?: Duration.Input | undefined
    readonly websocket?: Deno.UpgradeWebSocketOptions | undefined
  }
) {
  const scope = yield* Effect.scope
  type Handler = (request: Request, info: Deno.ServeHandlerInfo<Deno.NetAddr | Deno.UnixAddr>) => Promise<Response>
  const notFound: Handler = (_request, _info) => Promise.resolve(new Response("not found", { status: 404 }))
  const handlerStack: Array<Handler> = [notFound]
  let currentHandler = notFound
  const {
    disablePreemptiveShutdown,
    gracefulShutdownTimeout,
    websocket,
    ...serveOptions
  } = options
  const server = Deno.serve(
    serveOptions as Deno.ServeTcpOptions,
    (request, info) => currentHandler(request, info)
  ) as Deno.HttpServer<Deno.NetAddr | Deno.UnixAddr>

  const shutdown = yield* Effect.promise(() => server.shutdown()).pipe(Effect.cached)
  const preemptiveShutdown = disablePreemptiveShutdown ? Effect.void : Effect.timeoutOrElse(shutdown, {
    duration: gracefulShutdownTimeout ?? Duration.seconds(20),
    orElse: () => Effect.void
  })

  yield* Scope.addFinalizer(scope, shutdown)

  const serverAddress = server.addr
  const address: Server.Address = serverAddress.transport === "unix"
    ? { _tag: "UnixAddress", path: serverAddress.path }
    : {
      _tag: "TcpAddress",
      port: (serverAddress as Deno.NetAddr).port,
      hostname: (serverAddress as Deno.NetAddr).hostname
    }

  return Server.make({
    address,
    serve: Effect.fnUntraced(function*(httpApp, middleware) {
      const parent = yield* Effect.fiber
      const services = parent.context
      const serveScope = Context.getUnsafe(services, Scope.Scope)
      const scope = Scope.forkUnsafe(serveScope, "parallel")

      const httpEffect = HttpEffect.toHandled(httpApp, (request, response) => {
        const denoRequest = request as DenoServerRequest
        if (denoRequest.upgraded) return cancelResponseBody(response.body)
        return Effect.flatMap(
          makeResponse(request, response, services, scope),
          (response) => Effect.sync(() => denoRequest.resolve(response))
        )
      }, middleware)

      function handler(
        request: Request,
        info: Deno.ServeHandlerInfo<Deno.NetAddr | Deno.UnixAddr>
      ): Promise<Response> {
        return new Promise<Response>((resolve) => {
          const context = Context.add(
            services,
            ServerRequest.HttpServerRequest,
            new DenoServerRequest(request, info.remoteAddr, resolve, removeHost(request.url), websocket)
          )
          const fiber = Fiber.runIn(Effect.runForkWith(context)(httpEffect), scope)
          request.signal.addEventListener("abort", () => {
            fiber.interruptUnsafe(parent.id, Error.ClientAbort.annotation)
          }, { once: true })
        })
      }

      yield* Scope.addFinalizerExit(serveScope, () => {
        const index = handlerStack.lastIndexOf(handler)
        if (index !== -1) handlerStack.splice(index, 1)
        currentHandler = handlerStack[handlerStack.length - 1] ?? notFound
        return preemptiveShutdown
      })
      handlerStack.push(handler)
      currentHandler = handler
    })
  })
})

const makeResponse = Effect.fnUntraced(function*(
  request: ServerRequest.HttpServerRequest,
  response: ServerResponse.HttpServerResponse,
  context: Context.Context<never>,
  scope: Scope.Scope
) {
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
  if (response.statusText !== undefined) fields.statusText = response.statusText

  if (request.method === "HEAD") {
    yield* cancelResponseBody(response.body)
    return new Response(undefined, fields)
  }
  response = HttpEffect.scopeTransferToStream(response)
  const body = response.body
  switch (body._tag) {
    case "Empty":
      return new Response(undefined, fields)
    case "Uint8Array":
    case "Raw": {
      if (body.body instanceof Response) {
        for (const [key, value] of fields.headers.entries()) body.body.headers.set(key, value)
        return body.body
      }
      return new Response(body.body as any, fields)
    }
    case "FormData":
      return new Response(body.formData as any, fields)
    case "Stream":
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
})

/**
 * Provides only the native Deno HTTP server.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerServer: (
  options: ServeOptions & {
    readonly disablePreemptiveShutdown?: boolean | undefined
    readonly gracefulShutdownTimeout?: Duration.Input | undefined
    readonly websocket?: Deno.UpgradeWebSocketOptions | undefined
  }
) => Layer.Layer<Server.HttpServer> = flow(
  make,
  Layer.effect(Server.HttpServer)
)

/**
 * Provides Deno HTTP platform services and the standard Deno service set.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerHttpServices: Layer.Layer<HttpPlatform | Etag.Generator | DenoServices.DenoServices> = Layer.mergeAll(
  Platform.layer,
  Etag.layerWeak,
  DenoServices.layer
)

/**
 * Provides a native Deno HTTP server together with Deno HTTP services.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  options: ServeOptions & {
    readonly disablePreemptiveShutdown?: boolean | undefined
    readonly gracefulShutdownTimeout?: Duration.Input | undefined
    readonly websocket?: Deno.UpgradeWebSocketOptions | undefined
  }
): Layer.Layer<Server.HttpServer | HttpPlatform | Etag.Generator | DenoServices.DenoServices> =>
  Layer.mergeAll(layerServer(options), layerHttpServices)

/**
 * Starts a Deno HTTP server on an ephemeral loopback port for tests.
 *
 * @category testing
 * @since 4.0.0
 */
export const layerTest: Layer.Layer<
  Server.HttpServer | HttpPlatform | FileSystem.FileSystem | Etag.Generator | Path.Path | HttpClient
> = Server.layerTestClient.pipe(
  Layer.provide(FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false }))
  )),
  Layer.provideMerge(layer({ hostname: "127.0.0.1", port: 0, onListen: () => {} }))
)

/**
 * Creates the Deno HTTP server and support-services layer from configurable options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (
  options: Config.Wrap<
    ServeOptions & {
      readonly disablePreemptiveShutdown?: boolean | undefined
      readonly gracefulShutdownTimeout?: Duration.Input | undefined
      readonly websocket?: Deno.UpgradeWebSocketOptions | undefined
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

class DenoServerRequest extends Inspectable.Class implements ServerRequest.HttpServerRequest {
  readonly [ServerRequest.TypeId]: typeof ServerRequest.TypeId
  readonly [IncomingMessage.TypeId]: typeof IncomingMessage.TypeId
  readonly source: Request
  readonly remoteAddr: Deno.NetAddr | Deno.UnixAddr
  readonly url: string
  readonly websocketOptions: Deno.UpgradeWebSocketOptions | undefined
  public resolve: (response: Response) => void
  public upgraded = false
  public headersOverride?: Headers.Headers | undefined
  private remoteAddressOverride?: Option.Option<string> | undefined

  constructor(
    source: Request,
    remoteAddr: Deno.NetAddr | Deno.UnixAddr,
    resolve: (response: Response) => void,
    url: string,
    websocketOptions: Deno.UpgradeWebSocketOptions | undefined,
    headersOverride?: Headers.Headers,
    remoteAddressOverride?: Option.Option<string>
  ) {
    super()
    this[ServerRequest.TypeId] = ServerRequest.TypeId
    this[IncomingMessage.TypeId] = IncomingMessage.TypeId
    this.source = source
    this.remoteAddr = remoteAddr
    this.resolve = resolve
    this.url = url
    this.websocketOptions = websocketOptions
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
  modify(options: {
    readonly url?: string | undefined
    readonly headers?: Headers.Headers | undefined
    readonly remoteAddress?: Option.Option<string> | undefined
  }) {
    return new DenoServerRequest(
      this.source,
      this.remoteAddr,
      this.resolve,
      options.url ?? this.url,
      this.websocketOptions,
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
    return this.remoteAddressOverride ?? (this.remoteAddr.transport === "tcp"
      ? Option.some(this.remoteAddr.hostname)
      : Option.none())
  }
  get headers(): Headers.Headers {
    this.headersOverride ??= Headers.fromInput(this.source.headers)
    return this.headersOverride
  }

  private cachedCookies: Record.ReadonlyRecord<string, string> | undefined
  get cookies() {
    return this.cachedCookies ??= Cookies.parseHeader(this.headers.cookie ?? "")
  }

  get stream(): Stream.Stream<Uint8Array, Error.HttpServerError> {
    return this.source.body
      ? Stream.fromReadableStream({
        evaluate: () => this.source.body ?? emptyReadableStream,
        onError: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({ request: this, cause })
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
    return this.textEffect ??= Effect.runSync(Effect.cached(
      Effect.tryPromise({
        try: () => this.source.text(),
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({ request: this, cause })
          })
      })
    ))
  }
  get json(): Effect.Effect<Schema.Json, Error.HttpServerError> {
    return Effect.flatMap(this.text, (_) =>
      Effect.try({
        try: () => JSON.parse(_) as Schema.Json,
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({ request: this, cause })
          })
      }))
  }
  get urlParamsBody(): Effect.Effect<UrlParams.UrlParams, Error.HttpServerError> {
    return Effect.flatMap(this.text, (_) =>
      Effect.try({
        try: () => UrlParams.fromInput(new URLSearchParams(_)),
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({ request: this, cause })
          })
      }))
  }

  private multipartEffect:
    | Effect.Effect<Multipart.Persisted, Multipart.MultipartError, Scope.Scope | FileSystem.FileSystem | Path.Path>
    | undefined
  get multipart(): Effect.Effect<
    Multipart.Persisted,
    Multipart.MultipartError,
    Scope.Scope | FileSystem.FileSystem | Path.Path
  > {
    return this.multipartEffect ??= Effect.runSync(Effect.cached(DenoMultipart.persisted(this.source)))
  }
  get multipartStream(): Stream.Stream<Multipart.Part, Multipart.MultipartError> {
    return DenoMultipart.stream(this.source)
  }

  private arrayBufferEffect: Effect.Effect<ArrayBuffer, Error.HttpServerError> | undefined
  get arrayBuffer(): Effect.Effect<ArrayBuffer, Error.HttpServerError> {
    if (this.arrayBufferEffect) return this.arrayBufferEffect
    this.arrayBufferEffect = Effect.runSync(Effect.cached(
      Effect.tryPromise({
        try: () => this.source.arrayBuffer(),
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({ request: this, cause })
          })
      })
    ))
    this.textEffect = Effect.map(this.arrayBufferEffect, (_) => new TextDecoder().decode(_))
    return this.arrayBufferEffect
  }

  get upgrade(): Effect.Effect<Socket.Socket, Error.HttpServerError> {
    return Effect.flatMap(
      Effect.try({
        try: () => Deno.upgradeWebSocket(this.source, this.websocketOptions),
        catch: (cause) =>
          new Error.HttpServerError({
            reason: new Error.RequestParseError({
              request: this,
              cause,
              description: "Not an upgradeable ServerRequest"
            })
          })
      }),
      (upgrade) => {
        const buffered: Array<MessageEvent> = []
        const buffer = (event: MessageEvent) => buffered.push(event)
        upgrade.socket.addEventListener("message", buffer)
        this.upgraded = true
        this.resolve(upgrade.response)

        return Effect.callback<Socket.Socket, Error.HttpServerError>((resume) => {
          const cleanup = () => {
            upgrade.socket.removeEventListener("open", onOpen)
            upgrade.socket.removeEventListener("error", onFailure)
            upgrade.socket.removeEventListener("close", onFailure)
          }
          const onFailure = (cause: Event) => {
            cleanup()
            upgrade.socket.removeEventListener("message", buffer)
            buffered.length = 0
            resume(Effect.fail(
              new Error.HttpServerError({
                reason: new Error.RequestParseError({
                  request: this,
                  cause,
                  description: "WebSocket upgrade failed before open"
                })
              })
            ))
          }
          const onOpen = () => {
            cleanup()
            resume(Socket.fromWebSocket(
              Effect.acquireRelease(
                Effect.succeed(upgrade.socket),
                (socket) => Effect.sync(() => socket.close(1000))
              ),
              {
                onInitialRun: (socket) => {
                  socket.removeEventListener("message", buffer)
                  return buffered.splice(0)
                }
              }
            ))
          }
          upgrade.socket.addEventListener("open", onOpen, { once: true })
          upgrade.socket.addEventListener("error", onFailure, { once: true })
          upgrade.socket.addEventListener("close", onFailure, { once: true })
          return Effect.sync(() => {
            cleanup()
            upgrade.socket.removeEventListener("message", buffer)
            buffered.length = 0
            upgrade.socket.close()
          })
        })
      }
    )
  }
}

const cancelResponseBody = (body: HttpBody.HttpBody): Effect.Effect<void> => {
  const stream = (body as any).body
  if ((body._tag === "Raw" || body._tag === "Uint8Array") && stream instanceof ReadableStream) {
    return Effect.ignoreCause(Effect.promise(() => stream.cancel()))
  }
  return Effect.void
}

const emptyReadableStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array())
    controller.close()
  }
})

const removeHost = (url: string) => {
  if (url[0] === "/") return url
  const index = url.indexOf("/", url.indexOf("//") + 2)
  return index === -1 ? "/" : url.slice(index)
}
