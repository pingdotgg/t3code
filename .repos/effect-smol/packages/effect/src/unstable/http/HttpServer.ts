/**
 * Service for serving Effect HTTP responses on a concrete HTTP server.
 *
 * Platform adapters provide `HttpServer`, and routers or applications consume
 * it to run an `HttpServerResponse` effect for each incoming request. The
 * service exposes the listening address, while this module also includes helpers
 * for address formatting, server logging, and clients that target the current
 * server in tests.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as FileSystem from "../../FileSystem.ts"
import { dual } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Path from "../../Path.ts"
import type * as Scope from "../../Scope.ts"
import * as Etag from "./Etag.ts"
import * as HttpClient from "./HttpClient.ts"
import * as ClientRequest from "./HttpClientRequest.ts"
import type * as Middleware from "./HttpMiddleware.ts"
import * as HttpPlatform from "./HttpPlatform.ts"
import type { HttpServerRequest } from "./HttpServerRequest.ts"
import type { HttpServerResponse } from "./HttpServerResponse.ts"

/**
 * Service tag for an HTTP server runtime.
 *
 * **Details**
 *
 * The service can serve an HTTP response effect and exposes the address where the
 * server is listening.
 *
 * @category models
 * @since 4.0.0
 */
export class HttpServer extends Context.Service<HttpServer, {
  readonly serve: {
    <E, R>(effect: Effect.Effect<HttpServerResponse, E, R>): Effect.Effect<
      void,
      never,
      Exclude<R, HttpServerRequest> | Scope.Scope
    >
    <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
      effect: Effect.Effect<HttpServerResponse, E, R>,
      middleware: Middleware.HttpMiddleware.Applied<App, E, R>
    ): Effect.Effect<
      void,
      never,
      Exclude<R, HttpServerRequest> | Scope.Scope
    >
  }

  readonly address: Address
}>()("effect/http/HttpServer") {}

/**
 * Address where an HTTP server is listening.
 *
 * **Details**
 *
 * The address is either a TCP host and port or a Unix domain socket path.
 *
 * @category address
 * @since 4.0.0
 */
export type Address = UnixAddress | TcpAddress

/**
 * TCP address for an HTTP server, identified by hostname and port.
 *
 * @category address
 * @since 4.0.0
 */
export interface TcpAddress {
  readonly _tag: "TcpAddress"
  readonly hostname: string
  readonly port: number
}

/**
 * Unix domain socket address for an HTTP server.
 *
 * @category address
 * @since 4.0.0
 */
export interface UnixAddress {
  readonly _tag: "UnixAddress"
  readonly path: string
}

/**
 * Constructs an `HttpServer` service from a serving implementation and listening
 * address.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: {
    readonly serve: (
      httpEffect: Effect.Effect<HttpServerResponse, unknown, HttpServerRequest | Scope.Scope>,
      middleware?: Middleware.HttpMiddleware
    ) => Effect.Effect<void, never, Scope.Scope>
    readonly address: Address
  }
): HttpServer["Service"] => options

/**
 * Creates a layer that starts serving an HTTP response effect with the current
 * `HttpServer`.
 *
 * **Details**
 *
 * The request service is supplied by the server for each request; the returned
 * layer still requires the server, a scope, and any non-request dependencies of
 * the response effect or middleware.
 *
 * @category accessors
 * @since 4.0.0
 */
export const serve: {
  (): <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Layer.Layer<never, never, HttpServer | Exclude<R, HttpServerRequest | Scope.Scope>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): (
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Layer.Layer<
    never,
    never,
    HttpServer | Exclude<Effect.Services<App>, HttpServerRequest | Scope.Scope>
  >
  <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ): Layer.Layer<never, never, HttpServer | Exclude<R, HttpServerRequest | Scope.Scope>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    effect: Effect.Effect<HttpServerResponse, E, R>,
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): Layer.Layer<
    never,
    never,
    HttpServer | Exclude<Effect.Services<App>, HttpServerRequest | Scope.Scope>
  >
} = dual((args) => Effect.isEffect(args[0]), <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
  effect: Effect.Effect<HttpServerResponse, E, R>,
  middleware?: Middleware.HttpMiddleware.Applied<App, E, R>
): Layer.Layer<
  never,
  never,
  HttpServer | Exclude<Effect.Services<App>, HttpServerRequest | Scope.Scope>
> =>
  Layer.effectDiscard(
    HttpServer.use((server) => server.serve(effect, middleware!))
  ) as any)

/**
 * Effect that starts serving an HTTP response effect with the current
 * `HttpServer`.
 *
 * **Details**
 *
 * The request service is supplied by the server for each request; the effect
 * requires a scope and any non-request dependencies of the response effect or
 * middleware.
 *
 * @category accessors
 * @since 4.0.0
 */
