import { assert, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as Msgpack from "effect/unstable/encoding/Msgpack"
import { encode } from "msgpackr"

it.effect("fails when the stream ends with an incomplete MessagePack frame", () =>
  Effect.gen(function*() {
    const frame = Uint8Array.from(encode("hello"))
    const error = yield* Stream.make(frame.subarray(0, frame.length - 1)).pipe(
      Stream.pipeThroughChannel(Msgpack.decode()),
      Stream.runCollect,
      Effect.flip
    )

    assert.instanceOf(error, Msgpack.MsgPackError)
  }))
