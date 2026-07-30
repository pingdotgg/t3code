/**
 * Formats JavaScript values into readable strings.
 *
 * `format` is intended for logs, diagnostics, and error messages. It handles
 * primitives, objects, arrays, dates, regular expressions, maps, sets, class
 * instances, errors, circular references, and redactable values. `formatJson`
 * wraps JSON formatting with redaction and circular-reference handling, and the
 * module also includes helpers for property keys, paths, and dates.
 *
 * @since 4.0.0
 */
import * as Predicate from "./Predicate.ts"
import { getRedacted, redact, symbolRedactable } from "./Redactable.ts"

/**
 * A callable interface representing a function that converts a `Value` into a `Format`, which defaults to `string`.
 *
 * **When to use**
 *
 * Use when you want to type a formatting or rendering function generically, or when you are building a pipeline that accepts pluggable formatters.
 *
 * **Details**
 *
 * This is a pure callable type and carries no runtime implementation. It is contravariant in `Value` and covariant in `Format`.
 *
 * **Example** (Defining a custom formatter)
 *
 * ```ts
 * import type { Formatter } from "effect"
 *
 * const upper: Formatter.Formatter<string> = (s) => s.toUpperCase()
 *
 * console.log(upper("hello"))
 * // HELLO
 * ```
 *
 * @see {@link format}
 * @see {@link formatJson}
 * @category models
 * @since 4.0.0
 */
export interface Formatter<in Value, out Format = string> {
  (value: Value): Format
}

/**
 * Converts any JavaScript value into a human-readable string.
 *
 * **When to use**
 *
 * Use when you need to format arbitrary JavaScript values for debugging,
 * logging, or error messages.
 *
 * **Details**
 *
 * - Output is **not** valid JSON; use {@link formatJson} when you need
 *   parseable JSON.
 * - Handles `BigInt`, `Symbol`, `Set`, `Map`, `Date`, `RegExp`, and class
 *   instances that `JSON.stringify` cannot represent.
 * - Circular references are shown as `"[Circular]"` instead of throwing.
 * - Primitives: stringified naturally (`null`, `undefined`, `123`, `true`).
 *   Strings are JSON-quoted.
 * - Objects with a custom `toString` (not `Object.prototype.toString`):
 *   `toString()` is called unless `ignoreToString` is `true`.
 * - Errors with a `cause`: formatted as `"<message> (cause: <cause>)"`.
 * - Iterables (`Set`, `Map`, etc.): formatted as
 *   `ClassName([...elements])`.
 * - Class instances: wrapped as `ClassName({...})`.
 * - `Redactable` values are automatically redacted.
 * - Arrays/objects with 0–1 entries are inline; larger ones are
 *   pretty-printed when `space` is set.
 * - `space` — indentation unit (number of spaces, or a string like
 *   `"\t"`). Defaults to `0` (compact).
 * - `ignoreToString` — skip calling `toString()`. Defaults to `false`.
 *
 * **Example** (Formatting compact output)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.format({ a: 1, b: [2, 3] }))
 * // {"a":1,"b":[2,3]}
 * ```
 *
 * **Example** (Pretty-printed output)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.format({ a: 1, b: [2, 3] }, { space: 2 }))
 * // {
 * //   "a": 1,
 * //   "b": [
 * //     2,
 * //     3
 * //   ]
 * // }
 * ```
 *
 * **Example** (Handling circular references)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * const obj: any = { name: "loop" }
 * obj.self = obj
 * console.log(Formatter.format(obj))
 * // {"name":"loop","self":[Circular]}
 * ```
 *
 * @see {@link formatJson}
 * @see {@link Formatter}
 * @category formatting
 * @since 2.0.0
 */
