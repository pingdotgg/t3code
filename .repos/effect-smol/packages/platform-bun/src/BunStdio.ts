/**
 * Process stdio for Bun applications.
 *
 * This module provides the Bun layer for Effect's `Stdio` service by adapting
 * the current process arguments and standard streams. Arguments come from
 * `process.argv`, input is read from `process.stdin`, and output and error
 * output write to `process.stdout` and `process.stderr`.
 *
 * **Mental model**
 *
 * `BunStdio.layer` is a thin Bun-facing wrapper around the shared
 * Node-compatible stdio implementation. It does not create private streams for
 * an application; it exposes the global streams owned by the running Bun
 * process through the `Stdio` service.
 *
 * **Common tasks**
 *
 * - Provide `Stdio` for Bun CLIs, scripts, command runners, and tests.
 * - Read process arguments or standard input through Effect services.
 * - Write normal output and diagnostics without depending directly on
 *   `process.stdout` or `process.stderr`.
 *
 * **Gotchas**
 *
 * The layer keeps stdin open and does not end stdout or stderr by default,
 * which avoids closing handles that prompts, loggers, or other code may still
 * use. Stdio may be attached to a TTY, pipe, or redirected file, so
 * terminal-specific behavior such as raw mode, echo, colors, cursor control,
 * and terminal dimensions should be handled with terminal APIs such as
 * `BunTerminal`, not inferred from this layer.
 *
 * @since 4.0.0
 */
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import type * as Layer from "effect/Layer"
import type { Stdio } from "effect/Stdio"

/**
 * Provides the `Stdio` service backed by the current process arguments,
 * stdin, stdout, and stderr streams.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Stdio> = NodeStdio.layer
