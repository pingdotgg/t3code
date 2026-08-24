/**
 * Wraps HTTP server apps with request and response behavior.
 *
 * A middleware is a function from one HTTP server app effect to another. The app
 * runs with the current `HttpServerRequest` in its context, so middleware can
 * inspect or rewrite the request, provide request-scoped services, attach hooks
 * before the response is sent, or observe the app exit. This module includes
 * middleware for response logging, server tracing, forwarded proxy headers,
 * parsed search parameters, and CORS response headers.
 *
 * @since 4.0.0
 */
import { Clock } from "../../Clock.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import { constant, constFalse } from "../../Function.ts"
import * as internalEffect from "../../internal/effect.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import type { Predicate } from "../../Predicate.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import { TracerEnabled } from "../../References.ts"
import { ParentSpan } from "../../Tracer.ts"
import * as Headers from "./Headers.ts"
import { causeResponseStripped } from "./HttpServerError.ts"
import { HttpServerRequest } from "./HttpServerRequest.ts"
import * as Request from "./HttpServerRequest.ts"
import * as Response from "./HttpServerResponse.ts"
import type { HttpServerResponse } from "./HttpServerResponse.ts"
import * as TraceContext from "./HttpTraceContext.ts"
import { appendPreResponseHandlerUnsafe } from "./internal/preResponseHandler.ts"

/**
 * Middleware that transforms an HTTP server app effect into another HTTP server app effect.
 *
 * @category models
 * @since 4.0.0
 */
export interface HttpMiddleware {
  <E, R>(self: Effect.Effect<HttpServerResponse, E, R | HttpServerRequest>): Effect.Effect<HttpServerResponse, any, any>
}

/**
 * Namespace containing types associated with `HttpMiddleware`.
 *
 * @since 4.0.0
 */
export declare namespace HttpMiddleware {
  /**
   * Callable type representing middleware already specialized to a particular transformed app type.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Applied<A extends Effect.Effect<HttpServerResponse, any, any>, E, R> {
    (self: Effect.Effect<HttpServerResponse, E, R>): A
  }
}

/**
 * Defines an `HttpMiddleware` while preserving its precise type.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <M extends HttpMiddleware>(middleware: M): M => middleware

const loggerDisabledRequests = new WeakSet<object>()

const stripSearchAndHash = (url: string): string => {
  const queryIndex = url.indexOf("?")
  const hashIndex = url.indexOf("#")

  if (queryIndex === -1) {
    return hashIndex === -1 ? url : url.slice(0, hashIndex)
  }
  if (hashIndex === -1) {
    return url.slice(0, queryIndex)
  }
  return url.slice(0, Math.min(queryIndex, hashIndex))
}

/**
 * Runs an effect with HTTP response logging disabled for the current server request.
 *
 * @category Logger
 * @since 4.0.0
 */
export const withLoggerDisabled = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | HttpServerRequest> =>
  Effect.withFiber((fiber) => {
    const request = Context.getUnsafe(fiber.context, HttpServerRequest)
    loggerDisabledRequests.add(request.source)
    return self
  })

/**
 * Context reference for a predicate that disables server-side tracing for matching requests.
 *
 * @category Tracer
 * @since 4.0.0
 */
export const TracerDisabledWhen = Context.Reference<Predicate<HttpServerRequest>>(
  "effect/http/HttpMiddleware/TracerDisabledWhen",
  { defaultValue: () => constFalse }
)

/**
 * Creates a layer that disables server-side tracing for requests whose URL exactly matches one of the supplied URLs.
 *
 * @category Tracer
 * @since 4.0.0
 */
export const layerTracerDisabledForUrls = (
  urls: ReadonlyArray<string>
): Layer.Layer<never> => Layer.succeed(TracerDisabledWhen)((req) => urls.includes(req.url))

/**
 * Context reference for generating server span names from HTTP server requests.
 *
 * @category Tracer
 * @since 4.0.0
 */
export const SpanNameGenerator = Context.Reference<(request: HttpServerRequest) => string>(
  "@effect/platform/HttpMiddleware/SpanNameGenerator",
  { defaultValue: () => (request) => `http.server ${request.method}` }
)

/**
 * Middleware that logs sent HTTP responses with request method, request URL, and response status annotations.
 *
 * @category Logger
 * @since 4.0.0
 */
export const logger: <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, HttpServerRequest | R>
) => Effect.Effect<HttpServerResponse, E, HttpServerRequest | R> = make((httpApp) =>
  Effect.withFiber((fiber) => {
    const request = Context.getUnsafe(fiber.context, HttpServerRequest)
    const path = stripSearchAndHash(request.url)
    return Effect.withLogSpan(
      Effect.flatMap(Effect.exit(httpApp), (exit) => {
        if (loggerDisabledRequests.has(request.source)) {
          return exit
        } else if (exit._tag === "Failure") {
          const [response, cause] = causeResponseStripped(exit.cause)
          return Effect.andThen(
            Effect.annotateLogs(Effect.log(Option.getOrElse(cause, () => "Sent HTTP Response")), {
              "http.method": request.method,
              "http.url": path,
              "http.status": response.status
            }),
            exit
          )
        }
        return Effect.andThen(
          Effect.annotateLogs(Effect.log("Sent HTTP response"), {
            "http.method": request.method,
            "http.url": path,
            "http.status": exit.value.status
          }),
          exit
        )
      }),
      "http.span"
    )
  })
)

