import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

export class PredicateFailed extends Data.TaggedError("PredicateFailed")<{
  message: string;
  actual: unknown;
}> {}

export const isPredicateFailed = (e: unknown): e is PredicateFailed =>
  Predicate.isTagged(e, "PredicateFailed");

/**
 * Retries an effect until a predicate is met.
 * @param input - The input to the poll function.
 * @param input.description - The description of what is being polled; used in the error message if the predicate fails.
 * @param input.effect - The effect to execute until the predicate is met.
 * @param input.predicate - The predicate to check if the effect has met the desired state.
 * @param input.schedule - The schedule to use for retries; defaults to every 3 seconds.
 * @param input.times - The maximum number of times to poll; defaults to 50.
 * @returns The value that satisfies the predicate.
 */
export const poll = Effect.fn("poll")(
  <A, E, R>(input: {
    description?: string;
    effect: Effect.Effect<A, E, R>;
    predicate: (value: A) => boolean;
    schedule?: Schedule.Schedule<unknown, unknown, never>;
    times?: number;
  }) =>
    input.effect.pipe(
      Effect.filterOrFail(
        input.predicate,
        (actual) =>
          new PredicateFailed({
            message: `Predicate failed: ${input.description ?? "<no description>"}`,
            actual,
          }),
      ),
      Effect.retry({
        while: isPredicateFailed,
        schedule: input.schedule ?? Schedule.spaced("3 seconds"),
        times: input.times ?? 50,
      }),
    ),
);
