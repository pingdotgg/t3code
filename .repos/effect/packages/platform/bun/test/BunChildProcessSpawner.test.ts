import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { assert, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ChildProcess } from "effect/process"
import * as Stream from "effect/Stream"

const layer = BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))

it.live.skipIf(process.platform === "win32")(
  "scope release terminates a child that never reads a backpressured stdin stream",
  () =>
    Effect.gen(function*() {
      const handle = yield* Effect.scoped(Effect.gen(function*() {
        const handle = yield* ChildProcess.make("sleep", ["600"], {
          stdin: Stream.forever(Stream.succeed(new Uint8Array(64 * 1024)))
        })
        yield* Effect.sleep("200 millis")
        return handle
      }))

      assert.isFalse(yield* handle.isRunning)
    }).pipe(Effect.provide(layer))
)
