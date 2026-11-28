import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

const program = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  const echoChunk = stdio.stdin.pipe(Stream.take(1), Stream.run(stdio.stdout()))

  yield* echoChunk
  // Let the deferred pause run, so the next read resumes a paused stdin.
  yield* Effect.sleep("20 millis")
  yield* echoChunk

  yield* stdio.stdin.pipe(Stream.runDrain, Effect.timeoutOption("50 millis"))
}).pipe(Effect.provide(NodeStdio.layer))

void Effect.runPromise(program)
