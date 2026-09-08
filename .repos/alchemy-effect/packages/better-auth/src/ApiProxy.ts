import type { RuntimeContext } from "alchemy";
import type { Auth } from "better-auth";
import * as Effect from "effect/Effect";
import { BetterAuthApiError, isAPIErrorLike } from "./Errors.ts";

/**
 * Every `auth.api.*` endpoint mirrored as an Effect: same arguments, same
 * success type, with the thrown `APIError` surfaced as a typed
 * {@link BetterAuthApiError} failure. Non-`APIError` throws become defects.
 *
 * Known (accepted) lossage vs the raw promise API: conditional-type
 * inference collapses overload sets to their last signature, so the
 * `asResponse`/`returnHeaders` return-type refinements degrade on some
 * endpoints. Use the raw `auth` escape hatch for those.
 */
export type BetterAuthApi<Api> = {
  readonly [K in keyof Api]: Api[K] extends (
    ...args: infer Args
  ) => Promise<infer A>
    ? (...args: Args) => Effect.Effect<A, BetterAuthApiError, RuntimeContext>
    : never;
};

/**
 * Build the effectified `api` Proxy over the per-execution auth instance.
 *
 * @internal
 */
export const makeApiProxy = <A extends { api: unknown }>(
  makeAuth: Effect.Effect<A, never, RuntimeContext>,
): BetterAuthApi<A["api"]> => {
  const wrappers = new Map<
    PropertyKey,
    (
      ...args: unknown[]
    ) => Effect.Effect<unknown, BetterAuthApiError, RuntimeContext>
  >();
  return new Proxy(
    {},
    {
      get(_target, key) {
        // Never look like a thenable / iterable — the proxy is a plain
        // record of endpoint wrappers.
        if (typeof key !== "string" || key === "then") {
          return undefined;
        }
        let wrapper = wrappers.get(key);
        if (wrapper === undefined) {
          wrapper = (...args: unknown[]) =>
            Effect.flatMap(makeAuth, (auth) =>
              Effect.tryPromise({
                try: () =>
                  (
                    auth.api as Record<
                      string,
                      (...args: unknown[]) => Promise<unknown>
                    >
                  )[key]!(...args),
                catch: (error) => error,
              }).pipe(
                Effect.catch((error: unknown) =>
                  isAPIErrorLike(error)
                    ? Effect.fail(BetterAuthApiError.fromAPIError(error))
                    : Effect.die(error),
                ),
              ),
            );
          wrappers.set(key, wrapper);
        }
        return wrapper;
      },
      has(_target, key) {
        return typeof key === "string" && key !== "then";
      },
    },
  ) as BetterAuthApi<A["api"]>;
};