export function format(input: unknown, options?: {
  readonly space?: number | string | undefined
  readonly ignoreToString?: boolean | undefined
}): string {
  const space = options?.space ?? 0
  const seen = new WeakSet<object>()
  const gap = !space ? "" : (typeof space === "number" ? " ".repeat(space) : space)
  const ind = (d: number) => gap.repeat(d)

  const wrap = (v: unknown, body: string): string => {
    const ctor = (v as any)?.constructor
    return ctor && ctor !== Object.prototype.constructor && ctor.name ? `${ctor.name}(${body})` : body
  }

  const ownKeys = (o: object): Array<PropertyKey> => {
    try {
      return Reflect.ownKeys(o)
    } catch {
      return ["[ownKeys threw]"]
    }
  }

  function recur(v: unknown, d = 0): string {
    if (Array.isArray(v)) {
      if (seen.has(v)) return CIRCULAR
      seen.add(v)
      if (!gap || v.length <= 1) return `[${v.map((x) => recur(x, d)).join(",")}]`
      const inner = v.map((x) => recur(x, d + 1)).join(",\n" + ind(d + 1))
      return `[\n${ind(d + 1)}${inner}\n${ind(d)}]`
    }

    if (v instanceof Date) return formatDate(v)

    if (
      !options?.ignoreToString &&
      Predicate.hasProperty(v, "toString") &&
      typeof v["toString"] === "function" &&
      v["toString"] !== Object.prototype.toString &&
      v["toString"] !== Array.prototype.toString
    ) {
      const s = safeToString(v)
      if (v instanceof Error && v.cause) {
        return `${s} (cause: ${recur(v.cause, d)})`
      }
      return s
    }

    if (typeof v === "string") return JSON.stringify(v)

    if (
      typeof v === "number" ||
      v == null ||
      typeof v === "boolean" ||
      typeof v === "symbol"
    ) return String(v)

    if (typeof v === "bigint") return String(v) + "n"

    if (typeof v === "object" || typeof v === "function") {
      if (seen.has(v)) return CIRCULAR
      seen.add(v)

      if (symbolRedactable in v) return format(getRedacted(v as any))

      if (Symbol.iterator in v) {
        return `${v.constructor.name}(${recur(Array.from(v as any), d)})`
      }

      const keys = ownKeys(v)
      if (!gap || keys.length <= 1) {
        const body = `{${keys.map((k) => `${formatPropertyKey(k)}:${recur((v as any)[k], d)}`).join(",")}}`
        return wrap(v, body)
      }
      const body = `{\n${
        keys.map((k) => `${ind(d + 1)}${formatPropertyKey(k)}: ${recur((v as any)[k], d + 1)}`).join(",\n")
      }\n${ind(d)}}`
      return wrap(v, body)
    }

    return String(v)
  }

  return recur(input, 0)
}

const CIRCULAR = "[Circular]"

/**
 * @internal
 */
export function formatPropertyKey(name: PropertyKey): string {
  return typeof name === "string" ? JSON.stringify(name) : String(name)
}

/**
 * Formats an array of property keys as a bracket-notation path string.
 *
 * @internal
 */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map((key) => `[${formatPropertyKey(key)}]`).join("")
}

/**
 * Formats a `Date` as an ISO 8601 string, returning `"Invalid Date"` for
 * invalid dates instead of throwing.
 *
 * @internal
 */
export function formatDate(date: Date): string {
  try {
    return date.toISOString()
  } catch {
    return "Invalid Date"
  }
}

function safeToString(input: any): string {
  try {
    const s = input.toString()
    return typeof s === "string" ? s : String(s)
  } catch {
    return "[toString threw]"
  }
}

/**
 * Stringifies a value to JSON safely, silently dropping circular references.
 *
 * **When to use**
 *
 * Use when you need valid JSON output, unlike `format`, and the input may
 * contain circular references that should be silently omitted rather than
 * throwing a `TypeError`.
 *
 * **Details**
 *
 * Uses `JSON.stringify` internally with a replacer that tracks the current
 * object ancestry. Circular references are replaced with `undefined`, which
 * omits them from object output. `Redactable` values are automatically redacted
 * before serialization. Values not supported by JSON, such as `BigInt`,
 * `Symbol`, `undefined`, and functions, follow standard `JSON.stringify`
 * behavior. The `space` parameter controls indentation and defaults to `0`.
 *
 * **Example** (Formatting compact JSON)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.formatJson({ name: "Alice", age: 30 }))
 * // {"name":"Alice","age":30}
 * ```
 *
 * **Example** (Handling circular references)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * const obj: any = { name: "test" }
 * obj.self = obj
 * console.log(Formatter.formatJson(obj))
 * // {"name":"test"}
 * ```
 *
 * **Example** (Pretty-printed JSON)
 *
 * ```ts
 * import { Formatter } from "effect"
 *
 * console.log(Formatter.formatJson({ name: "Alice", age: 30 }, { space: 2 }))
 * // {
 * //   "name": "Alice",
 * //   "age": 30
 * // }
 * ```
 *
 * @see {@link format}
 * @see {@link Formatter}
 * @category serialization
 * @since 4.0.0
 */
export function formatJson(input: unknown, options?: {
  readonly space?: number | string | undefined
}): string {
  const ancestors: Array<object> = []
  return JSON.stringify(
    input,
    function(this: unknown, _key: string, value: unknown) {
      const redacted = redact(value)
      if (typeof redacted !== "object" || redacted === null) {
        return redacted
      }
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop()
      }
      if (ancestors.includes(redacted)) {
        return undefined // circular reference
      }
      ancestors.push(redacted)
      return redacted
    },
    options?.space
  )
}
