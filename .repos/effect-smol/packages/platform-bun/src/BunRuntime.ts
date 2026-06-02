/**
 * Bun process runner for Effect programs.
 *
 * This module exposes Bun's `runMain` entry point. It is the function to call
 * at the outer edge of a Bun CLI, script, server, or worker when a single
 * Effect should become the process main fiber and use Bun's Node-compatible
 * process, signal, and teardown behavior.
 *
 * **Mental model**
 *
 * `runMain` delegates to the shared Node-compatible runner. It starts the
 * supplied Effect as the process root, reports failures through the configured
 * runtime reporting, and translates `SIGINT` or `SIGTERM` into interruption so
 * scoped resources can finalize before teardown chooses an exit code.
 *
 * **Common tasks**
 *
 * - Launch a Bun CLI or one-off script from an Effect.
 * - Start a long-running Bun server or worker under an Effect scope.
 * - Customize error reporting or teardown with `runMain` options.
 * - Provide `BunServices.layer` or narrower layers before calling `runMain`.
 *
 * **Gotchas**
 *
 * This module runs the program; it does not provide filesystem, network,
 * terminal, or other platform services. Long-lived servers, subscriptions, and
 * worker loops should be acquired in Effect scopes so interruption from process
 * signals can release them. Finalizers that never complete can keep shutdown
 * waiting.
 *
 * @since 4.0.0
 */
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
import type { Effect } from "effect/Effect"
import type { Teardown } from "effect/Runtime"

/**
 * Helps you run a main effect with built-in error handling, logging, and signal management.
 *
 * **When to use**
 *
 * Use to run an Effect as your application's main program,
 * especially when you need structured error handling, log management,
 * interrupt support, or advanced teardown capabilities.
 *
 * **Details**
 *
 * This function launches an Effect as the main entry point, setting exit codes
 * based on success or failure, handling interrupts (e.g., Ctrl+C), and optionally
 * logging errors. By default, it logs errors and uses a "pretty" format, but both
 * behaviors can be turned off. You can also provide custom teardown logic to
 * finalize resources or produce different exit codes.
 *
 * An optional object that can include:
 * - `disableErrorReporting`: Turn off automatic error logging.
 * - `disablePrettyLogger`: Avoid adding the pretty logger.
 * - `teardown`: Provide custom finalization logic.
 *
 * @category running
 * @since 4.0.0
 */
export const runMain: {
  (
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): <E, A>(effect: Effect<A, E>) => void
  <E, A>(
    effect: Effect<A, E>,
    options?: {
      readonly disableErrorReporting?: boolean | undefined
      readonly teardown?: Teardown | undefined
    }
  ): void
} = NodeRuntime.runMain
