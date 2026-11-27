/** @internal */
import type * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { makeRegistry } from "./registry.ts"

/** @internal */
export interface SingletonRegistration {
  readonly run: Effect.Effect<void, unknown, never>
  readonly context: Context.Context<never>
}

const registry = makeRegistry<SingletonRegistration>()

/** @internal */
export const getSingletonRegistration: (name: string) => SingletonRegistration | undefined = registry.get

/** @internal */
export const registerSingleton: (name: string, registration: SingletonRegistration) => boolean = registry.register

/** @internal */
export const unregisterSingleton: (name: string, registration: SingletonRegistration) => void = registry.unregister
