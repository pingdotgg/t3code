import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Schema, SchemaGetter, SchemaParser } from "effect"
import { SchemaJITCompiler } from "effect/schema"

type Step = (index: number) => Effect.Effect<number>

const defaults = (step: Step) =>
  [0, 1, 2].map((index) => Schema.Number.pipe(Schema.withConstructorDefault(step(index))))

const decoded = (step: Step) =>
  Schema.Number.pipe(Schema.decode({
    decode: SchemaGetter.transformEffect(step),
    encode: SchemaGetter.passthrough()
  }))

const boundedCases: ReadonlyArray<{
  readonly name: string
  readonly operation: "make" | "decode"
  readonly schema: (step: Step) => Schema.Codec<unknown>
  readonly input: unknown
  readonly expected: unknown
}> = [
  {
    name: "Struct make",
    operation: "make",
    schema: (step) => {
      const [a, b, c] = defaults(step)
      return Schema.Struct({ a, b, c })
    },
    input: {},
    expected: { a: 0, b: 1, c: 2 }
  },
  {
    name: "Tuple make",
    operation: "make",
    schema: (step) => Schema.Tuple(defaults(step)),
    input: [],
    expected: [0, 1, 2]
  },
  {
    name: "Struct decode",
    operation: "decode",
    schema: (step) => {
      const item = decoded(step)
      return Schema.Struct({ a: item, b: item, c: item })
    },
    input: { a: 0, b: 1, c: 2 },
    expected: { a: 0, b: 1, c: 2 }
  },
  {
    name: "Array decode",
    operation: "decode",
    schema: (step) => Schema.Array(decoded(step)),
    input: [0, 1, 2],
    expected: [0, 1, 2]
  }
]

describe("compiled concurrency", () => {
  it.effect("isolates concurrent executions without replaying the eager prefix", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      let prefixReads = 0
      let ids = 0
      let tails = 0
      const schema = Schema.Struct({
        prefix: Schema.String,
        id: Schema.Number.pipe(Schema.withConstructorDefault(Effect.gen(function*() {
          const id = ++ids
          if (id === 2) yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(started)
          return id
        }))),
        tail: Schema.String.pipe(Schema.withConstructorDefault(Effect.sync(() => {
          tails++
          return "tail"
        })))
      })
      SchemaJITCompiler.enable(schema.ast)
      const program = SchemaParser.makeEffect(schema)({
        get prefix() {
          prefixReads++
          return "prefix"
        }
      })
      assert.strictEqual(prefixReads, 1)
      const results = yield* Effect.all([program, program], { concurrency: "unbounded" })
      assert.deepStrictEqual(results, [
        { prefix: "prefix", id: 1, tail: "tail" },
        { prefix: "prefix", id: 2, tail: "tail" }
      ])
      assert.notStrictEqual(results[0], results[1])
      assert.strictEqual(prefixReads, 1)
      assert.strictEqual(ids, 2)
      assert.strictEqual(tails, 2)
    }))

  for (const { expected, input, name, operation, schema: makeSchema } of boundedCases) {
    it.effect(`${name} preserves bounded concurrency and runs each element once`, () =>
      Effect.gen(function*() {
        const started = yield* Effect.forEach([0, 1, 2], () => Deferred.make<void>())
        const releases = yield* Effect.forEach([0, 1, 2], () => Deferred.make<void>())
        const calls = [0, 0, 0]
        const schema = makeSchema((index) =>
          Effect.gen(function*() {
            calls[index]++
            yield* Deferred.succeed(started[index], undefined)
            yield* Deferred.await(releases[index])
            return index
          })
        )
        SchemaJITCompiler.enable(schema.ast)
        const parse = operation === "make"
          ? SchemaParser.makeEffect(schema)(input, { parseOptions: { concurrency: 2 } })
          : SchemaParser.decodeUnknownEffect(schema)(input, { concurrency: 2 })
        const fiber = yield* Effect.forkChild(parse)
        yield* Deferred.await(started[0])
        yield* Deferred.await(started[1])
        yield* Effect.yieldNow
        assert.strictEqual(yield* Deferred.isDone(started[2]), false)
        yield* Deferred.succeed(releases[0], undefined)
        yield* Deferred.await(started[2])
        yield* Deferred.succeed(releases[1], undefined)
        yield* Deferred.succeed(releases[2], undefined)
        assert.deepStrictEqual(yield* Fiber.join(fiber), expected)
        assert.deepStrictEqual(calls, [1, 1, 1])
      }))
  }
})
