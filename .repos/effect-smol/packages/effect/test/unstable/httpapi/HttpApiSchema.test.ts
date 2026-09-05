import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

const getStreamMetadata = (self: HttpApiSchema.StreamSchema) =>
  self._tag === "StreamSse" ?
    {
      mode: self.mode,
      sseMode: self.sseMode,
      contentType: self.contentType,
      events: self.events,
      error: self.error
    } :
    {
      mode: self.mode,
      contentType: self.contentType
    }

describe("HttpApiSchema", () => {
  describe("StreamSse", () => {
    it("stores default metadata", () => {
      const events = Schema.Struct({
        event: Schema.Literal("user.created"),
        data: Schema.String
      })
      const error = Schema.Struct({ reason: Schema.String })
      const stream = HttpApiSchema.StreamSse({ events, error })

      assert.isTrue(Schema.isSchema(stream))
      assert.isTrue(HttpApiSchema.isStreamSchema(stream))
      assert.isTrue(HttpApiSchema.isStreamSse(stream))
      assert.isFalse(HttpApiSchema.isStreamUint8Array(stream))
      assert.strictEqual(stream.mode, "sse")
      assert.strictEqual(stream.sseMode, "events")
      assert.strictEqual(stream.contentType, "text/event-stream")
      assert.strictEqual(stream.events, events)
      assert.strictEqual(stream.error, error)

      const metadata = getStreamMetadata(stream)
      assert.strictEqual(metadata.mode, "sse")
      assert.strictEqual(metadata.contentType, "text/event-stream")
      if (metadata.mode === "sse") {
        assert.strictEqual(metadata.sseMode, "events")
        assert.strictEqual(metadata.events, events)
        assert.strictEqual(metadata.error, error)
      }
    })

    it("stores custom content type", () => {
      const events = Schema.Struct({
        event: Schema.Literal("custom"),
        data: Schema.String
      })
      const error = Schema.String
      const stream = HttpApiSchema.StreamSse({
        contentType: "text/event-stream; charset=utf-8",
        events,
        error
      })

      assert.strictEqual(stream.contentType, "text/event-stream; charset=utf-8")
    })

    it("defaults the stream error schema to Never", () => {
      const events = Schema.Struct({
        event: Schema.Literal("custom"),
        data: Schema.String
      })
      const stream = HttpApiSchema.StreamSse({ events })

      assert.strictEqual(stream.error, Schema.Never)
    })

    it("creates an event schema from a JSON data schema", () => {
      const Data = Schema.Struct({ id: Schema.String })
      const error = Schema.Struct({ reason: Schema.String })
      const stream = HttpApiSchema.StreamSse({ data: Data, error })
      const encode = Schema.encodeUnknownSync(stream.events)
      const decode = Schema.decodeUnknownSync(stream.events)

      assert.strictEqual(stream.sseMode, "data")
      assert.deepStrictEqual(
        encode({ id: undefined, event: "user.created", data: { id: "123" } }),
        { id: undefined, event: "user.created", data: "{\"id\":\"123\"}" }
      )
      assert.deepStrictEqual(
        decode({ id: undefined, event: "user.created", data: "{\"id\":\"123\"}" }),
        { id: undefined, event: "user.created", data: { id: "123" } }
      )
    })
  })

  describe("StreamUint8Array", () => {
    it("stores default metadata", () => {
      const stream = HttpApiSchema.StreamUint8Array()

      assert.isTrue(Schema.isSchema(stream))
      assert.isTrue(HttpApiSchema.isStreamSchema(stream))
      assert.isFalse(HttpApiSchema.isStreamSse(stream))
      assert.isTrue(HttpApiSchema.isStreamUint8Array(stream))
      assert.strictEqual(stream.mode, "uint8array")
      assert.strictEqual(stream.contentType, "application/octet-stream")
      assert.deepStrictEqual(getStreamMetadata(stream), {
        mode: "uint8array",
        contentType: "application/octet-stream"
      })
    })

    it("stores custom content type", () => {
      const stream = HttpApiSchema.StreamUint8Array({
        contentType: "application/custom-binary"
      })

      assert.strictEqual(stream.contentType, "application/custom-binary")
    })
  })

  it("does not identify buffered schemas as stream schemas", () => {
    assert.isFalse(HttpApiSchema.isStreamSchema(Schema.String))
    assert.isFalse(HttpApiSchema.isStreamSchema(Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array())))
  })
})
