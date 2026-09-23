import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import { assert, describe, it } from "@effect/vitest"
import * as ByteSize from "effect/ByteSize"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Etag from "effect/unstable/http/Etag"
import type * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as Fs from "node:fs"
import { Readable } from "node:stream"
import { afterEach, beforeEach, vi } from "vitest"
import { fileSystemLayer } from "../../node-shared/test/HttpPlatform.test-utils.ts"

const readStream = (stream: Readable) =>
  Effect.promise(async () => {
    let text = ""
    for await (const chunk of stream) {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    }
    return text
  })

describe("NodeHttpPlatform", { concurrent: false }, () => {
  it.effect("fileResponse reads exact bytesToRead", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse(`${__dirname}/fixtures/text.txt`, {
        offset: ByteSize.bytes(6),
        bytesToRead: ByteSize.bytes(5)
      })

      assert.strictEqual(response.headers["content-length"], "5")
      assert.strictEqual(response.headers["content-type"], "text/plain")
      assert.strictEqual(response.body._tag, "Raw")
      const body = (response.body as HttpBody.Raw).body
      assert(body instanceof Readable)

      const text = yield* readStream(body)
      assert.strictEqual(text, "ipsum")
    }).pipe(Effect.provide(NodeHttpPlatform.layer)))

  for (
    const { name, offset, bytesToRead, expected } of [
      { name: "clamps bytesToRead beyond EOF", offset: 22, bytesToRead: 100, expected: "amet\n" },
      { name: "returns an empty body at EOF", offset: 27, bytesToRead: undefined, expected: "" },
      { name: "returns an empty body past EOF", offset: 50, bytesToRead: undefined, expected: "" },
      { name: "clamps bytesToRead at EOF", offset: 27, bytesToRead: 100, expected: "" },
      { name: "clamps bytesToRead past EOF", offset: 50, bytesToRead: 100, expected: "" }
    ]
  ) {
    it.effect(`fileResponse ${name}`, () =>
      Effect.gen(function*() {
        const platform = yield* HttpPlatform.HttpPlatform
        const response = yield* platform.fileResponse(`${__dirname}/fixtures/text.txt`, {
          offset: ByteSize.bytes(offset),
          bytesToRead: bytesToRead === undefined ? undefined : ByteSize.bytes(bytesToRead)
        })

        assert.strictEqual(response.body._tag, "Raw")
        const text = yield* readStream((response.body as HttpBody.Raw).body as Readable)
        assert.deepStrictEqual(
          { contentLength: response.headers["content-length"], body: text },
          { contentLength: String(expected.length), body: expected }
        )
      }).pipe(Effect.provide(NodeHttpPlatform.layer)))
  }

  it.effect("fileResponse supports zero bytesToRead", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse(`${__dirname}/fixtures/text.txt`, {
        offset: ByteSize.bytes(6),
        bytesToRead: ByteSize.zero
      })

      assert.strictEqual(response.headers["content-length"], "0")
      assert.strictEqual(response.body._tag, "Raw")
      const body = (response.body as HttpBody.Raw).body
      assert(body instanceof Readable)

      const text = yield* readStream(body)
      assert.strictEqual(text, "")
    }).pipe(Effect.provide(NodeHttpPlatform.layer)))

  it.effect("fileWebResponse looks up content types case-insensitively", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileWebResponse(new File(["<h1>Effect</h1>"], "INDEX.HTML"))

      assert.strictEqual(response.headers["content-type"], "text/html")
    }).pipe(Effect.provide(NodeHttpPlatform.layer)))
})

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof Fs>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

describe("NodeHttpPlatform precision", { concurrent: false }, () => {
  beforeEach(() => {
    vi.mocked(Fs.createReadStream).mockImplementation(() => Readable.from([]) as Fs.ReadStream)
  })
  afterEach(() => {
    vi.mocked(Fs.createReadStream).mockReset()
  })

  const layer = Layer.effect(HttpPlatform.HttpPlatform)(NodeHttpPlatform.make).pipe(
    Layer.provide(fileSystemLayer),
    Layer.provide(Etag.layer)
  )

  it.effect("passes a safe range to the runtime with the correct end bound", () =>
    Effect.gen(function*() {
      const maxSafe = Number.MAX_SAFE_INTEGER
      const platform = yield* HttpPlatform.HttpPlatform
      yield* platform.fileResponse("precision.bin", { offset: maxSafe - 1, bytesToRead: 1 })
      assert.deepStrictEqual(vi.mocked(Fs.createReadStream).mock.calls, [["precision.bin", {
        start: maxSafe - 1,
        end: maxSafe - 1
      }]])
    }).pipe(Effect.provide(layer)))

  it.effect("serves a whole oversized file with an exact content length and no end offset", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileResponse("precision.bin")
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers["content-length"], "9007199254740993")
      assert.deepStrictEqual(vi.mocked(Fs.createReadStream).mock.calls, [["precision.bin", {
        start: 0,
        end: undefined
      }]])
    }).pipe(Effect.provide(layer)))
})
