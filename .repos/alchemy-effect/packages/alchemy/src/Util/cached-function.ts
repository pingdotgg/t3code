import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * Options for creating a cached function.
 */
export interface CachedFunctionOptions<A> {
  /**
   * Function to convert arguments to a cache key string.
   * Defaults to `JSON.stringify`.
   */
  readonly key?: (args: A) => string;
}

/**
 * Creates a memoized version of a function that returns an Effect.
 *
 * The key feature is deduplication of concurrent calls with the same inputs -
 * only one execution happens while other callers wait for and receive the same result.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect";
 * import { cachedFunction } from "~/lib/cached-function";
 *
 * const fetchUser = (id: string) =>
 *   Effect.promise(() => fetch(`/users/${id}`).then(r => r.json()));
 *
 * const program = Effect.gen(function* () {
 *   const cachedFetchUser = yield* cachedFunction(fetchUser);
 *
 *   // These concurrent calls will only trigger one fetch
 *   const [user1, user2] = yield* Effect.all([
 *     cachedFetchUser("123"),
 *     cachedFetchUser("123"),
 *   ]);
 * });
 * ```
 */
export const cachedFunction = <A, B, E, R>(
  fn: (args: A) => Effect.Effect<B, E, R>,
  options?: CachedFunctionOptions<A>,
): Effect.Effect<(args: A) => Effect.Effect<B, E, R>> =>
  Effect.sync(() => {
    const keyFn = options?.key ?? JSON.stringify;
    const cache = new Map<string, Deferred.Deferred<B, E>>();

    return (args: A): Effect.Effect<B, E, R> =>
      Effect.suspend(() => {
        const cacheKey = keyFn(args);
        const existing = cache.get(cacheKey);

        // If there's already a deferred for this key, wait on it
        if (existing) {
          return Deferred.await(existing);
        }

        // Create a new deferred and store it
        return Effect.gen(function* () {
          const deferred = yield* Deferred.make<B, E>();
          cache.set(cacheKey, deferred);

          // Execute the effect and complete the deferred
          const exit = yield* Effect.exit(fn(args));
          yield* Deferred.done(deferred, exit);

          if (exit._tag === "Failure") {
            cache.delete(cacheKey);
          }

          // Return the result
          return yield* exit;
        });
      });
  });
