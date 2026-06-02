/**
 * Bridges Effect HTTP server programs with platform request handlers.
 *
 * This module runs effects that produce `HttpServerResponse` values at the edge
 * of a server runtime. It can turn an Effect handler into a Web `Request`
 * handler, build that handler from a `Layer`, adapt an existing Web handler back
 * into an Effect server effect, apply HTTP middleware, translate failures into
 * responses, and run pre-response hooks immediately before a response is sent.
 *
 * **Mental model**
 *
 * Each incoming platform request becomes an `HttpServerRequest` in the Effect
 * context plus a request `Scope`. The server effect produces a response, or
 * fails with a cause that is converted into an HTTP response. Web handler
 * adapters fork the Effect program, resolve the platform `Response` promise when
 * the response is handled, and interrupt the fiber when the request aborts.
 * Streaming responses transfer scope ownership to the body stream so resources
 * remain open until the stream exits.
 *
 * **Common tasks**
 *
 * Use `toWebHandler` for a handler with no extra services, `toWebHandlerWith`
 * when each request may provide additional context, `toWebHandlerLayer` or
 * `toWebHandlerLayerWith` when services come from a layer that must later be
 * disposed, and `fromWebHandler` when embedding a Web-standard handler inside an
 * Effect HTTP server. Use pre-response handlers to adjust headers, cookies, or
 * status before the response is converted to the platform response type.
 *
 * **Gotchas**
 *
 * Layer-backed handlers return a `dispose` function for the layer scope; call it
 * when the hosting runtime shuts down. Pre-response handlers run before bytes
 * are sent, not after a streaming body has started. Web adapters handle
 * streaming scope transfer automatically, but lower-level integrations that call
 * `toHandled` directly must preserve request scope ownership themselves.
 *
 * @since 4.0.0
 */
import type * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import { dual } from "../../Function.ts"
import { reportCauseUnsafe } from "../../internal/effect.ts"
import * as Layer from "../../Layer.ts"
import * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"
import * as HttpBody from "./HttpBody.ts"
import { type HttpMiddleware, tracer } from "./HttpMiddleware.ts"
import { causeResponse, ClientAbort, HttpServerError, InternalError } from "./HttpServerError.ts"
import { HttpServerRequest } from "./HttpServerRequest.ts"
import * as Request from "./HttpServerRequest.ts"
import type { HttpServerResponse } from "./HttpServerResponse.ts"
import * as Response from "./HttpServerResponse.ts"
import { appendPreResponseHandlerUnsafe, requestPreResponseHandlers } from "./internal/preResponseHandler.ts"

/**
 * Runs an HTTP server effect, sends the produced response with the supplied handler, and converts failures into HTTP responses.
 *
 * @category combinators
 * @since 4.0.0
 */
