import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { TestClock } from "effect/testing";

export function provideDeterministicTestRuntime<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly randomSeed?: number } = {},
) {
  return effect.pipe(
    Effect.provide(TestClock.layer()),
    Random.withSeed(options.randomSeed ?? 0x1234_5678),
  );
}
