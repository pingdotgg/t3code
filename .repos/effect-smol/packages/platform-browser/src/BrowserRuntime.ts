/**
 * Browser entry-point helpers for running Effect programs.
 *
 * This module exposes `runMain`, a browser-oriented main runner for launching
 * an Effect as the root program of a page, single-page application, demo, or
 * browser test harness. It delegates execution to the core Effect runtime while
 * adding the browser lifecycle hook needed to interrupt the main fiber when the
 * page receives `beforeunload`.
 *
 * `BrowserRuntime` does not provide application services by itself. Provide
 * any required layers, such as browser HTTP, storage, worker, geolocation, or
 * permission services, before passing the effect to `runMain`. Keep long-lived
 * browser resources scoped so interruption can run their finalizers while the
 * page is still active.
 *
 * Browser unload is more constrained than a process signal. Finalizers that
 * need the network, timers, prompts, or long asynchronous work may not complete
 * once navigation or tab close has started, and browsers do not expose a
 * process exit status. Use `runMain` to connect the page lifecycle to Effect
 * interruption, and use browser-specific persistence or delivery APIs for work
 * that must survive page teardown.
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