export const toHandled = <E, R, EH, RH>(
  self: Effect.Effect<HttpServerResponse, E, R>,
  handleResponse: (
    request: HttpServerRequest,
    response: HttpServerResponse
  ) => Effect.Effect<unknown, EH, RH>,
  middleware?: HttpMiddleware | undefined
): Effect.Effect<void, never, Exclude<R | RH | HttpServerRequest, Scope.Scope>> => {
  const handleCause = (cause: Cause.Cause<E | EH | HttpServerError>) =>
    Effect.flatMapEager(causeResponse(cause), ([response, cause]) => {
      const fiber = Fiber.getCurrent()!
      reportCauseUnsafe(fiber, cause)
      const request = Context.getUnsafe(fiber.context, HttpServerRequest)
      const handler = requestPreResponseHandlers.get(request.source)
      const cont = cause.reasons.length === 0 ? Effect.succeed(response) : Effect.failCause(cause)
      if (handler === undefined) {
        ;(request as any)[handledSymbol] = true
        return Effect.flatMapEager(
          handleResponse(request, response),
          () => cont
        )
      }

      return Effect.flatMapEager(
        Effect.flatMapEager(handler(request, response), (response) => {
          ;(request as any)[handledSymbol] = true
          return handleResponse(request, response)
        }),
        () => cont
      )
    })

  const responded = Effect.matchCauseEffect(self, {
    onSuccess: (response) => {
      const fiber = Fiber.getCurrent()!
      const request = Context.getUnsafe(fiber.context, HttpServerRequest)
      const handler = requestPreResponseHandlers.get(request.source)
      if (handler === undefined) {
        ;(request as any)[handledSymbol] = true
        return Effect.mapEager(handleResponse(request, response), () => response)
      }
      return Effect.flatMapEager(handler(request, response), (sentResponse) => {
        ;(request as any)[handledSymbol] = true
        return Effect.mapEager(handleResponse(request, sentResponse), () => response)
      })
    },
    onFailure: handleCause
  })

  const withMiddleware: Effect.Effect<
    unknown,
    E | EH | HttpServerError,
    HttpServerRequest | R | RH
  > = middleware === undefined ?
    tracer(responded) :
    Effect.matchCauseEffect(tracer(middleware(responded)), {
      onFailure(cause): Effect.Effect<void, EH, RH> {
        const fiber = Fiber.getCurrent()!
        reportCauseUnsafe(fiber, cause)
        const request = Context.getUnsafe(fiber.context, HttpServerRequest)
        if (handledSymbol in request) return Effect.void
        return Effect.matchCauseEffectEager(causeResponse(cause), {
          onFailure(_) {
            return handleResponse(request, Response.empty({ status: 500 }))
          },
          onSuccess([response]) {
            return handleResponse(request, response)
          }
        })
      },
      onSuccess(response): Effect.Effect<void, EH, RH> {
        const fiber = Fiber.getCurrent()!
        const request = Context.getUnsafe(fiber.context, Request.HttpServerRequest)
        return handledSymbol in request ? Effect.void : handleResponse(request, response)
      }
    })

  return Effect.uninterruptible(scoped(withMiddleware)) as any
}

const handledSymbol = Symbol.for("effect/http/HttpEffect/handled")

/**
 * Disables automatic closing for an HTTP request scope.
 *
 * **Gotchas**
 *
 * Use only when another owner will close the scope; otherwise resources attached
 * to the request scope can leak.
 *
 * @category resource management
 * @since 4.0.0
 */
export const scopeDisableClose = (scope: Scope.Scope): void => {
  ;(scope as any)[scopeEjected] = true
}

/**
 * Returns a streaming server response that closes the request scope when the body stream exits.
 *
 * @category resource management
 * @since 4.0.0
 */
export const scopeTransferToStream = (
  response: HttpServerResponse
): HttpServerResponse => {
  if (response.body._tag !== "Stream") {
    return response
  }
  const fiber = Fiber.getCurrent()!
  const scope = Context.getUnsafe(fiber.context, Scope.Scope) as Scope.Closeable
  scopeDisableClose(scope)
  return Response.setBody(
    response,
    HttpBody.stream(
      Stream.onExit(response.body.stream, (exit) => Scope.close(scope, exit)),
      response.body.contentType,
      response.body.contentLength
    )
  )
}

const scopeEjected = Symbol.for("effect/http/HttpEffect/scopeEjected")

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.withFiber((fiber) => {
    const scope = Scope.makeUnsafe()
    const prevServices = fiber.context
    fiber.setContext(Context.add(fiber.context, Scope.Scope, scope))
    return Effect.onExitPrimitive(effect, (exit) => {
      fiber.setContext(prevServices)
      if (scopeEjected in scope) return undefined
      return Scope.closeUnsafe(scope, exit)
    }, true)
  })

/**
 * Function run with the current request and response just before the response is sent, allowing the response to be replaced or failing with `HttpServerError`.
 *
 * @category Pre-response handlers
 * @since 4.0.0
 */
export type PreResponseHandler = (
  request: HttpServerRequest,
  response: HttpServerResponse
) => Effect.Effect<HttpServerResponse, HttpServerError>

