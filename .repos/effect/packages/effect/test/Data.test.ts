import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

// Runs a command without blocking the Vitest worker, so concurrent sibling
// tests are not held up (and timed out) while it runs.
const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, { cwd })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (data) => stdout += data)
      child.stderr.setEncoding("utf8").on("data", (data) => stderr += data)
      child.on("error", reject)
      child.on("close", (status) => resolve({ status, stdout, stderr }))
    }
  )

describe("Data", () => {
  describe("Class", () => {
    class Person extends Data.Class<{ readonly name: string; readonly age: number }> {}

    it("compares instances structurally", () => {
      const a = new Person({ name: "Bob", age: 25 })
      assert.strictEqual(Equal.equals(a, new Person({ name: "Bob", age: 25 })), true)
      assert.strictEqual(Equal.equals(a, new Person({ name: "Bob", age: 26 })), false)
    })

    it("supports .pipe()", () => {
      const p = new Person({ name: "C", age: 1 })
      const result = p.pipe((x) => x.name)
      assert.strictEqual(result, "C")
    })

    it("allows classes without fields to be constructed without args", () => {
      class Empty extends Data.Class {}
      const e = new Empty()
      assert.ok(e instanceof Empty)
    })

    it("copies own enumerable string and symbol keys only, as enumerable fields", () => {
      const sym = Symbol("sym")
      const args: any = { name: "E", age: 3, [sym]: "value" }
      Object.defineProperty(args, "hidden", { value: 1, enumerable: false })
      const p: any = new Person(args)
      assert.strictEqual(p.name, "E")
      assert.strictEqual(p.age, 3)
      assert.strictEqual(p[sym], "value")
      assert.deepStrictEqual(Object.keys(p), ["name", "age"])
      assert.deepStrictEqual(Reflect.ownKeys(p), ["name", "age", sym])
    })

    it("keeps the class prototype when args has an own __proto__ key", () => {
      const args = JSON.parse(`{"name":"F","age":4,"__proto__":{"polluted":true}}`)
      const p = new Person(args)
      assert.strictEqual(Object.getPrototypeOf(p), Person.prototype)
      assert.strictEqual(Object.getOwnPropertyDescriptor(p, "__proto__")?.value, args.__proto__)
      assert.strictEqual(p.name, "F")
    })
  })

  describe("TaggedClass", () => {
    class Foo extends Data.TaggedClass("Foo")<{ readonly value: number }> {}

    it("sets _tag to the provided tag and assigns fields", () => {
      const f = new Foo({ value: 42 })
      assert.strictEqual(f._tag, "Foo")
      assert.strictEqual(f.value, 42)
    })

    it("compares instances structurally, including _tag", () => {
      class Bar extends Data.TaggedClass("Bar")<{ readonly value: number }> {}
      const a = new Foo({ value: 1 })
      assert.strictEqual(Equal.equals(a, new Foo({ value: 1 })), true)
      assert.strictEqual(Equal.equals(a, new Bar({ value: 1 })), false)
    })

    it("allows tagged classes without fields to be constructed without args", () => {
      class Empty extends Data.TaggedClass("Empty") {}
      const e = new Empty()
      assert.strictEqual(e._tag, "Empty")
    })

    it("supports .pipe()", () => {
      const f = new Foo({ value: 10 })
      const result = f.pipe((x) => x._tag)
      assert.strictEqual(result, "Foo")
    })
  })

  describe("taggedEnum", () => {
    type Shape = Data.TaggedEnum<{
      Circle: { readonly radius: number }
      Rect: { readonly width: number; readonly height: number }
    }>
    const Shape = Data.taggedEnum<Shape>()

    it("constructors create tagged variants", () => {
      assert.deepStrictEqual(Shape.Circle({ radius: 5 }), { _tag: "Circle", radius: 5 })
      assert.deepStrictEqual(Shape.Rect({ width: 3, height: 4 }), { _tag: "Rect", width: 3, height: 4 })
    })

    it("$is only accepts values with the named tag", () => {
      const isCircle = Shape.$is("Circle")
      assert.strictEqual(isCircle(Shape.Circle({ radius: 1 })), true)
      assert.strictEqual(isCircle(Shape.Rect({ width: 1, height: 1 })), false)
      assert.strictEqual(isCircle(null), false)
      assert.strictEqual(isCircle(undefined), false)
      assert.strictEqual(isCircle("string"), false)
      assert.strictEqual(isCircle({}), false)
    })

    it("$match dispatches on _tag, data-last and data-first", () => {
      const cases = {
        Circle: ({ radius }: { readonly radius: number }) => radius * 2,
        Rect: ({ width, height }: { readonly width: number; readonly height: number }) => width * height
      }
      const measure = Shape.$match(cases)
      assert.strictEqual(measure(Shape.Circle({ radius: 5 })), 10)
      assert.strictEqual(measure(Shape.Rect({ width: 3, height: 4 })), 12)
      assert.strictEqual(Shape.$match(Shape.Circle({ radius: 1 }), cases), 2)
      assert.strictEqual(Shape.$match(Shape.Rect({ width: 2, height: 5 }), cases), 10)
    })

    it("constructs and matches variants without fields", () => {
      type Option = Data.TaggedEnum<{
        None: {}
        Some: { readonly value: number }
      }>
      const Option = Data.taggedEnum<Option>()
      const show = Option.$match({
        None: () => "none",
        Some: ({ value }) => `some(${value})`
      })
      assert.strictEqual(Option.None()._tag, "None")
      assert.strictEqual(show(Option.None()), "none")
      assert.strictEqual(show(Option.Some({ value: 42 })), "some(42)")
    })

    it("declarations reference the named constructor types", async () => {
      const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
      const directory = mkdtempSync(join(packageRoot, "test", ".taggedEnum-declarations-"))
      try {
        writeFileSync(
          join(directory, "fixture.ts"),
          `import * as Data from "effect/Data"

export type Plain = Data.TaggedEnum<{
  CaseA: { readonly name: string; readonly count: number; readonly active: boolean }
  CaseB: { readonly message: string; readonly retry: boolean }
}>
export const Plain = Data.taggedEnum<Plain>()

export type TE<T> = Data.TaggedEnum<{
  A: { a: T }
  B: { b?: T }
}>
export interface TEDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: TE<this["A"]>
}
export const TE = Data.taggedEnum<TEDefinition>()
`
        )
        writeFileSync(
          join(directory, "tsconfig.json"),
          JSON.stringify({
            extends: join(packageRoot, "../../tsconfig.base.json"),
            compilerOptions: {
              composite: false,
              incremental: false,
              declaration: true,
              declarationMap: false,
              emitDeclarationOnly: true,
              sourceMap: false,
              rootDir: packageRoot,
              outDir: join(directory, "out"),
              types: ["node"]
            },
            files: ["fixture.ts"]
          })
        )
        const repositoryRoot = join(packageRoot, "../..")
        const result = await run(
          join(repositoryRoot, "node_modules/.bin/tsc"),
          ["-p", join(directory, "tsconfig.json"), "--pretty", "false"],
          repositoryRoot
        )
        assert.strictEqual(result.status, 0, `${result.stdout}${result.stderr}`)
        const declarations = readFileSync(
          join(directory, "out", relative(packageRoot, directory), "fixture.d.ts"),
          "utf8"
        )
        const [plain = "", ...rest] = declarations.match(/^export declare const .*$/gm) ?? []
        // the plain union alias is not preserved, only the named constructor
        assert.match(plain, /^export declare const Plain: Data\.TaggedEnum\.Constructor</)
        assert.deepStrictEqual(rest, [
          "export declare const TE: Data.TaggedEnum.GenericConstructor<TEDefinition>;"
        ])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }, 60_000)
  })

  describe("Error", () => {
    class MyError extends Data.Error<{ readonly code: number; readonly message: string }> {}

    it("is a globalThis.Error with a stack trace and the provided fields", () => {
      const e = new MyError({ code: 404, message: "not found" })
      assert.ok(e instanceof globalThis.Error)
      assert.ok(typeof e.stack === "string" && e.stack.length > 0)
      assert.strictEqual(e.code, 404)
      assert.strictEqual(e.message, "not found")
    })

    it("allows errors without fields to be constructed without args", () => {
      class Empty extends Data.Error {}
      const e = new Empty()
      assert.ok(e instanceof globalThis.Error)
    })

    it("can be yielded in Effect.gen to fail", () =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Effect.gen(function*() {
            return yield* new MyError({ code: 1, message: "boom" })
          })
        )
        assert.ok(exit._tag === "Failure")
      }).pipe(Effect.runPromise))

    it("toJSON includes fields", () => {
      const e = new MyError({ code: 1, message: "test" })
      const json = (e as any).toJSON()
      assert.strictEqual(json.code, 1)
      assert.strictEqual(json.message, "test")
    })
  })

  describe("TaggedError", () => {
    class NotFound extends Data.TaggedError("NotFound")<{
      readonly resource: string
    }> {}

    it("is a globalThis.Error named after its _tag, with the provided fields", () => {
      const e = new NotFound({ resource: "/users" })
      assert.ok(e instanceof globalThis.Error)
      assert.strictEqual(e._tag, "NotFound")
      assert.strictEqual(e.name, "NotFound")
      assert.strictEqual(e.resource, "/users")
    })

    it("can be caught with Effect.catchTag", () =>
      Effect.gen(function*() {
        const result = yield* Effect.gen(function*() {
          return yield* new NotFound({ resource: "/test" })
        }).pipe(
          Effect.catchTag("NotFound", (e) => Effect.succeed(`caught: ${e.resource}`))
        )
        assert.strictEqual(result, "caught: /test")
      }).pipe(Effect.runPromise))

    it("allows tagged errors without fields to be constructed without args", () => {
      class Boom extends Data.TaggedError("Boom") {}
      const e = new Boom()
      assert.strictEqual(e._tag, "Boom")
      assert.ok(e instanceof globalThis.Error)
    })

    it("different tags produce non-equal errors", () => {
      class Forbidden extends Data.TaggedError("Forbidden")<{ readonly resource: string }> {}
      const a = new NotFound({ resource: "x" })
      const b = new Forbidden({ resource: "x" })
      assert.strictEqual(Equal.equals(a, b), false)
    })
  })
})
