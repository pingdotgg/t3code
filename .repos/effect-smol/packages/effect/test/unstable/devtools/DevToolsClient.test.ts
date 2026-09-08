import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import { DevToolsClient } from "effect/unstable/devtools"
import { Socket } from "effect/unstable/socket"

describe("DevToolsClient", () => {
  it.effect("sends a short-lived span once in each state", () =>
    Effect.gen(function*() {
      const spans: Array<any> = []
      const received = yield* Deferred.make<void>()
      const socket = Socket.make({
        runRaw: (handler) =>
          Effect.suspend(() => {
            const result = handler("{\"_tag\":\"Pong\"}\n")
            return Effect.isEffect(result) ? result : Effect.void
          }).pipe(Effect.andThen(Effect.never)),
        writer: Effect.succeed((chunk) =>
          Effect.sync(() => {
            if (Socket.isCloseEvent(chunk)) return false
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
            for (const line of text.trim().split("\n")) {
              if (line.length === 0) continue
              const message = JSON.parse(line)
              if (message._tag === "Span") spans.push(message)
            }
            return spans.length >= 2
          }).pipe(
            Effect.flatMap((done) => done ? Deferred.succeed(received, void 0) : Effect.void),
            Effect.asVoid
          )
        )
      })

      yield* Effect.gen(function*() {
        yield* Effect.void.pipe(Effect.withSpan("child"))
        yield* Deferred.await(received)
      }).pipe(
        Effect.provide(
          DevToolsClient.layerTracer.pipe(
            Layer.provide(Layer.succeed(Socket.Socket, socket))
          )
        )
      )

      assert.deepStrictEqual(spans.map((span) => span.status._tag), ["Started", "Ended"])
    }))
})