/**
 * Middleware that creates a server trace span for each request and records request and response HTTP attributes.
 *
 * @category Tracer
 * @since 4.0.0
 */
export const tracer: <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, HttpServerRequest | R>
) => Effect.Effect<HttpServerResponse, E, HttpServerRequest | R> = make((httpApp) =>
  Effect.withFiber((fiber) => {
    const request = Context.getUnsafe(fiber.context, HttpServerRequest)
    const disabled = !fiber.getRef(TracerEnabled) || fiber.getRef(TracerDisabledWhen)(request)
    if (disabled) {
      return httpApp
    }
    const nameGenerator = fiber.getRef(SpanNameGenerator)
    const span = internalEffect.makeSpanUnsafe(fiber, nameGenerator(request), {
      parent: Option.getOrUndefined(TraceContext.fromHeaders(request.headers)),
      kind: "server"
    })
    const prevServices = fiber.context
    fiber.setContext(Context.add(fiber.context, ParentSpan, span))
    return Effect.onExitPrimitive(httpApp, (exit) => {
      fiber.setContext(prevServices)
      const endTime = fiber.getRef(Clock).currentTimeNanosUnsafe()
      fiber.currentDispatcher.scheduleTask(() => {
        const url = Request.toURL(request)
        if (Option.isSome(url) && (url.value.username !== "" || url.value.password !== "")) {
          url.value.username = "REDACTED"
          url.value.password = "REDACTED"
        }
        const redactedHeaderNames = fiber.getRef(Headers.CurrentRedactedNames)
        const requestHeaders = Headers.redact(request.headers, redactedHeaderNames)
        span.attribute("http.request.method", request.method)
        if (Option.isSome(url)) {
          span.attribute("url.full", url.value.toString())
          span.attribute("url.path", url.value.pathname)
          const query = url.value.search.slice(1)
          if (query !== "") {
            span.attribute("url.query", url.value.search.slice(1))
          }
          span.attribute("url.scheme", url.value.protocol.slice(0, -1))
        }
        if (request.headers["user-agent"] !== undefined) {
          span.attribute("user_agent.original", request.headers["user-agent"])
        }
        for (const name in requestHeaders) {
          span.attribute(`http.request.header.${name}`, String(requestHeaders[name]))
        }
        if (Option.isSome(request.remoteAddress)) {
          span.attribute("client.address", request.remoteAddress.value)
        }
        let response: HttpServerResponse
        let spanExit = exit
        if (Exit.isFailure(exit)) {
          const [failureResponse, cause] = causeResponseStripped(exit.cause)
          response = failureResponse
          spanExit = Option.isSome(cause) ? Exit.failCause(cause.value) : Exit.succeed(response)
        } else {
          response = exit.value
        }
        span.attribute("http.response.status_code", response.status)
        const responseHeaders = Headers.redact(response.headers, redactedHeaderNames)
        for (const name in responseHeaders) {
          span.attribute(`http.response.header.${name}`, String(responseHeaders[name]))
        }
        span.end(endTime, spanExit)
      }, 0)
      return undefined
    }, true)
  })
)

/**
 * Middleware that trusts `X-Forwarded-Host` and `X-Forwarded-For`, updating the request host header and remote address.
 *
 * @category Proxying
 * @since 4.0.0
 */
export const xForwardedHeaders = make((httpApp) =>
  Effect.updateService(httpApp, HttpServerRequest, (request) =>
    request.headers["x-forwarded-host"]
      ? request.modify({
        headers: Headers.set(
          request.headers,
          "host",
          request.headers["x-forwarded-host"]
        ),
        remoteAddress: Option.fromNullishOr(request.headers["x-forwarded-for"]?.split(",")[0].trim())
      })
      : request)
)

/**
 * Middleware that parses the current request URL's search parameters and provides them as `ParsedSearchParams`.
 *
 * @category search params
 * @since 4.0.0
 */
