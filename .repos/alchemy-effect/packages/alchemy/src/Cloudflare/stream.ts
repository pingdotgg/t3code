import type * as runtime from "@cloudflare/workers-types";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

type ReplaceEffectStream<T> =
  T extends Stream.Stream<any> ? runtime.ReadableStream<any> : T;

/**
 * If the value is an Effect stream, converts it to a ReadableStream.
 * Otherwise, returns the value unchanged.
 */
export function replaceEffectStream<T>(value: T): ReplaceEffectStream<T> {
  if (isEffectStream(value)) {
    return Stream.toReadableStream(value) as ReplaceEffectStream<T>;
  }
  return value as ReplaceEffectStream<T>;
}

const isEffectStream = (value: unknown): value is Stream.Stream<any> =>
  Predicate.hasProperty(value, "~effect/Stream");