export const serveEffect: {
  (): <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Effect.Effect<void, never, Scope.Scope | HttpServer | Exclude<R, HttpServerRequest>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): (
    effect: Effect.Effect<HttpServerResponse, E, R>
  ) => Effect.Effect<
    void,
    never,
    Scope.Scope | HttpServer | Exclude<Effect.Services<App>, HttpServerRequest>
  >
  <E, R>(
    effect: Effect.Effect<HttpServerResponse, E, R>
  ): Effect.Effect<void, never, Scope.Scope | HttpServer | Exclude<R, HttpServerRequest>>
  <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
    effect: Effect.Effect<HttpServerResponse, E, R>,
    middleware: Middleware.HttpMiddleware.Applied<App, E, R>
  ): Effect.Effect<
    void,
    never,
    Scope.Scope | HttpServer | Exclude<Effect.Services<App>, HttpServerRequest>
  >
} = dual((args) => Effect.isEffect(args[0]), <E, R, App extends Effect.Effect<HttpServerResponse, any, any>>(
  effect: Effect.Effect<HttpServerResponse, E, R>,
  middleware?: Middleware.HttpMiddleware.Applied<App, E, R>
): Effect.Effect<
  void,
  never,
  Scope.Scope | HttpServer | Exclude<Effect.Services<App>, HttpServerRequest>
> => HttpServer.use((server) => server.serve(effect, middleware!)) as any)

/**
 * Formats a server address as a display string.
 *
 * **Details**
 *
 * TCP addresses are formatted as `http://host:port`; Unix socket addresses are
 * formatted as `unix://path`.
 *
 * @category address
 * @since 4.0.0
 */
export const formatAddress = (address: Address): string => {
  switch (address._tag) {
    case "UnixAddress":
      return `unix://${address.path}`
    case "TcpAddress":
      return `http://${address.hostname}:${address.port}`
  }
}

/**
 * Reads the current server address, formats it with `formatAddress`, and passes
 * the formatted address to the supplied effectful function.
 *
 * @category address
 * @since 4.0.0
 */
export const addressFormattedWith = <A, E, R>(
  f: (address: string) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, HttpServer | R> =>
  Effect.flatMap(
    HttpServer,
    (server) => f(formatAddress(server.address))
  )

/**
 * Logs the formatted address of the current HTTP server.
 *
 * @category address
 * @since 4.0.0
 */
export const logAddress: Effect.Effect<void, never, HttpServer> = addressFormattedWith((_) =>
  Effect.log(`Listening on ${_}`)
)

/**
 * Adds address logging to a layer that provides an `HttpServer`.
 *
 * @category address
 * @since 4.0.0
 */
export const withLogAddress = <A, E, R>(
  layer: Layer.Layer<A, E, R>
): Layer.Layer<A, E, R | Exclude<HttpServer, A>> =>
  Layer.effectDiscard(logAddress).pipe(
    Layer.provideMerge(layer)
  )

/**
 * Builds an `HttpClient` that sends requests to the current test HTTP server.
 *
 * **Details**
 *
 * For TCP servers, requests are prefixed with the server URL and `0.0.0.0` is
 * rewritten to `127.0.0.1`.
 *
 * **Gotchas**
 *
 * Unix socket addresses are not supported.
 *
 * @category testing
 * @since 4.0.0
 */
export const makeTestClient: Effect.Effect<
  HttpClient.HttpClient,
  never,
  HttpServer | HttpClient.HttpClient
> = Effect.gen(function*() {
  const server = yield* HttpServer
  const client = yield* HttpClient.HttpClient
  const address = server.address
  if (address._tag === "UnixAddress") {
    return yield* Effect.die(new Error("HttpServer.layerTestClient: UnixAddress not supported"))
  }
  const host = address.hostname === "0.0.0.0" ? "127.0.0.1" : address.hostname
  const url = `http://${host}:${address.port}`
  return HttpClient.mapRequest(client, ClientRequest.prependUrl(url))
})

/**
 * Layer that provides the test `HttpClient` created by `makeTestClient`.
 *
 * @category testing
 * @since 4.0.0
 */
export const layerTestClient: Layer.Layer<
  HttpClient.HttpClient,
  never,
  HttpServer | HttpClient.HttpClient
> = Layer.effect(HttpClient.HttpClient)(makeTestClient)

/**
 * Layer that provides the platform services commonly needed by HTTP
 * server tests.
 *
 * **Details**
 *
 * It includes `HttpPlatform`, `Path`, a weak ETag generator, and a no-op
 * `FileSystem`.
 *
 * @category testing
 * @since 4.0.0
 */
export const layerServices: Layer.Layer<
  | Path.Path
  | HttpPlatform.HttpPlatform
  | FileSystem.FileSystem
  | Etag.Generator
> = Layer.mergeAll(
  HttpPlatform.layer,
  Path.layer,
  Etag.layerWeak
).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
)
