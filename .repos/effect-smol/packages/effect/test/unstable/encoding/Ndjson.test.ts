import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as Schema from "effect/Schema"
import * as Ndjson from "effect/unstable/encoding/Ndjson"

describe("Ndjson", () => {
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
