/**
 * Bun-backed implementation of Effect's `Terminal` service.
 *
 * This module adapts Bun's Node-compatible `stdin`, `stdout`, and `readline`
 * support into a scoped `Terminal` service. It is intended for Bun CLIs,
 * prompts, REPLs, and terminal interfaces that need prompt output, line input,
 * keypress input, or terminal dimensions through Effect services.
 *
 * **Mental model**
 *
 * - {@link make} creates a scoped terminal from the current process streams.
 * - {@link layer} provides the default live terminal service for Bun programs.
 * - The implementation reuses the shared Node-compatible terminal adapter, so
 *   behavior follows the capabilities of Bun's process streams and readline
 *   support.
 *
 * **Common tasks**
 *
 * - Provide terminal access at the edge of a Bun CLI with {@link layer}.
 * - Customize which key ends keypress input by calling {@link make} directly.
 * - Read lines, read keypresses, display prompts, and inspect terminal size
 *   through the `Terminal` service once it is provided.
 *
 * **Gotchas**
 *
 * - The service uses global process streams. Acquire it with a scope, or
 *   provide {@link layer}, so raw mode and readline listeners are cleaned up.
 * - When `stdin` is a TTY, raw mode is enabled while the terminal is active and
 *   restored when the scope closes; this changes how keys are delivered and can
 *   affect other stdin consumers.
 * - In pipes, redirected input, or CI, raw mode may be unavailable, keypress
 *   input is limited, and stdout dimensions may be reported as zero.
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
