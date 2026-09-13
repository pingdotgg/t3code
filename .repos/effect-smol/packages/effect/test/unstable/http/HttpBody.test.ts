import { assert, it } from "@effect/vitest"
import { Effect, FileSystem, Stream } from "effect"
import { HttpBody } from "effect/unstable/http"

it.effect("uses the selected byte count as partial file content length", () =>
  Effect.gen(function*() {
    const body = yield* HttpBody.fileFromInfo("x", { size: 6n } as any, { offset: 2, bytesToRead: 2 }).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        stream: () => Stream.succeed(new Uint8Array([3, 4]))
      } as any)
    )
    const bytes = yield* Stream.mkUint8Array(body.stream)
    assert.strictEqual(body.contentLength, bytes.length)
  }))
