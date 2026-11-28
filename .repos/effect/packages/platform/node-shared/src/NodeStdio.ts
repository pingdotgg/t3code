/**
 * Shared Node.js implementation of the Effect `Stdio` service.
 *
 * `NodeStdio` provides {@link Stdio.Stdio} from the current Node process. The
 * exported {@link layer} reads command-line arguments from `process.argv`,
 * consumes input from `process.stdin`, and writes normal and error output to
 * `process.stdout` and `process.stderr`. Standard input remains open, and
 * standard output and error output are not ended unless requested.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { systemError } from "effect/PlatformError"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { fromWritable } from "./NodeSink.ts"
import { fromReadable } from "./NodeStream.ts"

// Node only stops reading stdin on `pause`, and `pause` is a no-op until the
// tick after the last `readable` listener is removed. Register this before
// `fromReadable` so it runs after that listener cleanup.
const pauseStdin = Effect.sync(() => {
  process.nextTick(() => {
    if (process.stdin.readableFlowing === null) {
      process.stdin.pause()
    }
  })
})

/**
 * Provides `Stdio` from `process.argv`, `process.stdin`, `process.stdout`,
 * and `process.stderr`; stdin remains open and stdout/stderr are not ended by
 * default.
 *
 * **Gotchas**
 *
 * When the last `Stdio.stdin` consumer finishes or is interrupted,
 * `process.stdin` is paused so the Node process can exit without waiting for
 * stdin EOF. Later `Stdio.stdin` consumers resume reading automatically, but
 * raw `process.stdin.on("data", ...)` listeners attached afterwards must call
 * `process.stdin.resume()`.
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<Stdio.Stdio> = Layer.succeed(
  Stdio.Stdio,
  Stdio.make({
    args: Effect.sync(() => process.argv.slice(2)),
    stdinIsTerminal: Effect.sync(() => process.stdin.isTTY === true),
    stdoutIsTerminal: Effect.sync(() => process.stdout.isTTY === true),
    stderrIsTerminal: Effect.sync(() => process.stderr.isTTY === true),
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
    stdin: Stream.unwrap(
      Effect.as(
        Effect.addFinalizer(() => pauseStdin),
        fromReadable({
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
      )
    )
  })
)
