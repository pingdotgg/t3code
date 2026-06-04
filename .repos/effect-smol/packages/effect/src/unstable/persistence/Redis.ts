/**
 * Redis service adapter for Effect persistence modules.
 *
 * This module defines the low-level {@link Redis} service used by Redis-backed
 * persistence, persisted queues, and rate limiter stores. It adapts a Redis
 * client or pool into Effect through a raw `send` command function and cached
 * Lua script execution.
 *
 * **Mental model**
 *
 * The service does not create or own Redis connections. {@link make} wraps a
 * caller-provided command sender, while {@link script} describes a Lua script's
 * source, parameters, key count, and result type. The service loads scripts
 * with `SCRIPT LOAD`, caches the returned SHA, and runs them with `EVALSHA`
 * through `Redis.eval`.
 *
 * **Common tasks**
 *
 * - Wrap an existing Redis client by implementing `send`.
 * - Use `Redis.send` for ordinary Redis commands.
 * - Use {@link script} for typed Lua helpers shared by persistence stores.
 * - Map client or network failures into {@link RedisError} in the provided
 *   command sender.
 *
 * **Gotchas**
 *
 * Script parameters are stringified before execution. The script descriptor's
 * key count controls how Redis splits `KEYS` from `ARGV`. Higher-level stores
 * add key prefixes and store ids on top of this service, so those identifiers
 * must stay stable when persisted data is expected to survive deployments.
 *
 * **See also**
 *
 * {@link Redis}, {@link make}, {@link script}, {@link RedisError}.
 *
 * @since 4.0.0
 */
import * as Cache from "../../Cache.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import { constant, identity } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import * as Schema from "../../Schema.ts"

/**
 * Service for sending Redis commands and evaluating cached Lua scripts.
 *
 * @category services
 * @since 4.0.0
 */
export class Redis extends Context.Service<Redis, {
  readonly send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) => Effect.Effect<A, RedisError>

  readonly eval: <
    Config extends {
      readonly params: ReadonlyArray<unknown>
      readonly result: unknown
    }
  >(script: Script<Config>) => (...params: Config["params"]) => Effect.Effect<Config["result"], RedisError>
}>()("effect/persistence/Redis") {}

/**
 * Creates a `Redis` service from a raw command sender.
 *
 * **Details**
 *
 * Lua scripts are loaded through `SCRIPT LOAD`, cached, and then invoked with
 * `EVALSHA`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(
  options: {
    readonly send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) => Effect.Effect<A, RedisError>
  }
) {
  const scriptCache = yield* Cache.make({
    lookup: (script: Script<any>) => options.send<string>("SCRIPT", "LOAD", script.lua),
    capacity: Number.POSITIVE_INFINITY
  })

  const eval_ = <
    Config extends {
      readonly params: ReadonlyArray<unknown>
      readonly result: unknown
    }
  >(
    script: Script<Config>
  ) =>
  (...params: Config["params"]): Effect.Effect<Config["result"], RedisError> =>
    Effect.flatMap(Cache.get(scriptCache, script), (sha) =>
      options.send<Config["result"]>(
        "EVALSHA",
        sha,
        script.numberOfKeys(...params).toString(),
        ...script.params(...params).map((param) => String(param))
      ))

  return identity<Redis["Service"]>({
    send: options.send,
    eval: eval_
  })
})

type ErrorTypeId = "~effect/persistence/Redis/RedisError"
const ErrorTypeId: ErrorTypeId = "~effect/persistence/Redis/RedisError"

/**
 * Error raised by Redis command or script execution.
 *
 * @category errors
 * @since 4.0.0
 */
export class RedisError extends Schema.ErrorClass<RedisError>(ErrorTypeId)({
  _tag: Schema.tag("RedisError"),
  cause: Schema.Defect
}) {
  /**
   * Marks this value as a Redis persistence error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ErrorTypeId]: ErrorTypeId = ErrorTypeId
}

type ScriptTypeId = "~effect/persistence/Redis/Script"
const ScriptTypeId: ScriptTypeId = "~effect/persistence/Redis/Script"

/**
 * Typed descriptor for a Redis Lua script.
 *
 * **Details**
 *
 * It defines the Lua source, parameter-to-argument mapping, Redis key count,
 * and result type used by `Redis.eval`.
 *
 * @category Scripting
 * @since 4.0.0
 */
export interface Script<
  Config extends {
    readonly params: ReadonlyArray<unknown>
    readonly result: unknown
  }
> {
  readonly [ScriptTypeId]: {
    readonly params: Config["params"]
    readonly result: Config["result"]
  }
  readonly lua: string
  readonly params: (...params: Config["params"]) => ReadonlyArray<unknown>
  readonly numberOfKeys: (...params: Config["params"]) => number

  /**
   * Set the return type of the script.
   */
  withReturnType<Result>(): Script<{
    params: Config["params"]
    result: Result
  }>
}

const ScriptProto = {
  [ScriptTypeId]: {
    params: identity,
    result: identity
  },
  withReturnType() {
    return this
  },
  [Equal.symbol](that: unknown): boolean {
    return this === that
  },
  [Hash.symbol](): number {
    return Hash.random(this)
  }
}

/**
 * Constructs a typed Redis Lua script descriptor.
 *
 * **Details**
 *
 * The result type defaults to `void` and can be refined with
 * `withReturnType`.
 *
 * @category Scripting
 * @since 4.0.0
 */
export const script = <Params extends ReadonlyArray<any>>(
  f: (...params: Params) => ReadonlyArray<unknown>,
  options: {
    readonly lua: string
    readonly numberOfKeys: number | ((...params: Params) => number)
  }
): Script<{
  params: Params
  result: void
}> =>
  Object.assign(Object.create(ScriptProto), {
    ...options,
    params: f,
    numberOfKeys: typeof options.numberOfKeys === "number" ? constant(options.numberOfKeys) : options.numberOfKeys
  })
