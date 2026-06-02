import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import { assert, describe, expect, it } from "@effect/vitest"
import { Array } from "effect"
import * as Effect from "effect/Effect"
import * as Fs from "effect/FileSystem"
import * as Stream from "effect/Stream"

const runPromise = <E, A>(self: Effect.Effect<A, E, Fs.FileSystem>) =>
  Effect.runPromise(
    Effect.provide(self, NodeFileSystem.layer)
  )

describe("FileSystem", () => {
  it("readFile", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const data = yield* fs.readFile(`${__dirname}/fixtures/text.txt`)
      const text = new TextDecoder().decode(data)
      expect(text.trim()).toEqual("lorem ipsum dolar sit amet")
    })))

  it("makeTempDirectory", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      let dir = ""
      yield* Effect.scoped(Effect.gen(function*() {
        dir = yield* fs.makeTempDirectory()
        const stat = yield* fs.stat(dir)
        expect(stat.type).toEqual("Directory")
      }))
      const stat = yield* fs.stat(dir)
      expect(stat.type).toEqual("Directory")
    })))

  it("makeTempDirectoryScoped", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      let dir = ""
      yield* Effect.scoped(
        Effect.gen(function*() {
          dir = yield* fs.makeTempDirectoryScoped()
          const stat = yield* fs.stat(dir)
          expect(stat.type).toEqual("Directory")
        })
      )
      const error = yield* Effect.flip(fs.stat(dir))
      assert(error.reason._tag === "NotFound")
    })))

  it("truncate", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const file = yield* fs.makeTempFile()

      const text = "hello world"
      yield* fs.writeFile(file, new TextEncoder().encode(text))

      const before = yield* Effect.map(fs.readFile(file), (_) => new TextDecoder().decode(_))
      expect(before).toEqual(text)

      yield* fs.truncate(file)

      const after = yield* Effect.map(fs.readFile(file), (_) => new TextDecoder().decode(_))
      expect(after).toEqual("")
    })))

  it("should track the cursor position when reading", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        let text: string
        const file = yield* fs.open(`${__dirname}/fixtures/text.txt`)

        text = yield* file.readAlloc(Fs.Size(5)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(text).toBe("lorem")

        yield* file.seek(Fs.Size(7), "current")
        text = yield* file.readAlloc(Fs.Size(5)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(text).toBe("dolar")

        yield* file.seek(Fs.Size(1), "current")
        text = yield* file.readAlloc(Fs.Size(8)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(text).toBe("sit amet")

        yield* file.seek(Fs.Size(0), "start")
        text = yield* file.readAlloc(Fs.Size(11)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(text).toBe("lorem ipsum")

        text = yield* fs.stream(`${__dirname}/fixtures/text.txt`, { offset: Fs.Size(6), bytesToRead: Fs.Size(5) }).pipe(
          Stream.map((_) => new TextDecoder().decode(_)),
          Stream.runCollect,
          Effect.map(Array.join(""))
        )
        expect(text).toBe("ipsum")
      }).pipe(
        Effect.scoped
      )
    })))

  it("should track the cursor position when writing", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        let text: string
        const path = yield* fs.makeTempFileScoped()
        const file = yield* fs.open(path, { flag: "w+" })

        yield* file.write(new TextEncoder().encode("lorem ipsum"))
        yield* file.write(new TextEncoder().encode(" "))
        yield* file.write(new TextEncoder().encode("dolor sit amet"))
        text = yield* fs.readFileString(path)
        expect(text).toBe("lorem ipsum dolor sit amet")

        yield* file.seek(Fs.Size(-4), "current")
        yield* file.write(new TextEncoder().encode("hello world"))
        text = yield* fs.readFileString(path)
        expect(text).toBe("lorem ipsum dolor sit hello world")

        yield* file.seek(Fs.Size(6), "start")
        yield* file.write(new TextEncoder().encode("blabl"))
        text = yield* fs.readFileString(path)
        expect(text).toBe("lorem blabl dolor sit hello world")
      }).pipe(
        Effect.scoped
      )
    })))

  it("should maintain a read cursor in append mode", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        let text: string
        const path = yield* fs.makeTempFileScoped()
        const file = yield* fs.open(path, { flag: "a+" })

        yield* file.write(new TextEncoder().encode("foo"))
        yield* file.seek(Fs.Size(0), "start")

        yield* file.write(new TextEncoder().encode("bar"))
        text = yield* fs.readFileString(path)
        expect(text).toBe("foobar")

        text = yield* file.readAlloc(Fs.Size(3)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(text).toBe("foo")

        yield* file.write(new TextEncoder().encode("baz"))
        text = yield* fs.readFileString(path)
        expect(text).toBe("foobarbaz")

        text = yield* file.readAlloc(Fs.Size(6)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(text).toBe("barbaz")
      }).pipe(
        Effect.scoped
      )
    })))

  it("should keep the current cursor if truncating doesn't affect it", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        const path = yield* fs.makeTempFileScoped()
        const file = yield* fs.open(path, { flag: "w+" })

        yield* file.write(new TextEncoder().encode("lorem ipsum dolor sit amet"))
        yield* file.seek(Fs.Size(6), "start")
        yield* file.truncate(Fs.Size(11))

        const cursor = yield* file.seek(Fs.Size(0), "current")
        expect(cursor).toBe(Fs.Size(6))
      }).pipe(
        Effect.scoped
      )
    })))

  it("should update the current cursor if truncating affects it", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        const path = yield* fs.makeTempFileScoped()
        const file = yield* fs.open(path, { flag: "w+" })

        yield* file.write(new TextEncoder().encode("lorem ipsum dolor sit amet"))
        yield* file.truncate(Fs.Size(11))

        const cursor = yield* file.seek(Fs.Size(0), "current")
        expect(cursor).toBe(Fs.Size(11))
      }).pipe(
        Effect.scoped
      )
    })))
})
