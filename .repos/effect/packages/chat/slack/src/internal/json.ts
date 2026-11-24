import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

/** @internal */
export type JsonObject = { readonly [key: string]: Schema.Json }

/** `Predicate.isObject`, narrowed to the JSON a payload holds. @internal */
export const isObject = (u: unknown): u is JsonObject => Predicate.isObject(u)

const field = (object: unknown, key: string): unknown => isObject(object) ? object[key] : undefined

/** A non-empty string field of `object`, when it is an object. @internal */
export const string = (object: unknown, key: string): string | undefined => {
  const value = field(object, key)
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** An object field of `object`, when it is an object. @internal */
export const object = (object: unknown, key: string): JsonObject | undefined => {
  const value = field(object, key)
  return isObject(value) ? value : undefined
}

/** The parsed JSON, or `undefined` when `text` is not JSON. @internal */
export const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** An own property, so a key such as `__proto__` stays a field. @internal */
export const setOwn = (record: Record<string, string>, key: string, value: string) =>
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true })
