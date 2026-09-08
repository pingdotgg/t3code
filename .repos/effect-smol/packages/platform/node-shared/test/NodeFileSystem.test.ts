import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { testLayer } from "../../../effect/test/FileSystem.test-utils.ts"

const startWatch = <E, R>(
  fs: FileSystem.FileSystem,
  root: string,
  watch: () => Stream.Stream<FileSystem.WatchEvent, E, R>
) =>
  Effect.gen(function*() {
    const ready = yield* Deferred.make<void>()
    const readyName = ".watch-ready"
    const fiber = yield* watch().pipe(
      Stream.tap((event) =>
        event.path === readyName
          ? Deferred.succeed(ready, undefined)
          : Effect.void
      ),
      Stream.dropUntil((event) => event.path === readyName),
      Stream.filter((event) => event.path !== readyName),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
      Effect.forkChild
    )
    const signalFiber = yield* Effect.sleep("10 millis").pipe(
      TestClock.withLive,
      Effect.andThen(fs.writeFileString(`${root}/${readyName}`, "")),
      Effect.forever,
      Effect.forkChild
    )
    yield* Deferred.await(ready).pipe(
      Effect.raceFirst(Fiber.join(fiber).pipe(Effect.asVoid)),
      Effect.ensuring(Fiber.interrupt(signalFiber))
    )
    return fiber
  })

describe("FileSystem", () => {
  testLayer(NodeFileSystem.layer)

  it.effect("watch does not report nested changes when recursive is false", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const nested = `${root}/nested`
      yield* fs.makeDirectory(nested)

      const fiber = yield* startWatch(fs, root, () => fs.watch(root, { recursive: false }))

      yield* fs.writeFileString(`${nested}/nested.txt`, "")
      yield* fs.writeFileString(`${root}/direct.txt`, "")

      const event = yield* Fiber.join(fiber)
      assert.strictEqual(event.path, "direct.txt")
    }).pipe(
      Effect.provide(NodeFileSystem.layer)
    ))

  it.effect("watch is non-recursive when options are omitted", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const nested = `${root}/nested`
      yield* fs.makeDirectory(nested)

      const fiber = yield* startWatch(fs, root, () => fs.watch(root))

      yield* fs.writeFileString(`${nested}/nested.txt`, "")
      yield* fs.writeFileString(`${root}/direct.txt`, "")

      const event = yield* Fiber.join(fiber)
      assert.strictEqual(event.path, "direct.txt")
    }).pipe(
      Effect.provide(NodeFileSystem.layer)
    ))

  it.effect("watch reports nested changes when recursive is true", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped()
      const nested = `${root}/nested`
      yield* fs.makeDirectory(nested)

      const fiber = yield* startWatch(fs, root, () => fs.watch(root, { recursive: true }))

      yield* fs.writeFileString(`${nested}/nested.txt`, "")

      const event = yield* Fiber.join(fiber)
      assert(event.path.endsWith("nested.txt"))
    }).pipe(
      Effect.provide(NodeFileSystem.layer)
    ))
})
