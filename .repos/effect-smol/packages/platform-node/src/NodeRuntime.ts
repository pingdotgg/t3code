/**
 * Node.js process runner for starting an Effect program at the application
 * edge.
 *
 * This module exposes `runMain`, the launcher used by Node CLIs, scripts,
 * servers, and workers when a single Effect should become the process root. It
 * handles runtime error reporting, Node process signals, and teardown so the
 * rest of the program can stay inside Effect.
 *
 * **Mental model**
 *
 * `runMain` is the last call in `main.ts`: build the effect, provide the layers
 * it needs, then hand the self-contained program to this module. The function
 * does not provide Node services itself; use `NodeServices.layer` or narrower
 * platform layers before launching.
 *
 * **Common tasks**
 *
 * - Run a CLI command or script and let failures become process failures.
 * - Keep a server or worker fiber alive as the process main program.
 * - Override teardown or disable automatic error reporting at the boundary.
 *
 * **Gotchas**
 *
 * `SIGINT` and `SIGTERM` interrupt the main fiber so scoped finalizers can run.
 * Clean success lets the event loop drain naturally, while signal-triggered
 * interruption or a non-zero teardown code exits the process. Keep long-lived
 * resources in Effect scopes and avoid finalizers that never complete.
 *
 * @since 4.0.0
 */
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
import type { Effect } from "effect/Effect"
import type * as Runtime from "effect/Runtime"

/**
 * Helps you run a main effect with built-in error handling, logging, and signal management.
 *
 * **When to use**
 *
 * Use to run an Effect as your application's main program, especially
 * when you need structured error handling, log management, interrupt support,
 * or advanced teardown capabilities.
 *
 * **Details**
 *
 * This function launches an Effect as the main entry point, setting exit codes
 * based on success or failure, handling interrupts (e.g., Ctrl+C), and optionally
 * logging errors. By default, it logs errors and uses a "pretty" format, but both
 * behaviors can be turned off. You can also provide custom teardown logic to
 * finalize resources or produce different exit codes.
 *
 * The optional configuration object can include:
 * - `disableErrorReporting`: Turn off automatic error logging.
 * - `teardown`: Provide custom finalization logic.
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
} = NodeRuntime.runMain
