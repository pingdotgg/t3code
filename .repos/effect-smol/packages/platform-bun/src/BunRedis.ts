/**
 * Bun Redis integration backed by Bun's built-in `RedisClient`.
 *
 * This module creates scoped Bun `RedisClient` connections and exposes them as
 * both the portable `Redis` service used by Effect persistence modules and the
 * Bun-specific `BunRedis` service for direct access to the raw client. Use it in
 * Bun applications that need Redis-backed persistence, persisted queues,
 * distributed rate limiting, custom Redis commands, or Bun Redis features such
 * as pub/sub.
 *
 * **Mental model**
 *
 * `layer` and `layerConfig` acquire one `RedisClient` for the layer scope. The
 * same client backs the portable `Redis.Redis` command interface and the
 * `BunRedis` service, and it is closed with `close` when the scope finalizes.
 * Install the layer at the lifetime you want for that connection.
 *
 * **Common tasks**
 *
 * Pass a Redis URL or Bun `RedisOptions` to `layer` for direct configuration,
 * or use `layerConfig` when connection settings should come from Effect
 * configuration. Depend on `Redis.Redis` for persistence and rate limiter
 * stores. Depend on `BunRedis` when you need `RedisClient` features that are
 * not exposed by the portable service, including custom commands and pub/sub.
 *
 * **Gotchas**
 *
 * Pub/sub should normally use a separately scoped client so a subscription does
 * not interfere with ordinary command traffic. Persistence and rate limiter
 * stores build keys and Lua scripts on top of this service, so choose stable
 * prefixes and store ids, account for persisted values that may fail to decode
 * after schema changes, and avoid unbounded high-cardinality rate-limit keys
 * without a cleanup or bounding strategy.
 *
 * @since 4.0.0
 */
import { RedisClient, type RedisOptions } from "bun"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fn from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Redis from "effect/unstable/persistence/Redis"

/**
 * Service tag for Bun Redis integration, exposing the raw `RedisClient` and a `use` helper that maps client promise failures to `RedisError`.
 *
 * @category services
 * @since 4.0.0
 */
export class BunRedis extends Context.Service<BunRedis, {
  readonly client: RedisClient
  readonly use: <A>(f: (client: RedisClient) => Promise<A>) => Effect.Effect<A, Redis.RedisError>
}>()("@effect/platform-bun/BunRedis") {}

const make = Effect.fnUntraced(function*(
  options?: {
    readonly url?: string
  } & RedisOptions
) {
  const scope = yield* Effect.scope
  yield* Scope.addFinalizer(scope, Effect.sync(() => client.close()))
  const client = new RedisClient(options?.url, options)

  const use = <A>(f: (client: RedisClient) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(client),
      catch: (cause) => new Redis.RedisError({ cause })
    })

  const redis = yield* Redis.make({
    send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => client.send(command, args as Array<string>) as Promise<A>,
        catch: (cause) => new Redis.RedisError({ cause })
      })
  })

  const bunRedis = Fn.identity<BunRedis["Service"]>({
    client,
    use
  })

  return Context.make(BunRedis, bunRedis).pipe(
    Context.add(Redis.Redis, redis)
  )
})

/**
 * Creates scoped Bun Redis layers for `Redis.Redis` and `BunRedis`, closing the underlying client when the scope finalizes.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  options?: ({ readonly url?: string } & RedisOptions) | undefined
): Layer.Layer<Redis.Redis | BunRedis> => Layer.effectContext(make(options))

/**
 * Creates scoped Bun Redis layers from configurable Redis options, closing the underlying client when the scope finalizes.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (
  options: Config.Wrap<{ readonly url?: string } & RedisOptions>
): Layer.Layer<Redis.Redis | BunRedis, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(options).pipe(
      Effect.flatMap(make)
    )
  )