/**
 * Registers an additional pre-response handler for the current HTTP server request.
 *
 * @category fiber refs
 * @since 4.0.0
 */
export const appendPreResponseHandler = (handler: PreResponseHandler): Effect.Effect<void, never, HttpServerRequest> =>
  HttpServerRequest.use((request) => {
    appendPreResponseHandlerUnsafe(request, handler)
    return Effect.void
  })

export {
  /**
   * Registers a pre-response handler for the supplied HTTP server request.
   *
   * @category fiber refs
   * @since 4.0.0
   */
  appendPreResponseHandlerUnsafe
}

/**
 * Runs an effect after registering a pre-response handler for the current HTTP server request.
 *
 * @category fiber refs
 * @since 4.0.0
 */
export const withPreResponseHandler: {
  (handler: PreResponseHandler): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | HttpServerRequest>
  <A, E, R>(self: Effect.Effect<A, E, R>, handler: PreResponseHandler): Effect.Effect<A, E, R | HttpServerRequest>
} = dual<
  (
    handler: PreResponseHandler
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | HttpServerRequest>,
  <A, E, R>(self: Effect.Effect<A, E, R>, handler: PreResponseHandler) => Effect.Effect<A, E, R | HttpServerRequest>
>(2, (self, handler) =>
  HttpServerRequest.use((request) => {
    appendPreResponseHandlerUnsafe(request, handler)
    return self
  }))

/**
 * Converts an HTTP server effect into a Web `Request` handler using the supplied base context and optional middleware.
 *
 * @category converting
 * @since 4.0.0
 */
export const toWebHandlerWith = <Provided, R = never, ReqR = Exclude<R, Provided | Scope.Scope | HttpServerRequest>>(
  context: Context.Context<Provided>
) =>
<E>(
  self: Effect.Effect<HttpServerResponse, E, R>,
  middleware?: HttpMiddleware | undefined
): [ReqR] extends [never] ?
  (request: Request, context?: Context.Context<never> | undefined) => Promise<globalThis.Response>
  : (request: Request, context: Context.Context<ReqR>) => Promise<globalThis.Response> =>
{
  const resolveSymbol = Symbol.for("@effect/platform/HttpApp/resolve")
  const httpApp = toHandled(self, (request, response) => {
    response = scopeTransferToStream(response)
    ;(request as any)[resolveSymbol](
      Response.toWeb(response, { withoutBody: request.method === "HEAD", context })
    )
    return Effect.void
  }, middleware)
  return (request: Request, reqContext?: Context.Context<never> | undefined): Promise<globalThis.Response> =>
    new Promise((resolve) => {
      const contextMap = new Map<string, any>(context.mapUnsafe)
      if (Context.isContext(reqContext)) {
        for (const [key, value] of reqContext.mapUnsafe) {
          contextMap.set(key, value)
        }
      }
      const httpServerRequest = Request.fromWeb(request)
      contextMap.set(HttpServerRequest.key, httpServerRequest)
      ;(httpServerRequest as any)[resolveSymbol] = resolve
      const fiber = Effect.runForkWith(Context.makeUnsafe(contextMap))(httpApp as any)
      request.signal?.addEventListener("abort", () => {
        fiber.interruptUnsafe(undefined, ClientAbort.annotation)
      }, { once: true })
    })
}

/**
 * Converts an HTTP server effect into a Web `Request` handler using an empty base context.
 *
 * @category converting
 * @since 4.0.0
 */
export const toWebHandler: <E>(
  self: Effect.Effect<HttpServerResponse, E, HttpServerRequest | Scope.Scope>,
  middleware?: HttpMiddleware | undefined
) => (request: Request, context?: Context.Context<never> | undefined) => Promise<globalThis.Response> =
  toWebHandlerWith(Context.empty())

/**
 * Builds a Web `Request` handler from a layer and handler factory, returning the handler with a `dispose` function for the layer scope.
 *
 * @category converting
 * @since 4.0.0
 */
export const toWebHandlerLayerWith = <
  E,
  Provided,
  LE,
  R,
  ReqR = Exclude<R, Provided | Scope.Scope | HttpServerRequest>
>(
  layer: Layer.Layer<Provided, LE>,
  options: {
    readonly toHandler: (
      context: Context.Context<Provided>
    ) => Effect.Effect<Effect.Effect<HttpServerResponse, E, R>, LE>
    readonly middleware?: HttpMiddleware | undefined
    readonly memoMap?: Layer.MemoMap | undefined
  }
): {
  readonly dispose: () => Promise<void>
  readonly handler: [ReqR] extends [never] ? (
      request: Request,
      context?: Context.Context<never> | undefined
    ) => Promise<globalThis.Response>
    : (
      request: Request,
      context: Context.Context<ReqR>
    ) => Promise<globalThis.Response>
} => {
  const scope = Scope.makeUnsafe()
  const dispose = () => Effect.runPromise(Scope.close(scope, Exit.void))

  let handlerCache:
    | ((request: Request, context?: Context.Context<ReqR> | undefined) => Promise<globalThis.Response>)
    | undefined
  let handlerPromise:
    | Promise<(request: Request, context?: Context.Context<ReqR> | undefined) => Promise<globalThis.Response>>
    | undefined
  function handler(
    request: Request,
    context?: Context.Context<ReqR> | undefined
  ): Promise<globalThis.Response> {
    if (handlerCache) {
      return handlerCache(request, context)
    }
    handlerPromise ??= Effect.runPromise(Effect.gen(function*() {
      const context = yield* (options.memoMap
        ? Layer.buildWithMemoMap(layer, options.memoMap, scope)
        : Layer.buildWithScope(layer, scope))
      return handlerCache = toWebHandlerWith<Provided, R>(context)(
        yield* options.toHandler(context),
        options.middleware
      ) as any
    }))
    return handlerPromise.then((f) => f(request, context))
  }
  return { dispose, handler: handler as any } as const
}

/**
 * Builds a Web `Request` handler for an HTTP server effect using a layer to provide its services, returning the handler with a `dispose` function.
 *
 * @category converting
 * @since 4.0.0
 */
export const toWebHandlerLayer = <E, R, Provided, LE, ReqR = Exclude<R, Provided | Scope.Scope | HttpServerRequest>>(
  self: Effect.Effect<HttpServerResponse, E, R>,
  layer: Layer.Layer<Provided, LE>,
  options?: {
    readonly middleware?: HttpMiddleware | undefined
    readonly memoMap?: Layer.MemoMap | undefined
  } | undefined
): {
  readonly dispose: () => Promise<void>
  readonly handler: [ReqR] extends [never]
    ? (request: Request, context?: Context.Context<never> | undefined) => Promise<globalThis.Response>
    : (
      request: Request,
      context: Context.Context<ReqR>
    ) => Promise<globalThis.Response>
} =>
  toWebHandlerLayerWith(layer, {
    ...options,
    toHandler: () => Effect.succeed(self)
  })

/**
 * Adapts a Web `Request` handler into an HTTP server effect for the current `HttpServerRequest`.
 *
 * @category converting
 * @since 4.0.0
 */
export const fromWebHandler = (
  handler: (request: Request) => Promise<Response>
): Effect.Effect<HttpServerResponse, HttpServerError, HttpServerRequest> =>
  Effect.callback((resume, signal) => {
    const fiber = Fiber.getCurrent()!
    const request = Context.getUnsafe(fiber.context, HttpServerRequest)
    const requestResult = Request.toWebResult(request, {
      signal,
      context: fiber.context
    })
    if (requestResult._tag === "Failure") {
      return resume(Effect.fail(new HttpServerError({ reason: requestResult.failure })))
    }
    handler(requestResult.success).then(
      (response) => resume(Effect.succeed(Response.fromWeb(response))),
      (cause) =>
        resume(Effect.fail(
          new HttpServerError({
            reason: new InternalError({
              cause,
              request,
              description: "HttpApp.fromWebHandler: Error in handler"
            })
          })
        ))
    )
  })