export const searchParamsParser = <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, R>
): Effect.Effect<Response.HttpServerResponse, E, HttpServerRequest | Exclude<R, Request.ParsedSearchParams>> =>
  Effect.withFiber((fiber) => {
    const services = fiber.context
    const request = Context.getUnsafe(services, HttpServerRequest)
    const params = Request.searchParamsFromURL(new URL(request.originalUrl))
    return Effect.provideService(
      httpApp,
      Request.ParsedSearchParams,
      params
    ) as any
  })

/**
 * Middleware that handles CORS preflight requests and adds configured CORS headers to HTTP responses.
 *
 * @category CORS
 * @since 4.0.0
 */
export const cors = (options?: {
  readonly allowedOrigins?: ReadonlyArray<string> | Predicate<string> | undefined
  readonly allowedMethods?: ReadonlyArray<string> | undefined
  readonly allowedHeaders?: ReadonlyArray<string> | undefined
  readonly exposedHeaders?: ReadonlyArray<string> | undefined
  readonly maxAge?: number | undefined
  readonly credentials?: boolean | undefined
}): <E, R>(
  httpApp: Effect.Effect<HttpServerResponse, E, R>
) => Effect.Effect<HttpServerResponse, E, R | HttpServerRequest> => {
  const opts = {
    allowedOrigins: options?.allowedOrigins ?? [],
    allowedMethods: options?.allowedMethods ?? ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
    allowedHeaders: options?.allowedHeaders ?? [],
    exposedHeaders: options?.exposedHeaders ?? [],
    credentials: options?.credentials ?? false,
    maxAge: options?.maxAge
  }

  const isAllowedOrigin = typeof opts.allowedOrigins === "function"
    ? opts.allowedOrigins
    : (origin: string) => (opts.allowedOrigins as ReadonlyArray<string>).includes(origin)

  const allowOrigin = typeof opts.allowedOrigins === "function" || opts.allowedOrigins.length > 1
    ? ((originHeader: string) => {
      if (!isAllowedOrigin(originHeader)) return undefined
      return {
        "access-control-allow-origin": originHeader,
        vary: "Origin"
      }
    })
    : opts.allowedOrigins.length === 0
    ? constant({
      "access-control-allow-origin": "*"
    })
    : constant({
      "access-control-allow-origin": opts.allowedOrigins[0],
      vary: "Origin"
    })

  const allowMethods = opts.allowedMethods.length > 0
    ? { "access-control-allow-methods": opts.allowedMethods.join(", ") }
    : undefined

  const allowCredentials = opts.credentials
    ? { "access-control-allow-credentials": "true" }
    : undefined

  const allowHeaders = (
    accessControlRequestHeaders: string | undefined
  ): ReadonlyRecord<string, string> | undefined => {
    if (opts.allowedHeaders.length === 0 && accessControlRequestHeaders) {
      return {
        vary: "Access-Control-Request-Headers",
        "access-control-allow-headers": accessControlRequestHeaders
      }
    }

    if (opts.allowedHeaders) {
      return {
        "access-control-allow-headers": opts.allowedHeaders.join(",")
      }
    }

    return undefined
  }

  const exposeHeaders = opts.exposedHeaders.length > 0
    ? { "access-control-expose-headers": opts.exposedHeaders.join(",") }
    : undefined

  const maxAge = opts.maxAge
    ? { "access-control-max-age": opts.maxAge.toString() }
    : undefined

  const headersFromRequest = (request: HttpServerRequest) => {
    const origin = request.headers["origin"]
    return Headers.fromRecordUnsafe({
      ...allowOrigin(origin),
      ...allowCredentials,
      ...exposeHeaders
    })
  }

  const headersFromRequestOptions = (request: HttpServerRequest) => {
    const origin = request.headers["origin"]
    const accessControlRequestHeaders = request.headers["access-control-request-headers"]
    return Headers.fromRecordUnsafe({
      ...allowOrigin(origin),
      ...allowCredentials,
      ...exposeHeaders,
      ...allowMethods,
      ...allowHeaders(accessControlRequestHeaders),
      ...maxAge
    })
  }

  const preResponseHandler = (request: HttpServerRequest, response: HttpServerResponse) =>
    Effect.succeed(Response.setHeaders(response, headersFromRequest(request)))

  return <E, R>(
    httpApp: Effect.Effect<HttpServerResponse, E, R>
  ): Effect.Effect<HttpServerResponse, E, R | HttpServerRequest> =>
    Effect.withFiber((fiber) => {
      const request = Context.getUnsafe(fiber.context, HttpServerRequest)
      if (request.method === "OPTIONS") {
        return Effect.succeed(Response.empty({
          status: 204,
          headers: headersFromRequestOptions(request)
        }))
      }
      appendPreResponseHandlerUnsafe(request, preResponseHandler)
      return httpApp
    })
}
