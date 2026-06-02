/**
 * HTTP method literals and helpers shared by the unstable HTTP client, server,
 * and routing APIs.
 *
 * This module keeps the supported method vocabulary in one place: the
 * {@link HttpMethod} union, {@link all} set, {@link allShort} mapping,
 * {@link hasBody} body classification helper, and {@link isHttpMethod} runtime
 * refinement. Values are uppercase string literals such as `"GET"` and
 * `"POST"`, matching the method tokens used by the HTTP APIs in this package.
 *
 * **Mental model**
 *
 * {@link HttpMethod} is the complete set this module recognizes.
 * {@link HttpMethod.NoBody} is the subset treated as bodyless (`GET`, `HEAD`,
 * `OPTIONS`, and `TRACE`), and {@link HttpMethod.WithBody} is the remaining
 * subset accepted by request builders that can carry a body.
 *
 * **Common tasks**
 *
 * Use {@link isHttpMethod} before accepting an unknown value as an HTTP method,
 * {@link hasBody} to narrow a method before attaching a body, {@link all} for
 * membership checks or iteration, and {@link allShort} when deriving the short
 * constructor names used by request helpers.
 *
 * **Gotchas**
 *
 * Lowercase method names are not valid {@link HttpMethod} values. The body
 * split is a typed helper convention, not a full statement of every
 * wire-protocol edge case: `DELETE` is treated as able to carry a body, while
 * `GET` helpers are treated as bodyless even though some systems may send a
 * body on the wire.
 *
 * @since 4.0.0
 */

/**
 * Union of supported uppercase HTTP method literals.
 *
 * @category models
 * @since 4.0.0
 */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "TRACE"

/**
 * Namespace containing subtype helpers associated with `HttpMethod`.
 *
 * @since 4.0.0
 */
export declare namespace HttpMethod {
  /**
   * HTTP methods that this module treats as not carrying a request body.
   *
   * @category models
   * @since 4.0.0
   */
  export type NoBody = "GET" | "HEAD" | "OPTIONS" | "TRACE"

  /**
   * HTTP methods that this module treats as capable of carrying a request body.
   *
   * @category models
   * @since 4.0.0
   */
  export type WithBody = Exclude<HttpMethod, NoBody>
}

/**
 * Returns `true` when a method can carry a request body and narrows it to `HttpMethod.WithBody`.
 *
 * @category predicates
 * @since 4.0.0
 */
export const hasBody = (method: HttpMethod): method is HttpMethod.WithBody =>
  method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && method !== "TRACE"

/**
 * Provides a readonly set containing every supported `HttpMethod` literal.
 *
 * **When to use**
 *
 * Use when you need to iterate over or test membership against every supported
 * HTTP method literal.
 *
 * @category constants
 * @since 4.0.0
 */
export const all: ReadonlySet<HttpMethod> = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE"
])

/**
 * Provides tuples mapping each supported HTTP method to its short
 * request-constructor name.
 *
 * **When to use**
 *
 * Use when you need the mapping from supported HTTP method literals to their
 * short request-constructor names.
 *
 * @category constants
 * @since 4.0.0
 */
export const allShort = [
  ["GET", "get"],
  ["POST", "post"],
  ["PUT", "put"],
  ["DELETE", "del"],
  ["PATCH", "patch"],
  ["HEAD", "head"],
  ["OPTIONS", "options"],
  ["TRACE", "trace"]
] as const

/**
 * Checks whether a value is a `HttpMethod`.
 *
 * **Example** (Checking HTTP method values)
 *
 * ```ts
 * import { HttpMethod } from "effect/unstable/http"
 *
 * console.log(HttpMethod.isHttpMethod("GET"))
 * // true
 * console.log(HttpMethod.isHttpMethod("get"))
 * // false
 * console.log(HttpMethod.isHttpMethod(1))
 * // false
 * ```
 *
 * @category refinements
 * @since 4.0.0
 */
export const isHttpMethod = (u: unknown): u is HttpMethod => all.has(u as HttpMethod)
