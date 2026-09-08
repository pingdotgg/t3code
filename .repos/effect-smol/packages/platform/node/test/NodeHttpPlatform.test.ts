import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import { Readable } from "node:stream"

const readStream = (stream: Readable) =>
  Effect.promise(async () => {
    let text = ""
    for await (const chunk of stream) {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    }
    return text
  })

describe("NodeHttpPlatform", () => {
  it.effect("fileResponse reads exact bytesToRead", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse(`${__dirname}/fixtures/text.txt`, {
        offset: 6,
        bytesToRead: 5
      })

      assert.strictEqual(response.headers["content-length"], "5")
      assert.strictEqual(response.body._tag, "Raw")
      const body = (response.body as HttpBody.Raw).body
      assert(body instanceof Readable)

      const text = yield* readStream(body)
      assert.strictEqual(text, "ipsum")
    }).pipe(Effect.provide(NodeHttpPlatform.layer)))

  it.effect("fileResponse supports zero bytesToRead", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse(`${__dirname}/fixtures/text.txt`, {
        offset: 6,
        bytesToRead: 0
      })

      assert.strictEqual(response.headers["content-length"], "0")
      assert.strictEqual(response.body._tag, "Raw")
      const body = (response.body as HttpBody.Raw).body
      assert(body instanceof Readable)

      const text = yield* readStream(body)
      assert.strictEqual(text, "")
    }).pipe(Effect.provide(NodeHttpPlatform.layer)))
})
