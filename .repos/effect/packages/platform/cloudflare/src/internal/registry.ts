/**
 * A module-level registration map shared between the Worker layer and the
 * Durable Object instances of the same isolate. Unregistering only removes
 * the exact registration that was added, so a finalizer racing a re-register
 * cannot drop the replacement.
 *
 * @internal
 */

/** @internal */
export interface Registry<A> {
  readonly get: (key: string) => A | undefined
  readonly register: (key: string, value: A) => boolean
  readonly unregister: (key: string, value: A) => void
}

/** @internal */
export const makeRegistry = <A>(): Registry<A> => {
  const registrations = new Map<string, A>()
  return {
    get: (key) => registrations.get(key),
    register: (key, value) => {
      if (registrations.has(key)) return false
      registrations.set(key, value)
      return true
    },
    unregister: (key, value) => {
      if (registrations.get(key) === value) registrations.delete(key)
    }
  }
}
