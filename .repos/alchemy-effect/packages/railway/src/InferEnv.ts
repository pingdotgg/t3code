import type * as Effect from "effect/Effect";

/**
 * Typed `env` for an async (non-Effect) {@link Function}. Railway
 * bindings are environment variables, so every entry is a `string` —
 * the same object the handler receives as its second argument
 * (`process.env` keys declared on `env`).
 *
 * Analogous to `Cloudflare.InferEnv`, which maps env entries onto native
 * Worker bindings. Railway has only env vars, so the mapping is 1:1 to
 * `string`.
 *
 * @example
 * ```typescript
 * export const Ping = Railway.Function("Ping", {
 *   project: Site,
 *   main: "./src/ping.ts",
 *   env: { DATABASE_URL: db.connectionUri },
 * });
 * export type PingEnv = Railway.InferEnv<typeof Ping>;
 * ```
 */
export type InferEnv<F> =
  F extends Effect.Effect<infer A, infer _E, infer _R>
    ? InferEnv<A>
    : F extends { readonly Props: { readonly env?: infer E } }
      ? InferEnvRecord<Exclude<E, undefined>>
      : InferEnvRecord<F>;

type InferEnvRecord<E> = {
  readonly [K in keyof E]: string;
};
