/**
 * Bun stream interoperability for Effect streams.
 *
 * This module is the Bun entry point for adapting runtime streams into Effect's
 * streaming model. It re-exports the shared Node stream adapters for Bun's
 * Node-compatible stream APIs and adds {@link fromReadableStream}, a Web
 * `ReadableStream` adapter that uses Bun's `readMany` reader method to pull
 * batches of values into an Effect `Stream`.
 *
 * **Mental model**
 *
 * Consuming the returned `Stream` drives reads from the underlying
 * `ReadableStreamDefaultReader`. Each pull asks Bun for the next batch, empty
 * batches are skipped, read failures are translated with `onError`, and the
 * reader is finalized with the surrounding Effect scope.
 *
 * **Common tasks**
 *
 * Use {@link fromReadableStream} for Bun `Request` and `Response` bodies,
 * multipart uploads, and other Web stream sources that should be transformed,
 * decoded, or piped with Effect stream operators. Use the re-exported Node
 * stream adapters for APIs that expose Bun's Node-compatible `stream` types.
 *
 * **Gotchas**
 *
 * Web stream readers hold an exclusive lock. Request and response bodies are
 * also one-shot; once consumed they are disturbed and should not be read through
 * another API. By default finalization cancels the reader; set
 * `releaseLockOnEnd` when the stream is externally owned and only the reader
 * lock should be released.
 *
 * @since 4.0.0
 */
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Channel from "effect/Channel"
import * as Effect from "effect/Effect"
import type { LazyArg } from "effect/Function"
import type * as Pull from "effect/Pull"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"

/**
 * @since 4.0.0
 */
export * from "@effect/platform-node-shared/NodeStream"

/**
 * Creates a stream from a `ReadableStream` using Bun's optimized `.readMany`
 * API.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromReadableStream = <A, E>(
  options: {
    readonly evaluate: LazyArg<ReadableStream<A>>
    readonly onError: (error: unknown) => E
    readonly releaseLockOnEnd?: boolean | undefined
  }
): Stream.Stream<A, E> =>
  Stream.fromChannel(Channel.fromTransform(Effect.fnUntraced(function*(_, scope) {
    const reader = options.evaluate().getReader()
    yield* Scope.addFinalizer(
      scope,
      options.releaseLockOnEnd ? Effect.sync(() => reader.releaseLock()) : Effect.promise(() => reader.cancel())
    )
    const readMany = Effect.callback<Bun.ReadableStreamDefaultReadManyResult<A>, E>((resume) => {
      const result = reader.readMany()
      if ("then" in result) {
        result.then((_) => resume(Effect.succeed(_)), (e) => resume(Effect.fail(options.onError(e))))
      } else {
        resume(Effect.succeed(result))
      }
    })
    // @effect-diagnostics-next-line returnEffectInGen:off
    return Effect.flatMap(
      readMany,
      function loop(
        { done, value }
      ): Pull.Pull<Arr.NonEmptyReadonlyArray<A>, E> {
        if (done) {
          return Cause.done()
        } else if (!Arr.isReadonlyArrayNonEmpty(value)) {
          return Effect.flatMap(readMany, loop)
        }
        return Effect.succeed(value)
      }
    )
  })))
