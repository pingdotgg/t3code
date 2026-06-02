/**
 * Node.js `Stdio` layer for the current process.
 *
 * The exported layer satisfies the platform-independent `Stdio` service by
 * reading command-line arguments from `process.argv`, consuming input from
 * `process.stdin`, and writing output streams to `process.stdout` and
 * `process.stderr`. It is the stdio bridge used by CLIs, scripts, command
 * runners, and tests that intentionally communicate through the host process.
 *
 * **Mental model**
 *
 * Effects should depend on `Stdio`; this module decides that the backing
 * streams are the global Node process handles. Provide `NodeStdio.layer` when a
 * program only needs standard input and output, or `NodeServices.layer` when the
 * same entrypoint also needs the other default Node services.
 *
 * **Gotchas**
 *
 * The process stdio streams are shared resources. The layer leaves stdin open
 * and does not end stdout or stderr by default, avoiding accidental closure of
 * handles that other code in the same process may still use. Stdio might be a
 * pipe, file, or TTY; terminal-specific behavior such as raw mode, echo, color
 * detection, and cursor movement belongs with terminal APIs rather than this
 * service.
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
