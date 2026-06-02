/**
 * Node.js implementation of the Effect `Terminal` service.
 *
 * `NodeTerminal` connects `Terminal` to the current process' stdin and stdout
 * so Node programs can read lines, stream key presses, write display output,
 * and inspect terminal dimensions through the Effect service environment.
 *
 * **Mental model**
 *
 * `make` acquires a scoped terminal backed by process streams, and `layer`
 * provides that service with the default key sequence for quitting input. When
 * stdin is a TTY, low-level key input temporarily enables raw mode for the
 * lifetime of the scope; finalization restores the previous terminal state.
 *
 * **Gotchas**
 *
 * In non-TTY environments such as CI, pipes, or redirected input, terminal
 * dimensions may be reported as zero and raw-mode key handling is unavailable.
 * For plain stdin/stdout byte streams, use the standard I/O service instead of
 * the interactive terminal service.
 *
 * @since 4.0.0
 */
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
import type { Effect } from "effect/Effect"
import type { Layer } from "effect/Layer"
import type { Scope } from "effect/Scope"
import type { Terminal, UserInput } from "effect/Terminal"

/**
 * Creates a scoped `Terminal` service backed by process stdin/stdout, using the
 * optional predicate to decide when key input should end the input stream.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (shouldQuit?: (input: UserInput) => boolean) => Effect<Terminal, never, Scope> = NodeTerminal.make

/**
 * Provides the default process-backed `Terminal` service, ending key input on
 * the default quit keys.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer<Terminal> = NodeTerminal.layer
