import { assert, expect, it } from "@effect/vitest"
import { Array, Result } from "effect"
import * as Effect from "effect/Effect"
import * as Fs from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

export interface TestLayerOptions {
  /** Whether writable access to a directory is supported. Deno's open-based access check rejects directories. Defaults to `true`. */
  readonly accessOnDirectory?: boolean
  /** Whether a scoped temporary file removes its containing directory. Deno removes only the file. Defaults to `true`. */
  readonly tempFileScopedRemovesDirectory?: boolean
}

export const testLayer = <E>(layer: Layer.Layer<Fs.FileSystem, E>, options: TestLayerOptions = {}) => {
  const runPromise = <E2, A>(self: Effect.Effect<A, E2, Fs.FileSystem>) =>
    Effect.runPromise(
      Effect.provide(self, layer)
    )

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

  it.skipIf(options.accessOnDirectory === false)(
    "access on a writable directory",
    () =>
      runPromise(Effect.gen(function*() {
        const fs = yield* Fs.FileSystem
        yield* Effect.scoped(Effect.gen(function*() {
          const dir = yield* fs.makeTempDirectoryScoped()
          yield* fs.access(dir, { writable: true })
        }))
      }))
  )

  it("makeTempFileScoped cleans up", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      yield* Effect.scoped(Effect.gen(function*() {
        const root = yield* fs.makeTempDirectoryScoped()
        let file = ""
        let dir = ""
        yield* Effect.scoped(Effect.gen(function*() {
          file = yield* fs.makeTempFileScoped({ directory: root })
          const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"))
          assert(separator > 0, "Expected temp file path to contain a directory separator")
          dir = file.slice(0, separator)
          const stat = yield* fs.stat(dir)
          expect(stat.type).toEqual("Directory")
        }))
        const fileError = yield* Effect.flip(fs.stat(file))
        assert(fileError.reason._tag === "NotFound")
        if (options.tempFileScopedRemovesDirectory !== false) {
          const directoryError = yield* Effect.flip(fs.stat(dir))
          assert(directoryError.reason._tag === "NotFound")
        }
      }))
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

  it("writeFile with r+ overwrites without truncating", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const path = yield* fs.makeTempFile()

      yield* fs.writeFileString(path, "abcdef")
      yield* fs.writeFileString(path, "xy", { flag: "r+" })

      assert.strictEqual(yield* fs.readFileString(path), "xycdef")
    })))

  it("writeFile with empty data honors the flag", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const path = yield* fs.makeTempFile()

      yield* fs.writeFileString(path, "abc")
      yield* fs.writeFileString(path, "")
      assert.strictEqual(yield* fs.readFileString(path), "")

      yield* fs.writeFileString(path, "abc")
      yield* fs.writeFileString(path, "", { flag: "r+" })
      assert.strictEqual(yield* fs.readFileString(path), "abc")
    })))

  it("writeFile with r rejects writes", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const path = yield* fs.makeTempFile()

      const error = yield* fs.writeFileString(path, "data", { flag: "r" }).pipe(Effect.flip)

      assert(error.reason._tag !== "BadArgument")
      assert.strictEqual(error.reason.method, "writeFile")
      assert.strictEqual(error.reason.pathOrDescriptor, path)
      assert.strictEqual(yield* fs.readFileString(path), "")
    })))

  it("writeFile with a appends", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const path = yield* fs.makeTempFile()

      yield* fs.writeFileString(path, "abc")
      yield* fs.writeFileString(path, "def", { flag: "a" })

      assert.strictEqual(yield* fs.readFileString(path), "abcdef")
    })))

  it("writeFile with wx exclusively creates", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const root = yield* fs.makeTempDirectory()
      const path = `${root}/file.txt`

      yield* fs.writeFileString(path, "first", { flag: "wx" })
      yield* fs.writeFileString(path, "second", { flag: "wx" }).pipe(Effect.flip)

      assert.strictEqual(yield* fs.readFileString(path), "first")
    })))

  it("copy with overwrite false preserves an existing destination", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem
      const root = yield* fs.makeTempDirectory()
      const source = `${root}/source.txt`
      const destination = `${root}/destination.txt`
      yield* fs.writeFileString(source, "source")
      yield* fs.writeFileString(destination, "destination")

      const result = yield* Effect.result(fs.copy(source, destination, { overwrite: false }))

      if (Result.isFailure(result)) {
        assert(result.failure.reason._tag === "AlreadyExists")
        assert.strictEqual(result.failure.reason.method, "copy")
        assert.strictEqual(result.failure.reason.pathOrDescriptor, source)
      }
      assert.strictEqual(yield* fs.readFileString(source), "source")
      assert.strictEqual(yield* fs.readFileString(destination), "destination")
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

  it("should read from a backwards seek", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        const file = yield* fs.open(`${__dirname}/fixtures/text.txt`)

        const first = yield* file.readAlloc(Fs.Size(5)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(first).toBe("lorem")

        yield* file.seek(Fs.Size(-3), "current")
        const second = yield* file.readAlloc(Fs.Size(3)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(second).toBe("rem")
      }).pipe(
        Effect.scoped
      )
    })))

  it("should read sequentially without an intervening seek", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        const file = yield* fs.open(`${__dirname}/fixtures/text.txt`)

        const first = yield* file.readAlloc(Fs.Size(5)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(first).toBe("lorem")

        const second = yield* file.readAlloc(Fs.Size(6)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(second).toBe(" ipsum")
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

  it("should restore the read cursor after an append write", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        const path = yield* fs.makeTempFileScoped()
        const file = yield* fs.open(path, { flag: "a+" })

        yield* file.write(new TextEncoder().encode("foo"))
        yield* file.seek(Fs.Size(0), "start")

        const first = yield* file.readAlloc(Fs.Size(1)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(first).toBe("f")

        yield* file.write(new TextEncoder().encode("bar"))
        const second = yield* file.readAlloc(Fs.Size(2)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(second).toBe("oo")
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

  it("should read from the clamped cursor after truncating", () =>
    runPromise(Effect.gen(function*() {
      const fs = yield* Fs.FileSystem

      yield* Effect.gen(function*() {
        const path = yield* fs.makeTempFileScoped()
        const file = yield* fs.open(path, { flag: "w+" })

        yield* file.write(new TextEncoder().encode("abcdefghij"))
        yield* file.truncate(Fs.Size(5))
        yield* fs.writeFile(path, new TextEncoder().encode("xyz"), { flag: "a" })

        const text = yield* file.readAlloc(Fs.Size(3)).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.map((_) => new TextDecoder().decode(_))
        )
        expect(text).toBe("xyz")
      }).pipe(
        Effect.scoped
      )
    })))
}
