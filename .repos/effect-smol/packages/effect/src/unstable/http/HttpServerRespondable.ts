/**
 * Protocol for values that can render themselves as HTTP server responses.
 *
 * This module lets server-side domain errors, HTTP API errors, and helper
 * values describe the response they should send to a client. Implement
 * `Respondable` when a value should choose its own status, headers, cookies, or
 * body during route error handling without forcing every call site to construct
 * an `HttpServerResponse` directly.
 *
 * **Mental model**
 *
 * A respondable value owns the last step from domain-level information to an
 * `HttpServerResponse`. Server error handling can ask the value for a response,
 * while unknown failures still go through a caller-provided fallback response.
 * Existing `HttpServerResponse` values are already respondable for conversion
 * purposes and are returned directly.
 *
 * **Common tasks**
 *
 * Use `toResponse` when the value is known to implement the protocol and
 * conversion failures should become defects. Use `toResponseOrElse` when
 * handling unknown failures from route effects and a fallback response should be
 * used when no conversion is available. Use `toResponseOrElseDefect` for defect
 * recovery, where only explicit response-like values receive special handling.
 *
 * **Gotchas**
 *
 * Fallback conversion is intentionally conservative. Schema errors become `400`
 * responses, no-such-element errors become `404` responses, and other values use
 * the supplied fallback. The fallback helpers also catch failures raised while
 * running a respondable conversion; `toResponse` does not.
 *
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"
import type { HttpServerResponse } from "./HttpServerResponse.ts"
import * as Response from "./HttpServerResponse.ts"

/**
 * Protocol key used by values that can render themselves as
 * `HttpServerResponse` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const symbol = "~effect/http/HttpServerRespondable"

/**
 * Protocol for values that can be converted into an `HttpServerResponse`.
 *
 * **Details**
 *
 * Implement the protocol method to describe the response that should be sent for
 * the value.
 *
 * @category models
 * @since 4.0.0
 */
export interface Respondable {
  [symbol](): Effect.Effect<HttpServerResponse, unknown>
}

/**
 * Returns `true` when the supplied value implements the `Respondable` protocol.
 *
 * @category guards
 * @since 4.0.0
 */
export const isRespondable = (u: unknown): u is Respondable => hasProperty(u, symbol)

const badRequest = Response.empty({ status: 400 })
const notFound = Response.empty({ status: 404 })

/**
 * Converts a `Respondable` value into an `HttpServerResponse`.
 *
 * **Details**
 *
 * If the value is already an HTTP server response it is returned directly; errors
 * from the response conversion are converted to defects.
 *
 * @category accessors
 * @since 4.0.0
 */
export const toResponse = (self: Respondable): Effect.Effect<HttpServerResponse> => {
  if (Response.isHttpServerResponse(self)) {
    return Effect.succeed(self)
  }
  return Effect.orDie(self[symbol]())
}

/**
 * Attempts to convert an unknown value into an `HttpServerResponse`, falling back
 * to the supplied response when no conversion is available.
 *
 * **Details**
 *
 * `HttpServerResponse` and `Respondable` values are used directly, schema errors
 * become `400` responses, and no-such-element errors become `404` responses.
 *
 * @category accessors
 * @since 4.0.0
 */
export const toResponseOrElse = (u: unknown, orElse: HttpServerResponse): Effect.Effect<HttpServerResponse> => {
  if (Response.isHttpServerResponse(u)) {
    return Effect.succeed(u)
  } else if (isRespondable(u)) {
    return Effect.catchCause(u[symbol](), () => Effect.succeed(orElse))
    // add support for some commmon types
  } else if (Schema.isSchemaError(u)) {
    return Effect.succeed(badRequest)
  } else if (Cause.isNoSuchElementError(u)) {
    return Effect.succeed(notFound)
  }
  return Effect.succeed(orElse)
}

/**
 * Attempts to convert an unknown defect into an `HttpServerResponse`, falling
 * back to the supplied response when no conversion is available.
 *
 * **Details**
 *
 * Only `HttpServerResponse` and `Respondable` values receive special handling.
 *
 * @category accessors
 * @since 4.0.0
 */
export const toResponseOrElseDefect = (u: unknown, orElse: HttpServerResponse): Effect.Effect<HttpServerResponse> => {
  if (Response.isHttpServerResponse(u)) {
    return Effect.succeed(u)
  } else if (isRespondable(u)) {
    return Effect.catchCause(u[symbol](), () => Effect.succeed(orElse))
  }
  return Effect.succeed(orElse)
}
