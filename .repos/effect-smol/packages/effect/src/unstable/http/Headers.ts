/**
 * Immutable HTTP header collections for the unstable HTTP modules.
 *
 * This module defines the `Headers` data type used by HTTP client and server
 * request / response models. It converts records or iterables into a
 * predictable lowercase map, provides pipeable operations for reading and
 * updating header values, and integrates with inspection redaction so sensitive
 * header names can be masked before logging or serialization.
 *
 * ## Mental model
 *
 * A `Headers` value is a plain immutable record whose keys are normalized
 * header names and whose values are strings. Safe constructors and lookups
 * lowercase names because HTTP header names are case-insensitive, and
 * combinators return new `Headers` values instead of mutating the original
 * collection.
 *
 * ## Common tasks
 *
 * - Build headers from records or entry iterables with {@link fromInput}.
 * - Read values with {@link get} or check presence with {@link has}.
 * - Add, replace, merge, or remove headers with {@link set}, {@link setAll},
 *   {@link merge}, {@link remove}, and {@link removeMany}.
 * - Mask sensitive names before inspection with {@link redact} and
 *   {@link CurrentRedactedNames}.
 *
 * ## Gotchas
 *
 * Each lowercase header name stores one string. Record array values are joined
 * with `", "`, iterable input keeps the last value for duplicate names, and
 * later set / merge operations replace earlier values. This is convenient for
 * most headers but does not preserve repeated field lines such as `Set-Cookie`;
 * use cookie-specific HTTP modules when cookie multiplicity matters.
 *
 * **Example** (Normalize and update headers)
 *
 * ```ts
 * import { Option } from "effect"
 * import { Headers } from "effect/unstable/http"
 *
 * const headers = Headers.fromInput({
 *   "Content-Type": "application/json",
 *   accept: ["application/json", "text/plain"]
 * })
 *
 * const contentType = Headers.get(headers, "content-type")
 * if (Option.isSome(contentType)) {
 *   console.log(contentType.value)
 * }
 *
 * const next = Headers.set(headers, "authorization", "Bearer token")
 * console.log(Headers.has(next, "Authorization")) // true
 * ```
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Equal from "../../Equal.ts"
import * as Equ from "../../Equivalence.ts"
import { dual } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import * as Inspectable from "../../Inspectable.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import * as Record from "../../Record.ts"
import * as Redactable from "../../Redactable.ts"
import * as Redacted from "../../Redacted.ts"
import * as Schema from "../../Schema.ts"
import * as Transformation from "../../SchemaTransformation.ts"
import type { Mutable } from "../../Types.ts"

/**
 * Runtime type identifier for `Headers` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: unique symbol = Symbol.for("~effect/http/Headers")

/**
 * Type of the unique symbol used to brand `Headers` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = typeof TypeId

/**
 * Returns `true` if the provided value is a `Headers` value.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isHeaders = (u: unknown): u is Headers => Predicate.hasProperty(u, TypeId)

/**
 * Represents an immutable HTTP header collection keyed by lowercase header name.
 *
 * **Details**
 *
 * `Headers` values also support redaction through the `Redactable` protocol.
 *
 * @category models
 * @since 4.0.0
 */
export interface Headers extends Redactable.Redactable {
  readonly [TypeId]: TypeId
  readonly [key: string]: string
}

const Proto = Object.create(null)

Object.defineProperties(Proto, {
  [TypeId]: {
    value: TypeId
  },
  [Redactable.symbolRedactable]: {
    value(this: Headers, context: Context.Context<never>): Record<string, string | Redacted.Redacted<string>> {
      return redact(this, Context.get(context, CurrentRedactedNames))
    }
  },
  toJSON: {
    value(this: Headers) {
      return Redactable.redact(this)
    }
  },
  [Equal.symbol]: {
    value(this: Headers, that: Headers): boolean {
      return Equivalence(this, that)
    }
  },
  [Hash.symbol]: {
    value(this: Headers): number {
      return Hash.structure(this)
    }
  },
  toString: {
    value: Inspectable.BaseProto.toString
  },
  [Inspectable.NodeInspectSymbol]: {
    value: Inspectable.BaseProto[Inspectable.NodeInspectSymbol]
  }
})

const make = (input: Record.ReadonlyRecord<string, string>): Mutable<Headers> =>
  Object.assign(Object.create(Proto), input) as Headers

