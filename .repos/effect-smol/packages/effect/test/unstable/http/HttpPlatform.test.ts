import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { HttpPlatform } from "effect/unstable/http"

describe("HttpPlatform", () => {
  const file = {
    name: "file.bin",
    lastModified: 0,
    size: 4,
    type: "application/octet-stream",
    stream: () => new Blob([new Uint8Array([1, 2, 3, 4])]).stream()
  }

  it.effect("honors Web file offset and byte count", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileWebResponse(file, { offset: 1, bytesToRead: 2 })
      assert.strictEqual(response.body._tag, "Stream")
      if (response.body._tag === "Stream") {
        assert.strictEqual(response.body.contentLength, 2)
        const bytes = yield* Stream.mkUint8Array(response.body.stream)
        assert.deepStrictEqual(Array.from(bytes), [2, 3])
      }
    }).pipe(
      Effect.provide(HttpPlatform.layer),
      Effect.provideService(FileSystem.FileSystem, {} as any)
    ))

  it.effect("honors Web file chunk size", () =>
    Effect.gen(function*() {
      const platform = yield* HttpPlatform.HttpPlatform
      const response = yield* platform.fileWebResponse(file, { offset: 0, bytesToRead: 4, chunkSize: 2 })
      assert.strictEqual(response.body._tag, "Stream")
      if (response.body._tag === "Stream") {
        assert.strictEqual(response.body.contentLength, 4)
        const chunks = yield* Stream.runCollect(response.body.stream)
        assert.deepStrictEqual(chunks.map((chunk) => Array.from(chunk)), [[1, 2], [3, 4]])
      }
    }).pipe(
      Effect.provide(HttpPlatform.layer),
      Effect.provideService(FileSystem.FileSystem, {} as any)
    ))
})
