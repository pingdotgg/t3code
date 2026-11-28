/**
 * A radix-tree HTTP router used by the unstable HTTP routing modules.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as internal from "./FindMyWay/internal/router.ts"

/*
 * MIT License
 *
 * Copyright (c) 2017-2019 Tomas Della Vedova
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * Configuration for router path matching.
 *
 * **Details**
 *
 * Each field is independent. Omitted fields use the default listed on the
 * field. The defaults normalize request paths before matching; use
 * {@link strictConfig} to turn normalization off and match static route text
 * literally.
 *
 * **Gotchas**
 *
 * Normalization options change which request paths reach a route. If a
 * reverse proxy or gateway makes access decisions from the raw path, the
 * router may resolve a request that the proxy saw as a different path. The
 * router sees the path delivered by the platform adapter: Web `Request`
 * adapters have already resolved dot segments, while Node passes the request
 * target through unchanged.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface RouterConfig {
  /**
   * Treats `/a/` and `/a` as the same path.
   *
   * @default true
   */
  readonly ignoreTrailingSlash: boolean
  /**
   * Collapses repeated `/` characters in the path.
   *
   * @default true
   */
  readonly ignoreDuplicateSlashes: boolean
  /**
   * Compares route text with letter case preserved. Parameter values keep
   * their case either way.
   *
   * @default false
   */
  readonly caseSensitive: boolean
  /**
   * Maximum length of a decoded path parameter. Longer values do not match.
   *
   * @default 100
   */
  readonly maxParamLength: number
  /**
   * Ends the path at the first `;`, as well as at `?` and `#`, and parses the
   * rest as the query string. When `false`, `;` is an ordinary path
   * character.
   *
   * @default true
   * @since 4.0.0
   */
  readonly useSemicolonDelimiter?: boolean | undefined
  /**
   * Percent-decodes the whole request path before matching. When `false`,
   * a route segment without parameters only matches the same characters in
   * the request path, so `/%73ecret` does not match `/secret`.
   *
   * **Details**
   *
   * With `false`, route text is stored as written: register `/caf%C3%A9` to
   * match a request for `/caf%C3%A9`. In each segment, the text before the
   * first parameter or wildcard is compared with the request path as
   * received. From a parameter to the end of its segment, or from a wildcard
   * to the end of the path, the request text is decoded once and then
   * matched, so `/files/pre-:name.png` matches `/files/pre-a%2Epng` but not
   * `/files/%70re-a.png`. A malformed escape in that decoded part does not
   * match.
   *
   * @default true
   * @since 4.0.0
   */
  readonly decodeStaticPath?: boolean | undefined
}

/**
 * Router configuration that turns off path normalization and matches static
 * route text literally.
 *
 * **When to use**
 *
 * Use when a reverse proxy or gateway authorizes requests by path prefix and
 * the router must not resolve a different spelling of that path to a route.
 *
 * **Details**
 *
 * It sets `caseSensitive: true`, `ignoreTrailingSlash: false`,
 * `ignoreDuplicateSlashes: false`, `useSemicolonDelimiter: false`, and
 * `decodeStaticPath: false`. A route then matches only when each of its
 * segments without parameters, and the text before the first parameter in
 * each other segment, appears character for character in the request path.
 * Spread it to override individual fields.
 *
 * **Gotchas**
 *
 * Parameter values are still percent-decoded, so a path rule that overlaps a
 * parameter segment, such as `/files/secret` against `/files/:name`, can
 * still be reached as `/files/%73ecret`. Encoded separators such as `%2F` in
 * parameter values are decoded too, and text after a parameter in the same
 * segment is matched after decoding, so `/files/:name.png` also matches
 * `/files/a%2Epng`.
 *
 * @see {@link RouterConfig}
 * @stability unstable
 * @category constants
 * @since 4.0.0
 */
export const strictConfig: Partial<RouterConfig> = {
  caseSensitive: true,
  ignoreTrailingSlash: false,
  ignoreDuplicateSlashes: false,
  useSemicolonDelimiter: false,
  decodeStaticPath: false
}

/**
 * Route path accepted by the router.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type PathInput = `/${string}` | "*"

/**
 * Mutable router used to register and resolve route handlers.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Router<A> {
  readonly on: (method: string | Iterable<string>, path: PathInput, handler: A) => void
  readonly all: (path: PathInput, handler: A) => void
  readonly find: (method: string, url: string) => FindResult<A> | undefined
  readonly has: (method: string, url: string) => boolean
}

/**
 * Result of a successful route lookup.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface FindResult<A> {
  readonly handler: A
  readonly params: Record<string, string | undefined>
  readonly searchParams: Record<string, string | Array<string>>
}

/**
 * Creates an empty mutable router.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make: <A>(options?: Partial<RouterConfig>) => Router<A> = internal.make