/**
 * Provides an `Equivalence` instance that compares `Headers` by header names
 * and string values.
 *
 * @category instances
 * @since 4.0.0
 */
export const Equivalence: Equ.Equivalence<Headers> = Record.makeEquivalence(Equ.strictEqual<string>())

/**
 * Schema interface for `Headers` values encoded as records of string header values.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface HeadersSchema extends Schema.declare<Headers, { readonly [x: string]: string }> {}

/**
 * Schema for `Headers` values encoded as records of string header values.
 *
 * **Details**
 *
 * Decoding normalizes header names through `fromInput`; encoding returns a plain record.
 *
 * @category schemas
 * @since 4.0.0
 */
export const HeadersSchema: HeadersSchema = Schema.declare(
  isHeaders,
  {
    typeConstructor: {
      _tag: "effect/http/Headers"
    },
    generation: {
      runtime: `Headers.HeadersSchema`,
      Type: `Headers.Headers`,
      Encoded: `typeof Headers.HeadersSchema["Encoded"]`,
      importDeclaration: `import * as Headers from "effect/unstable/http/Headers"`
    },
    expected: "Headers",
    toEquivalence: () => Equivalence,
    toCodec: () =>
      Schema.link<Headers>()(
        Schema.Record(Schema.String, Schema.String),
        Transformation.transform({
          decode: (input) => fromInput(input),
          encode: (headers) => ({ ...headers })
        })
      )
  }
)

/**
 * Input accepted when constructing headers.
 *
 * **Details**
 *
 * Records may contain string values, string arrays, or `undefined`; arrays are joined with `", "`, and `undefined` values are omitted.
 *
 * @category models
 * @since 4.0.0
 */
export type Input =
  | Record.ReadonlyRecord<string, string | ReadonlyArray<string> | undefined>
  | Iterable<readonly [string, string]>

/**
 * An empty `Headers` collection.
 *
 * @category constructors
 * @since 4.0.0
 */
export const empty: Headers = Object.create(Proto)

/**
 * Creates `Headers` from a record or iterable of header entries.
 *
 * **Details**
 *
 * Header names are normalized to lowercase. Array values in record input are joined with `", "`, and `undefined` values are omitted.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromInput: (input?: Input) => Headers = (input) => {
  if (input === undefined) {
    return empty
  } else if (Symbol.iterator in input) {
    const out: Record<string, string> = Object.create(Proto)
    for (const [k, v] of input) {
      out[k.toLowerCase()] = v
    }
    return out as Headers
  }
  const out: Record<string, string> = Object.create(Proto)
  for (const [k, v] of Object.entries(input)) {
    if (Array.isArray(v)) {
      out[k.toLowerCase()] = v.join(", ")
    } else if (v !== undefined) {
      out[k.toLowerCase()] = v as string
    }
  }
  return out as Headers
}

/**
 * Treats an existing record as `Headers` unsafely.
 *
 * **Gotchas**
 *
 * This mutates the record's prototype and does not normalize header names; callers must provide the expected lowercase keys.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromRecordUnsafe = (input: Record.ReadonlyRecord<string, string>): Headers =>
  Object.setPrototypeOf(input, Proto) as Headers

/**
 * Returns `true` when a header with the given name is present.
 *
 * **Details**
 *
 * The lookup lowercases the provided header name.
 *
 * @category combinators
 * @since 4.0.0
 */
export const has: {
  (key: string): (self: Headers) => boolean
  (self: Headers, key: string): boolean
} = dual<
  (key: string) => (self: Headers) => boolean,
  (self: Headers, key: string) => boolean
>(2, (self, key) => key.toLowerCase() in self)

/**
 * Gets a header value by name safely.
 *
 * **Details**
 *
 * The lookup lowercases the provided header name and returns `Option.none()` when absent.
 *
 * @category combinators
 * @since 4.0.0
 */
export const get: {
  (key: string): (self: Headers) => Option.Option<string>
  (self: Headers, key: string): Option.Option<string>
} = dual<
  (key: string) => (self: Headers) => Option.Option<string>,
  (self: Headers, key: string) => Option.Option<string>
>(2, (self, key) => Option.fromUndefinedOr(self[key.toLowerCase()]))

/**
 * Returns a new `Headers` collection with the given header set.
 *
 * **Details**
 *
 * The header name is normalized to lowercase.
 *
 * @category combinators
 * @since 4.0.0
 */
