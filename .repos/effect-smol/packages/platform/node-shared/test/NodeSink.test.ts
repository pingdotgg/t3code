import * as NodeSink from "@effect/platform-node-shared/NodeSink"
import * as NodeStream from "@effect/platform-node-shared/NodeStream"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Data from "effect/Data"
import * as Latch from "effect/Latch"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { createReadStream } from "fs"
import { join } from "path"
import { Writable } from "stream"
import * as Tar from "tar"

const TEST_TARBALL = join(__dirname, "fixtures", "helloworld.tar.gz")

describe("Sink", () => {
  it.effect("should write to a stream", () =>
    Effect.gen(function*() {
      const items: Array<string> = []
      const destroyLatch = yield* Latch.make()
      yield* Stream.make("a", "b", "c").pipe(
        Stream.run(NodeSink.fromWritable({
          evaluate: () =>
            new Writable({
              construct(callback) {
                callback()
              },
              write(chunk, _encoding, callback) {
                items.push(chunk.toString())
                callback()
              },
              destroy(_error, callback) {
                destroyLatch.openUnsafe()
                callback(null)
              }
            }),
          onError: () => "error"
        }))
      )
      assert.deepEqual(items, ["a", "b", "c"])
      yield* destroyLatch.await
    }))

  it.effect("write error", () =>
    Effect.gen(function*() {
      const items: Array<string> = []
      const sink = NodeSink.fromWritable({
        evaluate: () =>
          new Writable({
            construct(callback) {
              callback()
            },
            write(chunk, _encoding, callback) {
              items.push(chunk.toString())
              callback()
            },
            destroy(_error, callback) {
              callback(null)
            }
          }),
        onError: () => "error"
      })
      const result = yield* Stream.fail("a").pipe(Stream.run(sink), Effect.flip)
      assert.deepEqual(items, [])
      assert.strictEqual(result, "a")
    }))

  it.live("endOnClose false", () =>
    Effect.gen(function*() {
      const items: Array<string> = []
      let destroyed = false
      const sink = NodeSink.fromWritable({
        evaluate: () =>
          new Writable({
            construct(callback) {
              callback()
            },
            write(chunk, _encoding, callback) {
              items.push(chunk.toString())
              callback()
            },
            destroy(_error, callback) {
              destroyed = true
              callback(null)
            }
          }),
        onError: () => "error",
        endOnDone: false
      })
      yield* Stream.run(Stream.make("a", "b", "c"), sink)
      yield* Effect.sleep(10)
      assert.deepEqual(items, ["a", "b", "c"])
      assert.strictEqual(destroyed, false)
    }))

  it.effect("should handle non-compliant node streams", () =>
    Effect.gen(function*() {
      const stream = NodeStream.fromReadable<Uint8Array, "error">({
        evaluate: () => createReadStream(TEST_TARBALL),
        onError: () => "error"
      })
      const items = yield* entries(stream).pipe(
        Stream.flatMap((entry) =>
          NodeStream.fromReadable({
            evaluate: () => (entry as any),
            onError: (error) => new TarError({ error })
          }).pipe(
            Stream.map((content) => ({
              path: entry.path,
              content: Buffer.from(content).toString("utf-8")
            }))
          )
        ),
        Stream.runCollect
      )
      assert.deepEqual(items, [
        { path: "./tar/world.txt", content: "world\n" },
        { path: "./tar/hello.txt", content: "hello\n" }
      ])
    }))
})

class TarError extends Data.TaggedError("TarError")<{
  readonly error: unknown
}> {}

const entries = <R, E>(
  input: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<Tar.ReadEntry, TarError | E, R> =>
  Effect.gen(function*() {
    const parser = new Tar.Parser()

    yield* input.pipe(
      Stream.run(
        NodeSink.fromWritable({
          evaluate: () => parser,
          onError: (error) => new TarError({ error })
        })
      ),
      Effect.forkScoped
    )

    return Stream.callback<Tar.ReadEntry, TarError>((queue) =>
      Effect.sync(() => {
        parser.on("entry", (entry) => {
          Queue.offerUnsafe(queue, entry)
        })
        parser.on("close", () => {
          Queue.endUnsafe(queue)
        })
      })
    )
  }).pipe(Stream.unwrap)
