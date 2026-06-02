/**
 * Accessors for the Node.js objects backing a platform Node
 * `HttpServerRequest`.
 *
 * Use this module at interop boundaries when an Effect HTTP handler needs the
 * original `http.IncomingMessage` or `http.ServerResponse` for APIs that are
 * specific to Node, such as existing middleware, socket inspection, raw stream
 * piping, or response customization that cannot be expressed with the portable
 * `HttpServerRequest` and `HttpServerResponse` interfaces.
 *
 * The returned request is the original Node request supplied to the server. It
 * does not reflect Effect request overrides made by middleware, such as a
 * rewritten URL, adjusted headers, or a substituted remote address. Its body is
 * also Node's one-shot readable stream, so avoid mixing raw stream consumption
 * with Effect body, multipart, or stream helpers unless ownership of the body
 * is clear. The returned response is the Node response owned by the platform
 * server; writing to it directly bypasses the usual Effect response writer and
 * must be coordinated carefully to avoid duplicate writes. Upgrade requests may
 * create that response lazily when it is first requested.
 *
 * @since 4.0.0
 */
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import type * as Http from "node:http"

/**
 * Returns the underlying Node `IncomingMessage` for a platform Node
 * `HttpServerRequest`.
 *
 * @category accessors
 * @since 4.0.0
 */
export const toIncomingMessage = (self: HttpServerRequest): Http.IncomingMessage => self.source as any

/**
 * Returns the underlying Node `ServerResponse` for a platform Node
 * `HttpServerRequest`, evaluating the stored response thunk when the response
 * was created lazily.
 *
 * @category accessors
 * @since 4.0.0
 */
export const toServerResponse = (self: HttpServerRequest): Http.ServerResponse => {
  const res = (self as any).response
  return typeof res === "function" ? res() : res
}
