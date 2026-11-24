/**
 * Readers for untrusted input: fields of parsed JSON, and URLs.
 */
import * as Predicate from "effect/Predicate"
import type * as Schema from "effect/Schema"

/** @internal */
export type JsonObject = { readonly [key: string]: Schema.Json }

/** @internal */
export const isObject = (u: unknown): u is JsonObject => Predicate.isObject(u)

/** A non-empty string field of `value`, when `value` is an object. @internal */
export const string = (value: unknown, key: string): string | undefined => {
  const field = isObject(value) ? value[key] : undefined
  return typeof field === "string" && field.length > 0 ? field : undefined
}

/** An object field of `value`, when `value` is an object. @internal */
export const object = (value: unknown, key: string): JsonObject | undefined => {
  const field = isObject(value) ? value[key] : undefined
  return isObject(field) ? field : undefined
}

/** The JSON value of `text`, or `undefined` when it is not JSON. @internal */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** @internal */
export const parseUrl = (input: string, base?: string): URL | undefined => {
  try {
    return new URL(input, base)
  } catch {
    return undefined
  }
}
