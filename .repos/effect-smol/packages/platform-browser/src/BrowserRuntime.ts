/**
 * Browser helper for running a root Effect program.
 *
 * This module exports `runMain`, a browser version of the main Effect runner.
 * It forwards runner options to the core runtime and adds a `beforeunload`
 * listener that interrupts the main fiber when the page is unloading.
 *
 * @since 4.0.0
 */
import type * as Effect from "effect/Effect"
import { makeRunMain, type Teardown } from "effect/Runtime"

/**
 * Runs an effect as the browser main program and interrupts its fiber when the page receives a `beforeunload` event.
 *
 * **When to use**
 *
 * Use to launch a browser page, single-page application, demo, or browser test
 * harness as a root Effect program.
 *
 * **Details**
 *
 * Supports both direct and curried call forms. Options are forwarded to
 * `makeRunMain`, including `disableErrorReporting` and custom `teardown`
 * behavior.
 *
 * **Gotchas**
 *
 * The `beforeunload` interruption is best-effort. Browser teardown may prevent
 * asynchronous finalizers, network work, timers, or prompts from completing.
 *
 * @category Runtime
 * @since 4.0.0
 */
export const runMain: {
  (
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): <E, A>(effect: Effect.Effect<A, E>) => void
  <E, A>(
    effect: Effect.Effect<A, E>,
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): void
} = makeRunMain(({ fiber }) => {
  globalThis.addEventListener("beforeunload", () => {
    fiber.interruptUnsafe(fiber.id)
  })
})
