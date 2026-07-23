/**
 * The `Reactivity` module provides process-local invalidation for connecting
 * writes to dependent reads. It does not cache values itself; it tracks keys,
 * registers query handlers, and reruns effects when matching keys are
 * invalidated so queues, streams, UI subscriptions, and read models can stay
 * fresh after successful writes.
 *
 * **Mental model**
 *
 * A query registers one or more keys, runs once immediately, and publishes each
 * result to a queue or stream. Invalidating any registered key schedules the
 * query to rerun. Mutations wrap an effect and invalidate keys only after it
 * succeeds. Keys can be a flat array, or a record whose property names act as
 * broad namespaces and whose ids address individual records.
 *
 * **Common tasks**
 *
 * - Provide the default in-memory service with {@link layer}.
 * - Use {@link query} when callers need a queue of rerun results.
 * - Use {@link stream} when downstream code should consume reruns as a stream.
 * - Wrap writes with {@link mutation}, or call {@link invalidate} directly when
 *   invalidation is already part of the workflow.
 * - Use the {@link Reactivity} service directly when many invalidations should
 *   be coalesced until a batch exits.
 *
 * **Gotchas**
 *
 * - The default layer is process-local; it does not coordinate invalidations
 *   across processes or cluster runners.
 * - Non-primitive keys are matched by their `Hash.hash` value, so prefer stable
 *   key values over mutable objects.
 * - If a query fails, its queue or stream fails with the same cause.
 * - Invalidations that arrive while a query is already running coalesce into one
 *   follow-up run.
 *
 * **See also**
 *
 * - {@link query}, {@link stream}, {@link mutation}, and {@link invalidate}
 * - {@link layer} and {@link Reactivity}
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import { dual, flow } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import * as Layer from "../../Layer.ts"
import * as Queue from "../../Queue.ts"
import type { ReadonlyRecord } from "../../Record.ts"
import * as Scope from "../../Scope.ts"
import * as Stream from "../../Stream.ts"

/**
 * Service for key-based reactive invalidation.
 *
 * **When to use**
 *
 * Use to provide the invalidation service that refreshes queries, streams, and
 * atoms when application keys change.
 *
 * **Details**
 *
 * The service can register handlers for keys, invalidate those keys, wrap
 * mutations so successful effects invalidate keys, and turn query effects into
 * queues or streams that rerun when keys are invalidated.
 *
 * @category tags
 * @since 4.0.0
 */
