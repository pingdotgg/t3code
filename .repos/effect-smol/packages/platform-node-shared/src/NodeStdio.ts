/**
 * Shared Node.js implementation of the Effect `Stdio` service.
 *
 * `NodeStdio` provides {@link Stdio.Stdio} from the current Node process. The
 * exported {@link layer} reads command-line arguments from `process.argv`,
 * consumes input from `process.stdin`, and writes normal and error output to
 * `process.stdout` and `process.stderr`. It is the shared implementation used
 * by Node platform packages for CLIs, scripts, command runners, test harnesses,
 * and other process-oriented programs.
 *
 * **Mental model**
 *
 * Application code should depend on `Stdio`; this module decides that the
 * backing resources are the global Node process handles. The layer does not
 * create new streams and does not claim exclusive ownership of the existing
 * ones.
 *
 * **Common tasks**
 *
 * Use {@link layer} when an Effect program needs process arguments, stdin,
 * stdout, or stderr through the service environment. Pair it with terminal
 * services when the same program also needs line editing, raw key input, or
 * terminal dimensions.
 *
 * **Gotchas**
 *
 * Process stdio streams are shared with the rest of the Node process. This
 * layer leaves stdin open and does not end stdout or stderr by default, avoiding
 * accidental closure of handles that other code may still use. The streams may
 * be pipes, files, or TTYs; terminal-specific behavior such as raw mode, echo,
 * color detection, and cursor movement belongs with terminal APIs.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { systemError } from "effect/PlatformError"
import * as Stdio from "effect/Stdio"
import { fromWritable } from "./NodeSink.ts"
import { fromReadable } from "./NodeStream.ts"

/**
 * Provides `Stdio` from `process.argv`, `process.stdin`, `process.stdout`,
 * and `process.stderr`; stdin remains open and stdout/stderr are not ended by
 * default.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Stdio.Stdio> = Layer.succeed(
  Stdio.Stdio,
  Stdio.make({
    args: Effect.sync(() => process.argv.slice(2)),
    stdout: (options) =>
      fromWritable({
        evaluate: () => process.stdout,
        onError: (cause) =>
          systemError({
            module: "Stdio",
            method: "stdout",
            _tag: "Unknown",
            cause
          }),
        endOnDone: options?.endOnDone ?? false
      }),
    stderr: (options) =>
      fromWritable({
        evaluate: () => process.stderr,
        onError: (cause) =>
          systemError({
            module: "Stdio",
            method: "stderr",
            _tag: "Unknown",
            cause
          }),
        endOnDone: options?.endOnDone ?? false
      }),
    stdin: fromReadable({
      evaluate: () => process.stdin,
      onError: (cause) =>
        systemError({
          module: "Stdio",
          method: "stdin",
          _tag: "Unknown",
          cause
        }),
      closeOnDone: false
    })
  })
)
