/**
 * A radix-tree HTTP router used by the unstable HTTP routing modules.
 *
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
 * @since 4.0.0
 * @category models
 */
export interface RouterConfig {
  readonly ignoreTrailingSlash: boolean
  readonly ignoreDuplicateSlashes: boolean
  readonly caseSensitive: boolean
  readonly maxParamLength: number
}

/**
 * @since 4.0.0
 * @category models
 */
export type PathInput = `/${string}` | "*"

/**
 * @since 4.0.0
 * @category models
 */
export interface Router<A> {
  readonly on: (method: string | Iterable<string>, path: PathInput, handler: A) => void
  readonly all: (path: PathInput, handler: A) => void
  readonly find: (method: string, url: string) => FindResult<A> | undefined
  readonly has: (method: string, url: string) => boolean
}

/**
 * @since 4.0.0
 * @category models
 */
export interface FindResult<A> {
  readonly handler: A
  readonly params: Record<string, string | undefined>
  readonly searchParams: Record<string, string | Array<string>>
}

/**
 * @since 4.0.0
 * @category constructors
 */
export const make: <A>(options?: Partial<RouterConfig>) => Router<A> = internal.make