export class Reactivity extends Context.Service<
  Reactivity,
  {
    readonly invalidateUnsafe: (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>) => void
    readonly registerUnsafe: (
      keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
      handler: () => void
    ) => () => void
    readonly invalidate: (
      keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
    ) => Effect.Effect<void>
    readonly mutation: <A, E, R>(
      keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>
    readonly query: <A, E, R>(
      keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope>
    readonly stream: <A, E, R>(
      keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
      effect: Effect.Effect<A, E, R>
    ) => Stream.Stream<A, E, Exclude<R, Scope.Scope>>
    readonly withBatch: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("effect/reactivity/Reactivity") {}

/**
 * Creates an in-memory `Reactivity` service.
 *
 * **Details**
 *
 * The service tracks handlers by hashed keys and runs the registered handlers when
 * matching keys are invalidated.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.sync(() => {
  const handlers = new Map<number | string, Set<() => void>>()

  const invalidateUnsafe = (keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>): void => {
    keysToHashes(keys, (hash) => {
      const set = handlers.get(hash)
      if (set === undefined) return
      set.forEach((run) => run())
    })
  }

  const invalidate = (
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
  ): Effect.Effect<void> =>
    Effect.contextWith((services) => {
      const pending = services.mapUnsafe.get(PendingInvalidation.key) as Set<string | number> | undefined
      if (pending) {
        keysToHashes(keys, (hash) => {
          pending.add(hash)
        })
      } else {
        invalidateUnsafe(keys)
      }
      return Effect.void
    })

  const mutation = <A, E, R>(
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> => Effect.tap(effect, invalidate(keys))

  const registerUnsafe = (
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    handler: () => void
  ): () => void => {
    const resolvedKeys: Array<string | number> = []
    keysToHashes(keys, (hash) => {
      resolvedKeys.push(hash)
      let set = handlers.get(hash)
      if (set === undefined) {
        set = new Set()
        handlers.set(hash, set)
      }
      set.add(handler)
    })
    return () => {
      for (let i = 0; i < resolvedKeys.length; i++) {
        const set = handlers.get(resolvedKeys[i])!
        set.delete(handler)
        if (set.size === 0) {
          handlers.delete(resolvedKeys[i])
        }
      }
    }
  }

  const query = <A, E, R>(
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope> =>
    Effect.gen(function*() {
      const services = yield* Effect.context<Scope.Scope | R>()
      const scope = Context.get(services, Scope.Scope)
      const results = yield* Queue.make<A, E>()
      const runFork = flow(Effect.runForkWith(services), Fiber.runIn(scope))

      let running = false
      let pending = false
      const handleExit = (exit: Exit.Exit<A, E>) => {
        if (exit._tag === "Failure") {
          Queue.failCauseUnsafe(results, exit.cause)
        } else {
          Queue.offerUnsafe(results, exit.value)
        }
        if (pending) {
          pending = false
          runFork(effect).addObserver(handleExit)
        } else {
          running = false
        }
      }

      function run() {
        if (running) {
          pending = true
          return
        }
        running = true
        runFork(effect).addObserver(handleExit)
      }

      const cancel = registerUnsafe(keys, run)
      yield* Scope.addFinalizer(scope, Effect.sync(cancel))
      run()

      return results as Queue.Dequeue<A, E>
    })

  const stream = <A, E, R>(
    tables: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
    effect: Effect.Effect<A, E, R>
  ): Stream.Stream<A, E, Exclude<R, Scope.Scope>> =>
    query(tables, effect).pipe(
      Effect.map(Stream.fromQueue),
      Stream.unwrap
    )

  const withBatch = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const pending = new Set<string | number>()
      return effect.pipe(
        Effect.provideService(PendingInvalidation, pending),
        Effect.onExit((_) =>
          Effect.sync(() => {
            pending.forEach((hash) => {
              const set = handlers.get(hash)
              if (set === undefined) return
              set.forEach((run) => run())
            })
          })
        )
      )
    })

  return Reactivity.of({
    mutation,
    query,
    stream,
    invalidateUnsafe,
    invalidate,
    registerUnsafe,
    withBatch
  })
})

class PendingInvalidation extends Context.Service<PendingInvalidation, Set<string | number>>()(
  "effect/reactivity/Reactivity/PendingInvalidation"
) {}

/**
 * Wraps an effect so the supplied keys are invalidated after the effect succeeds.
 *
 * **Gotchas**
 *
 * If the effect fails, the keys are not invalidated.
 *
 * @category accessors
 * @since 4.0.0
 */
export const mutation: {
  (
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Reactivity>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
  ): Effect.Effect<A, E, R | Reactivity>
} = dual(2, <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
): Effect.Effect<A, E, R | Reactivity> => Reactivity.use((_) => _.mutation(keys, effect)))

/**
 * Runs an effect as a query tied to the supplied invalidation keys.
 *
 * **Details**
 *
 * The returned queue receives the initial result and each later result after the
 * keys are invalidated. The registration is removed when the current scope closes.
 *
 * @category accessors
 * @since 4.0.0
 */
export const query: {
  (
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
  ): <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope | Reactivity>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
  ): Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope | Reactivity>
} = dual(2, <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
): Effect.Effect<Queue.Dequeue<A, E>, never, R | Scope.Scope | Reactivity> =>
  Reactivity.use((r) => r.query(keys, effect)))

/**
 * Runs an effect as a stream of query results tied to the supplied invalidation
 * keys.
 *
 * **Details**
 *
 * The effect runs initially and reruns whenever the keys are invalidated.
 *
 * @category accessors
 * @since 4.0.0
 */
export const stream: {
  (
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Stream.Stream<A, E, Exclude<R, Scope.Scope> | Reactivity>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
  ): Stream.Stream<A, E, Exclude<R, Scope.Scope> | Reactivity>
} = dual(2, <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
): Stream.Stream<A, E, Exclude<R, Scope.Scope> | Reactivity> =>
  Reactivity.use((r) => r.query(keys, effect)).pipe(
    Effect.map(Stream.fromQueue),
    Stream.unwrap
  ))

/**
 * Invalidates the supplied keys through the `Reactivity` service.
 *
 * **Details**
 *
 * Registered queries for matching keys are rerun immediately, or collected until
 * the enclosing reactivity batch completes.
 *
 * @category accessors
 * @since 4.0.0
 */
export const invalidate = (
  keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>
): Effect.Effect<void, never, Reactivity> => Reactivity.use((r) => r.invalidate(keys))

/**
 * The default layer that provides an in-memory `Reactivity` service.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Reactivity> = Layer.effect(Reactivity)(make)

function stringOrHash(u: unknown): string | number {
  switch (typeof u) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return String(u)
    default:
      return Hash.hash(u)
  }
}

const keysToHashes = (
  keys: ReadonlyArray<unknown> | ReadonlyRecord<string, ReadonlyArray<unknown>>,
  f: (hash: string | number) => void
): void => {
  if (Array.isArray(keys)) {
    for (let i = 0; i < keys.length; i++) {
      f(stringOrHash(keys[i]))
    }
    return
  }
  for (const key in keys) {
    f(key)
    const ids = (keys as ReadonlyRecord<string, ReadonlyArray<unknown>>)[key]
    for (let i = 0; i < ids.length; i++) {
      f(`${key}:${stringOrHash(ids[i])}`)
    }
  }
}
