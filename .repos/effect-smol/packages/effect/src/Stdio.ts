/**
 * Service contract for process standard input, output, error output, and
 * command-line arguments.
 *
 * `Stdio` lets command-line programs depend on standard I/O through the Effect
 * environment instead of reading from or writing to global process handles
 * directly. The service exposes arguments as an `Effect`, stdout and stderr as
 * `Sink`s that accept strings or bytes, and stdin as a byte `Stream`.
 *
 * **Mental model**
 *
 * Application code describes what it needs from standard I/O, and a runtime
 * layer supplies the concrete streams. Platform packages provide real process
 * implementations, while tests can use `Stdio.layerTest` to replace only the
 * fields that matter for a scenario and keep the rest inert.
 *
 * **Common tasks**
 *
 * - Read command-line arguments from the service's `args` effect.
 * - Write text or bytes by running values into the service's `stdout()` or
 *   `stderr()` sinks.
 * - Consume `stdin` as a stream of `Uint8Array` chunks.
 * - Build deterministic tests with `Stdio.layerTest`.
 *
 * **Gotchas**
 *
 * Standard I/O is a platform capability. Reads and writes can fail with
 * `PlatformError`, so handle failures in the Effect error channel instead of
 * assuming the process streams are always available.
 *
 * @since 4.0.0
 */
import * as Context from "./Context.ts"
import * as Effect from "./Effect.ts"
import * as Layer from "./Layer.ts"
import type { PlatformError } from "./PlatformError.ts"
import * as Sink from "./Sink.ts"
import * as Stream from "./Stream.ts"

/**
 * String literal type used as the unique brand for the `Stdio` service.
 *
 * **When to use**
 *
 * Use to type the runtime identifier stored on `Stdio` service implementations.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/Stdio"

/**
 * Runtime identifier stored on `Stdio` service implementations.
 *
 * **Details**
 *
 * This marker is part of the runtime representation of `Stdio` service
 * implementations.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/Stdio"

/**
 * Defines the service interface for process standard I/O.
 *
 * **When to use**
 *
 * Use to depend on command-line arguments and standard I/O through the Effect
 * environment.
 *
 * **Details**
 *
 * The service provides command-line arguments, sinks for standard output and
 * standard error, and a stream of standard input bytes. I/O operations can fail
 * with `PlatformError`.
 *
 * @category models
 * @since 4.0.0
 */
export interface Stdio {
  readonly [TypeId]: TypeId
  readonly args: Effect.Effect<ReadonlyArray<string>>
  stdout(options?: {
    readonly endOnDone?: boolean | undefined
  }): Sink.Sink<void, string | Uint8Array, never, PlatformError>
  stderr(options?: {
    readonly endOnDone?: boolean | undefined
  }): Sink.Sink<void, string | Uint8Array, never, PlatformError>
  readonly stdin: Stream.Stream<Uint8Array, PlatformError>
}
/**
 * Service tag for process standard I/O.
 *
 * **When to use**
 *
 * Use when an effect needs command-line arguments or standard I/O streams
 * supplied by its environment.
 *
 * @see {@link make} for constructing a `Stdio` service directly
 * @see {@link layerTest} for a test layer with defaults and overrides
 *
 * @category services
 * @since 4.0.0
 */
export const Stdio: Context.Service<Stdio, Stdio> = Context.Service<Stdio>(TypeId)

/**
 * Creates a `Stdio` service implementation from the provided fields and
 * attaches the `Stdio` type identifier.
 *
 * **When to use**
 *
 * Use to assemble a concrete `Stdio` service when you already have
 * implementations for command-line arguments, standard output, standard error,
 * and standard input.
 *
 * **Details**
 *
 * The returned service reuses the supplied fields unchanged and only adds the
 * `Stdio` type identifier; it does not create a `Layer` or provide defaults.
 *
 * @see {@link layerTest} for a test layer with default fields that can be overridden
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (options: Omit<Stdio, TypeId>): Stdio => ({
  [TypeId]: TypeId,
  ...options
})

/**
 * Creates a test layer for `Stdio`.
 *
 * **When to use**
 *
 * Use to provide deterministic standard I/O in tests while overriding only the
 * command-line arguments, input stream, or output sinks relevant to the case.
 *
 * **Details**
 *
 * Any provided fields override defaults. By default, arguments are empty,
 * standard output and error are draining sinks, and standard input is an empty
 * stream.
 *
 * @see {@link make} for constructing a `Stdio` service directly without a `Layer` or defaults
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTest = (impl: Partial<Stdio>): Layer.Layer<Stdio> =>
  Layer.succeed(
    Stdio,
    make({
      args: Effect.succeed([]),
      stdout: () => Sink.drain,
      stderr: () => Sink.drain,
      stdin: Stream.empty,
      ...impl
    })
  )