export const set: {
  (key: string, value: string): (self: Headers) => Headers
  (self: Headers, key: string, value: string): Headers
} = dual<
  (key: string, value: string) => (self: Headers) => Headers,
  (self: Headers, key: string, value: string) => Headers
>(3, (self, key, value) => {
  const out = make(self)
  out[key.toLowerCase()] = value
  return out
})

/**
 * Returns a new `Headers` collection with all provided headers set.
 *
 * **Details**
 *
 * Input headers are normalized with `fromInput` and override existing headers with the same lowercase name.
 *
 * @category combinators
 * @since 4.0.0
 */
export const setAll: {
  (headers: Input): (self: Headers) => Headers
  (self: Headers, headers: Input): Headers
} = dual<
  (headers: Input) => (self: Headers) => Headers,
  (self: Headers, headers: Input) => Headers
>(2, (self, headers) =>
  make({
    ...self,
    ...fromInput(headers)
  }))

/**
 * Returns a new `Headers` collection containing headers from both collections.
 *
 * **Details**
 *
 * Headers from the second collection override headers from the first collection with the same name.
 *
 * @category combinators
 * @since 4.0.0
 */
export const merge: {
  (headers: Headers): (self: Headers) => Headers
  (self: Headers, headers: Headers): Headers
} = dual<
  (headers: Headers) => (self: Headers) => Headers,
  (self: Headers, headers: Headers) => Headers
>(2, (self, headers) => {
  const out = make(self)
  Object.assign(out, headers)
  return out
})

/**
 * Returns a new `Headers` collection with the named header removed.
 *
 * **Details**
 *
 * The provided header name is normalized to lowercase before removal.
 *
 * @category combinators
 * @since 4.0.0
 */
export const remove: {
  (key: string): (self: Headers) => Headers
  (self: Headers, key: string): Headers
} = dual<
  (key: string) => (self: Headers) => Headers,
  (self: Headers, key: string) => Headers
>(2, (self, key) => {
  const out = make(self)
  delete out[key.toLowerCase()]
  return out
})

/**
 * Returns a new `Headers` collection with each named header removed.
 *
 * **Details**
 *
 * Each provided header name is normalized to lowercase before removal.
 *
 * @category combinators
 * @since 4.0.0
 */
export const removeMany: {
  (keys: Iterable<string>): (self: Headers) => Headers
  (self: Headers, keys: Iterable<string>): Headers
} = dual<
  (keys: Iterable<string>) => (self: Headers) => Headers,
  (self: Headers, keys: Iterable<string>) => Headers
>(2, (self, keys) => {
  const out = make(self)
  for (const key of keys) {
    delete out[key.toLowerCase()]
  }
  return out
})

/**
 * Returns a plain record with selected header values wrapped in `Redacted`.
 *
 * **Details**
 *
 * String keys are normalized to lowercase before matching; regular expressions are tested against the stored header names.
 *
 * @category combinators
 * @since 4.0.0
 */
export const redact: {
  (
    key: string | RegExp | ReadonlyArray<string | RegExp>
  ): (self: Headers) => Record<string, string | Redacted.Redacted>
  (
    self: Headers,
    key: string | RegExp | ReadonlyArray<string | RegExp>
  ): Record<string, string | Redacted.Redacted>
} = dual(
  2,
  (
    self: Headers,
    key: string | RegExp | ReadonlyArray<string | RegExp>
  ): Record<string, string | Redacted.Redacted> => {
    const out: Record<string, string | Redacted.Redacted> = { ...self }
    const modify = (key: string | RegExp) => {
      if (typeof key === "string") {
        const k = key.toLowerCase()
        if (k in self) {
          out[k] = Redacted.make(self[k])
        }
      } else {
        for (const name in self) {
          if (key.test(name)) {
            out[name] = Redacted.make(self[name])
          }
        }
      }
    }
    if (Array.isArray(key)) {
      for (let i = 0; i < key.length; i++) {
        modify(key[i])
      }
    } else {
      modify(key as string | RegExp)
    }
    return out
  }
)

/**
 * Context reference listing header names or patterns that should be redacted when `Headers` are inspected or rendered.
 *
 * **Details**
 *
 * Defaults include `authorization`, `cookie`, `set-cookie`, and `x-api-key`.
 *
 * @category fiber refs
 * @since 4.0.0
 */
export const CurrentRedactedNames = Context.Reference<
  ReadonlyArray<string | RegExp>
>("effect/Headers/CurrentRedactedNames", {
  defaultValue: () => [
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key"
  ]
})
