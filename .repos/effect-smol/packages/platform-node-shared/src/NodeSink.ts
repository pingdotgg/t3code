/**
 * Sink adapters for writing Effect stream chunks into Node writable streams.
 *
 * This module is the writable-stream boundary for Node APIs: push Effect
 * `Stream` or `Channel` chunks into file streams, HTTP request or response
 * bodies, process stdio, sockets, and transform inputs such as compression or
 * encryption streams. It exposes a `Sink` constructor for ordinary stream
 * pipelines plus lower-level `Channel` and pull helpers used by other Node
 * stream adapters.
 *
 * **Mental model**
 *
 * {@link fromWritable} builds a `Sink` for normal stream pipelines.
 * {@link fromWritableChannel} exposes the same bridge as a `Channel`, and
 * {@link pullIntoWritable} is the lower-level loop for adapters that already
 * have a pull and a Node writable. All three write chunks in order and follow
 * Node writable backpressure.
 *
 * **Common tasks**
 *
 * Use {@link fromWritable} to pipe an Effect stream into a Node destination.
 * Use {@link fromWritableChannel} when composing at the `Channel` level. Use
 * {@link pullIntoWritable} inside custom Node stream adapters that need direct
 * control over the upstream pull.
 *
 * **Gotchas**
 *
 * When `write` returns `false`, pulling pauses until `drain` so upstream
 * producers do not overrun the writable buffer. Writable `error` events are
 * mapped through `onError`, and the writable is ended and awaited via `finish`
 * when upstream completes unless `endOnDone` is `false`. Use `endOnDone: false`
 * for externally owned or long-lived writables.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "effect/Array"
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Effect from "effect/Effect"
import { identity, type LazyArg } from "effect/Function"
import * as Pull from "effect/Pull"
import * as Sink from "effect/Sink"
import type { Writable } from "node:stream"

/**
 * Creates a `Sink` that writes chunks to a Node writable stream, respecting
 * backpressure, mapping writable errors with `onError`, and ending the stream
 * on completion unless `endOnDone` is `false`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromWritable = <E, A = Uint8Array | string>(
  options: {
    readonly evaluate: LazyArg<Writable | NodeJS.WritableStream>
    readonly onError: (error: unknown) => E
    readonly endOnDone?: boolean | undefined
    readonly encoding?: BufferEncoding | undefined
  }
): Sink.Sink<void, A, never, E> =>
  Sink.fromChannel(Channel.mapDone(fromWritableChannel<never, E, A>(options), (_) => [_]))

/**
 * Creates a `Channel` that pulls chunks from upstream and writes them to a
 * Node writable stream, respecting backpressure and optionally ending the
 * writable when upstream is done.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromWritableChannel = <IE, E, A = Uint8Array | string>(
  options: {
    readonly evaluate: LazyArg<Writable | NodeJS.WritableStream>
    readonly onError: (error: unknown) => E
    readonly endOnDone?: boolean | undefined
    readonly encoding?: BufferEncoding | undefined
  }
): Channel.Channel<never, IE | E, void, NonEmptyReadonlyArray<A>, IE> =>
  Channel.fromTransform((pull: Pull.Pull<NonEmptyReadonlyArray<A>, IE, unknown>) => {
    const writable = options.evaluate() as Writable
    return Effect.succeed(pullIntoWritable({ ...options, writable, pull }))
  })

/**
 * Writes Effect chunks into a Node writable stream.
 *
 * **When to use**
 *
 * Use to implement custom Node stream adapters that already have an upstream
 * pull and need direct control over a writable stream.
 *
 * **Details**
 *
 * The loop waits for `drain` when needed, fails on writable errors, and ends
 * the writable on upstream completion unless `endOnDone` is `false`.
 *
 * @category converting
 * @since 4.0.0
 */
export const pullIntoWritable = <A, IE, E>(options: {
  readonly pull: Pull.Pull<NonEmptyReadonlyArray<A>, IE, unknown>
  readonly writable: Writable
  readonly onError: (error: unknown) => E
  readonly endOnDone?: boolean | undefined
  readonly encoding?: BufferEncoding | undefined
}): Pull.Pull<never, IE | E, unknown> =>
  options.pull.pipe(
    Effect.flatMap((chunk) => {
      let i = 0
      return Effect.callback<void, E>(function loop(resume) {
        for (; i < chunk.length;) {
          const success = options.writable.write(chunk[i++], options.encoding as any)
          if (!success) {
            options.writable.once("drain", () => (loop as any)(resume))
            return
          }
        }
        resume(Effect.void)
      })
    }),
    Effect.forever({ disableYield: true }),
    Effect.raceFirst(Effect.callback<never, E>((resume) => {
      const onError = (error: unknown) => resume(Effect.fail(options.onError(error)))
      options.writable.once("error", onError)
      return Effect.sync(() => {
        options.writable.off("error", onError)
      })
    })),
    options.endOnDone !== false ?
      Pull.catchDone((_) => {
        if ("closed" in options.writable && options.writable.closed) {
          return Cause.done(_)
        }
        return Effect.callback<never, E | Cause.Done<unknown>>((resume) => {
          options.writable.once("finish", () => resume(Cause.done(_)))
          options.writable.end()
        })
      }) :
      identity
  )
