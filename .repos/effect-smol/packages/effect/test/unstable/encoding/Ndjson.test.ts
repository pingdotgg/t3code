import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as Schema from "effect/Schema"
import * as Ndjson from "effect/unstable/encoding/Ndjson"

describe("Ndjson", () => {
  it.effect("fails for values without a JSON representation", () =>
    Effect.gen(function*() {
      const inputs = [undefined, () => {}, Symbol("x")]

      for (const input of inputs) {
        const error = yield* Stream.make(input).pipe(
          Stream.pipeThroughChannel(Ndjson.encodeString()),
          Stream.runCollect,
          Effect.flip
        )

        assert.instanceOf(error, Ndjson.NdjsonError)
        assert.strictEqual(error.kind, "Pack")
      }
    }))

  it.effect("decodeSchema decodes records split across Uint8Array chunks", () =>
    Effect.gen(function*() {
      const messages = yield* Stream.make(
        new TextEncoder().encode("{\"foo\":\"bar\"}\n")
      ).pipe(
        Stream.pipeThroughChannel(Ndjson.decodeSchema(Schema.Struct({ foo: Schema.String }))()),
        Stream.runCollect
      )

      assert.deepStrictEqual([...messages], [{ foo: "bar" }])
    }))
})
