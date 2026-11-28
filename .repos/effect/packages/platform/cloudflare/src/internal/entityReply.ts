/** @internal */
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"

/** @internal */
export class CurrentEntityName extends Context.Service<CurrentEntityName, string>()(
  "@effect/platform-cloudflare/CurrentEntityName"
) {}

/**
 * Completes the delayed asks made by one entity Durable Object's handlers.
 * The destination object pushes the stored reply back over the caller's
 * `deliverReply` RPC, which finds the waiting `Deferred` here.
 *
 * @internal
 */
export interface EntityReplyRegistry {
  readonly register: (requestId: string, waiter: Deferred.Deferred<string>) => void
  readonly unregister: (requestId: string, waiter: Deferred.Deferred<string>) => void
  readonly deliver: (requestId: string, reply: string) => boolean
}

/** @internal */
export const makeReplyRegistry = (): EntityReplyRegistry => {
  const waiters = new Map<string, Set<Deferred.Deferred<string>>>()
  return {
    register(requestId, waiter) {
      const registered = waiters.get(requestId) ?? new Set()
      registered.add(waiter)
      waiters.set(requestId, registered)
    },
    unregister(requestId, waiter) {
      const registered = waiters.get(requestId)
      if (registered === undefined) return
      registered.delete(waiter)
      if (registered.size === 0) waiters.delete(requestId)
    },
    deliver(requestId, reply) {
      const registered = waiters.get(requestId)
      if (registered === undefined) return false
      waiters.delete(requestId)
      for (const waiter of registered) {
        Deferred.doneUnsafe(waiter, Effect.succeed(reply))
      }
      return true
    }
  }
}

/** @internal */
export class CurrentReplyRegistry extends Context.Service<CurrentReplyRegistry, EntityReplyRegistry>()(
  "@effect/platform-cloudflare/CurrentReplyRegistry"
) {}
