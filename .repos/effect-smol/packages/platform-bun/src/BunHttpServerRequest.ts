/**
 * Accessors for the Bun `Request` object backing a platform Bun
 * `HttpServerRequest`.
 *
 * Use this module at interop boundaries when an Effect HTTP handler needs the
 * original `Bun.BunRequest`, for example to read Bun route parameters, pass the
 * request to Bun-specific APIs, inspect Web `Request` fields that are not
 * exposed by the portable `HttpServerRequest` interface, or coordinate with code
 * that already works directly with Bun's server request type.
 *
 * The returned request is the original Web request supplied by `Bun.serve`. It
 * does not reflect Effect request overrides made by middleware, such as a
 * rewritten URL, adjusted headers, or a substituted remote address. Its body is
 * the same one-shot Web `ReadableStream` used by the Effect body helpers, so
 * calling `text`, `json`, `formData`, `arrayBuffer`, or reading `body` directly
 * can disturb the request and conflict with Effect body, multipart, or stream
 * helpers unless ownership of the body is clear.
 *
 * Bun stores client IP information on the server rather than on the request
 * object. Prefer `HttpServerRequest.remoteAddress` when you need the address
 * seen by Effect or middleware; the raw request returned here will not expose
 * middleware-provided remote address overrides.
 *
 * @since 4.0.0
 */
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"

/**
 * Returns the underlying `Bun.BunRequest` from an Effect `HttpServerRequest`.
 *
 * @category accessors
 * @since 4.0.0
 */
export const toBunServerRequest = <T extends string = string>(self: HttpServerRequest): Bun.BunRequest<T> =>
  (self as any).source
