/**
 * @title Using Effect.fn
 *
 * When writing functions that return an Effect, use `Effect.fn` to use the
 * generator syntax.
 *
 * **Avoid creating functions that return an Effect.gen**, use `Effect.fn`
 * instead.
 */

import { Effect, Schema } from "effect"

// Pass a string to Effect.fn, which will improve stack traces and also
// attach a tracing span (using Effect.withSpan behind the scenes).
//
// The name string should match the function name.
//
export const effectFunction = Effect.fn("effectFunction")(
  // You can use `Effect.fn.Return` to specify the return type of the function.
  // It accepts the same type parameters as `Effect.Effect`.
  function*(n: number): Effect.fn.Return<string, SomeError> {
    yield* Effect.logInfo("Received number:", n)

    // Always return when raising an error, to ensure typescript understands that
    // the function will not continue executing.
    return yield* new SomeError({ message: "Failed to read the file" })
  },
  // Add additional functionality by passing in additional arguments.
  // **Do not** use .pipe with Effect.fn
  Effect.catch((error) => Effect.logError(`An error occurred: ${error}`)),
  Effect.annotateLogs({
    method: "effectFunction"
  })
)

// Use Schema.TaggedErrorClass to define a custom error
export class SomeError extends Schema.TaggedErrorClass<SomeError>()("SomeError", {
  message: Schema.String
}) {}
