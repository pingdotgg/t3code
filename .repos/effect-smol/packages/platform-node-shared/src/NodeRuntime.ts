/**
 * Node-compatible process runner for Effect programs.
 *
 * This module provides the shared `runMain` implementation used by
 * Node-compatible platform packages. Use it at the outer edge of a CLI, script,
 * worker, server, or test harness when a single Effect should become the main
 * fiber for the process while still following Node signal and exit-code
 * conventions.
 *
 * **Mental model**
 *
 * `runMain` starts the supplied Effect as the process root. While that fiber is
 * running, `SIGINT` and `SIGTERM` are translated into fiber interruption so
 * scoped resources and finalizers get a chance to run. After the fiber exits,
 * the signal listeners are removed and the configured teardown decides the
 * process exit code.
 *
 * **Common tasks**
 *
 * - Launch a command-line program or long-running service from an Effect.
 * - Share the same main-runner behavior across Node-compatible packages.
 * - Customize teardown or runtime error reporting with the `runMain` options.
 *
 * **Gotchas**
 *
 * Clean success lets the Node event loop drain naturally instead of forcing
 * `process.exit(0)`. Signal-triggered interruption or a non-zero teardown code
 * calls `process.exit`, so long-lived handles should be acquired in Effect
 * scopes and released by finalizers.
 *
 * @since 4.0.0
 */
import type { Effect } from "effect/Effect"
import * as Runtime from "effect/Runtime"

/**
 * Runs an Effect as the Node process main program, interrupting the fiber on
 * `SIGINT` or `SIGTERM` and invoking the configured teardown to determine the
 * process exit code.
 *
 * @category running
 * @since 4.0.0
 */
export const runMain: {
  (
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Runtime.Teardown | undefined
    }
  ): <E, A>(effect: Effect<A, E>) => void
  <E, A>(
    effect: Effect<A, E>,
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Runtime.Teardown | undefined
    }
  ): void
} = Runtime.makeRunMain(({
  fiber,
  teardown
}) => {
  let receivedSignal = false

  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigint)
    teardown(exit, (code) => {
      if (receivedSignal || code !== 0) {
        process.exit(code)
      }
    })
  })

  function onSigint() {
    receivedSignal = true
    fiber.interruptUnsafe(fiber.id)
  }

  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigint)
})
