import { assert, describe, it } from "@effect/vitest"
import { Arbitrary, Effect, Result, Schema } from "effect"

describe("Arbitrary generation diagnostics", () => {
  const pattern = /^(?!0{32})[0-9a-f]{32}$/
  const traceId = Schema.String.check(Schema.isPattern(pattern))
  const diagnostic: Arbitrary.GenerationDiagnostic = {
    _tag: "UnsupportedPattern",
    path: [],
    source: pattern.source,
    flags: pattern.flags
  }
  const options = { count: 1, runs: 1, maxDiscards: 2, seed: 119120 }

  it.effect("reports the original sampling exhaustion without changing its counts", () =>
    Effect.gen(function*() {
      const result = yield* Effect.result(Arbitrary.sampleEffect(Arbitrary.schema(traceId), {
        count: 200,
        seed: 119120
      }))
      assert.deepStrictEqual(
        result,
        Result.fail({
          _tag: "SampleError",
          generated: 0,
          discards: 2001,
          seed: 119120,
          diagnostics: [diagnostic]
        })
      )
    }))

  it.effect("reports nested paths and formats property exhaustion", () =>
    Effect.gen(function*() {
      const arbitrary = Arbitrary.schema(Schema.Struct({ traceId }))
      const result = yield* Arbitrary.checkEffect(arbitrary, () => true, options)
      assert.deepStrictEqual(result, {
        _tag: "Exhausted",
        runs: 0,
        discards: 3,
        seed: options.seed,
        diagnostics: [{ ...diagnostic, path: ["traceId"] }]
      })
      assert.strictEqual(
        Arbitrary.formatCheckFailure(result),
        "Property exhausted after 0 run(s) and 3 discard(s)\n" +
          "Seed: 119120\n\n" +
          "Pattern unavailable for constructive generation at [\"traceId\"]:\n" +
          `  ${pattern}\n` +
          "The pattern remains a validation filter.\n" +
          "Consider adding a supported pattern to guide generation."
      )
    }))

  it.effect("includes an empty diagnostics array for unrelated exhaustion", () =>
    Effect.gen(function*() {
      const arbitrary = Arbitrary.Constant(0).pipe(Arbitrary.filter(() => false))
      const sampled = yield* Effect.result(Arbitrary.sampleEffect(arbitrary, options))
      assert.deepStrictEqual(
        sampled,
        Result.fail({
          _tag: "SampleError",
          generated: 0,
          discards: 3,
          seed: options.seed,
          diagnostics: []
        })
      )
      assert.deepStrictEqual(yield* Arbitrary.checkEffect(arbitrary, () => true, options), {
        _tag: "Exhausted",
        runs: 0,
        discards: 3,
        seed: options.seed,
        diagnostics: []
      })
    }))

  const compositions: ReadonlyArray<readonly [string, Arbitrary.Arbitrary<unknown>]> = [
    ["map", Arbitrary.schema(traceId).pipe(Arbitrary.map((value) => value))],
    ["filter", Arbitrary.schema(traceId).pipe(Arbitrary.filter(() => true))],
    ["filterMap", Arbitrary.schema(traceId).pipe(Arbitrary.filterMap(Result.succeed))],
    ["array", Arbitrary.array(Arbitrary.schema(traceId), { minLength: 1 })],
    ["all", Arbitrary.all({ id: Arbitrary.schema(traceId) })],
    ["flatMap source", Arbitrary.schema(traceId).pipe(Arbitrary.flatMap(Arbitrary.Constant))],
    ["flatMap target", Arbitrary.Constant(0).pipe(Arbitrary.flatMap(() => Arbitrary.schema(traceId)))]
  ]
  for (const [name, arbitrary] of compositions) {
    it.effect(`preserves diagnostics through ${name}`, () =>
      Effect.gen(function*() {
        const sampled = yield* Effect.result(Arbitrary.sampleEffect(arbitrary, options))
        assert.isTrue(Result.isFailure(sampled))
        if (Result.isFailure(sampled)) assert.deepStrictEqual(sampled.failure.diagnostics, [diagnostic])
        for (const concurrency of [1, 3]) {
          const checked = yield* Arbitrary.checkEffect(arbitrary, () => true, { ...options, concurrency })
          assert.strictEqual(checked._tag, "Exhausted")
          if (checked._tag === "Exhausted") assert.deepStrictEqual(checked.diagnostics, [diagnostic])
        }
      }))
  }

  it.effect("keeps supported companion patterns and permissive fallback working", () =>
    Effect.gen(function*() {
      const companion = traceId.check(Schema.isPattern(/^[0-9a-f]{32}$/))
      const values = yield* Arbitrary.sampleEffect(Arbitrary.schema(companion), {
        ...options,
        count: 500,
        maxDiscards: 0
      })
      assert.lengthOf(values, 500)
      assert.isTrue(values.every(Schema.is(traceId)))
      const permissive = Schema.String.check(Schema.isPattern(/^(?=)[ -~]*$/))
      assert.deepStrictEqual(
        yield* Arbitrary.sampleEffect(Arbitrary.schema(permissive), { ...options, count: 20 }),
        yield* Arbitrary.sampleEffect(
          Arbitrary.schema(Schema.String).pipe(Arbitrary.filter(Schema.is(permissive))),
          { ...options, count: 20 }
        )
      )
    }))

  it.effect("deduplicates patterns while keeping distinct locations of shared schema nodes", () =>
    Effect.gen(function*() {
      const pattern = /^(?=)[ -~]*$/
      const shared = Schema.Struct({ value: Schema.String.check(Schema.isPattern(pattern), Schema.isPattern(pattern)) })
      const arbitrary = Arbitrary.schema(Schema.Struct({ first: shared, second: shared })).pipe(
        Arbitrary.filter(() => false)
      )
      const result = yield* Arbitrary.checkEffect(arbitrary, () => true, options)
      assert.strictEqual(result._tag, "Exhausted")
      if (result._tag !== "Exhausted") return
      assert.deepStrictEqual(result.diagnostics, [
        { _tag: "UnsupportedPattern", path: ["first", "value"], source: pattern.source, flags: "" },
        { _tag: "UnsupportedPattern", path: ["second", "value"], source: pattern.source, flags: "" }
      ])
    }))

  it.effect("keeps schema paths for cached overlapping record specializations across executions", () =>
    Effect.gen(function*() {
      const pattern = /(?=)/
      const schema = Schema.StructWithRest(Schema.Struct({}), [
        Schema.Record(Schema.String, Schema.String),
        Schema.Record(Schema.String, Schema.String.check(Schema.isPattern(pattern)))
      ]).check(Schema.isMinProperties(1))
      const arbitrary = Arbitrary.schema(schema).pipe(Arbitrary.filter(() => false))
      const expected: ReadonlyArray<Arbitrary.GenerationDiagnostic> = [
        { _tag: "UnsupportedPattern", path: ["index-0-value"], source: pattern.source, flags: "" },
        { _tag: "UnsupportedPattern", path: ["index-1-value"], source: pattern.source, flags: "" }
      ]
      const sortDiagnostics = (diagnostics: ReadonlyArray<Arbitrary.GenerationDiagnostic>) =>
        [...diagnostics].sort((a, b) => String(a.path[0]).localeCompare(String(b.path[0])))

      for (const seed of [0, 1]) {
        const settings = { ...options, seed, size: 5, maxDiscards: 10 }
        const sampled = yield* Effect.result(Arbitrary.sampleEffect(arbitrary, settings))
        assert.isTrue(Result.isFailure(sampled))
        if (Result.isFailure(sampled)) {
          assert.deepStrictEqual(sortDiagnostics(sampled.failure.diagnostics), expected)
        }
        const checked = yield* Arbitrary.checkEffect(arbitrary, () => true, settings)
        assert.strictEqual(checked._tag, "Exhausted")
        if (checked._tag === "Exhausted") assert.deepStrictEqual(sortDiagnostics(checked.diagnostics), expected)
      }
    }))

  it.effect("does not collect diagnostics from an unvisited union branch", () =>
    Effect.gen(function*() {
      const expensive = Schema.suspend(() => Schema.suspend(() => traceId))
      // A recursive branch needs budget, so size zero only visits the literal branch.
      interface Node {
        readonly next: Node | string
      }
      const node: Schema.Codec<Node | string> = Schema.Union([
        Schema.Literal("ok"),
        Schema.suspend(() => Schema.Struct({ next: node, value: expensive }))
      ])
      const arbitrary = Arbitrary.schema(node).pipe(Arbitrary.filter(() => false))
      const result = yield* Arbitrary.checkEffect(arbitrary, () => true, { ...options, size: 0 })
      assert.strictEqual(result._tag, "Exhausted")
      if (result._tag === "Exhausted") assert.deepStrictEqual(result.diagnostics, [])
    }))

  it.effect("preserves distinct flags and formats a root location", () =>
    Effect.gen(function*() {
      const arbitrary = Arbitrary.schema(Schema.String.check(
        Schema.isPattern(/^$/i),
        Schema.isPattern(/^$/m)
      )).pipe(Arbitrary.filter(() => false))
      const result = yield* Arbitrary.checkEffect(arbitrary, () => true, options)
      assert.strictEqual(result._tag, "Exhausted")
      if (result._tag !== "Exhausted") return
      assert.deepStrictEqual(result.diagnostics, [
        { _tag: "UnsupportedPattern", path: [], source: "^$", flags: "i" },
        { _tag: "UnsupportedPattern", path: [], source: "^$", flags: "m" }
      ])
      const message = Arbitrary.formatCheckFailure(result)!
      assert.include(message, "at <root>:\n  /^$/i")
      assert.include(message, "at <root>:\n  /^$/m")
    }))

  for (
    const [name, schema, path] of [
      ["array element", Schema.Struct({ items: Schema.Array(traceId).check(Schema.isMinLength(1)) }), ["items", 0]],
      ["tuple element", Schema.Tuple([Schema.Null, traceId]), [1]],
      ["record key", Schema.Record(traceId, Schema.Null).check(Schema.isMinProperties(1)), ["index-0-key"]],
      ["record value", Schema.Record(Schema.String, traceId).check(Schema.isMinProperties(1)), ["index-0-value"]]
    ] as const
  ) {
    it.effect(`reports the schema location of a ${name}`, () =>
      Effect.gen(function*() {
        const result = yield* Arbitrary.checkEffect(Arbitrary.schema(schema), () => true, options)
        assert.strictEqual(result._tag, "Exhausted")
        if (result._tag === "Exhausted") assert.deepStrictEqual(result.diagnostics, [{ ...diagnostic, path }])
      }))
  }

  it.effect("keeps different symbol keys with the same description distinct", () =>
    Effect.gen(function*() {
      const first = Symbol("id")
      const second = Symbol("id")
      const pattern = /(?=)/
      const shared = Schema.String.check(Schema.isPattern(pattern))
      const arbitrary = Arbitrary.schema(Schema.Struct({ [first]: shared, [second]: shared })).pipe(
        Arbitrary.filter(() => false)
      )
      const result = yield* Arbitrary.checkEffect(arbitrary, () => true, options)
      assert.strictEqual(result._tag, "Exhausted")
      if (result._tag === "Exhausted") {
        assert.deepStrictEqual(result.diagnostics, [
          { _tag: "UnsupportedPattern", path: [first], source: pattern.source, flags: "" },
          { _tag: "UnsupportedPattern", path: [second], source: pattern.source, flags: "" }
        ])
      }
    }))

  it.effect("tracks recursive locations without changing generated values", () =>
    Effect.gen(function*() {
      interface Node {
        readonly value: string
        readonly next: Node | null
      }
      const pattern = /(?=)/
      const withPattern: Schema.Codec<Node | null> = Schema.Union([
        Schema.Null,
        Schema.Struct({
          value: Schema.String.check(Schema.isPattern(pattern)),
          next: Schema.suspend(() => withPattern)
        })
      ])
      const withoutPattern: Schema.Codec<Node | null> = Schema.Union([
        Schema.Null,
        Schema.Struct({ value: Schema.String, next: Schema.suspend(() => withoutPattern) })
      ])
      const arbitrary = Arbitrary.schema(withPattern)
      const settings = { ...options, count: 100, size: 3, maxDiscards: 100 }
      assert.deepStrictEqual(
        yield* Arbitrary.sampleEffect(arbitrary, settings),
        yield* Arbitrary.sampleEffect(Arbitrary.schema(withoutPattern), settings)
      )
      const result = yield* Arbitrary.checkEffect(arbitrary.pipe(Arbitrary.filter(() => false)), () => true, settings)
      assert.strictEqual(result._tag, "Exhausted")
      if (result._tag !== "Exhausted") return
      assert.isTrue(result.diagnostics.some(({ path }) => path.length > 1))
      for (const diagnostic of result.diagnostics) {
        assert.strictEqual(diagnostic.path[diagnostic.path.length - 1], "value")
        assert.isTrue(diagnostic.path.slice(0, -1).every((key) => key === "next"))
      }
      assert.strictEqual(new Set(result.diagnostics.map(({ path }) => path.length)).size, result.diagnostics.length)
    }))

  it.effect("isolates diagnostics when the same effect is executed again", () =>
    Effect.gen(function*() {
      let includePattern = true
      const arbitrary = Arbitrary.Constant(0).pipe(
        Arbitrary.flatMap(() =>
          includePattern
            ? Arbitrary.schema(traceId)
            : Arbitrary.Constant("ok").pipe(Arbitrary.filter(() => false))
        )
      )
      const sample = Effect.result(Arbitrary.sampleEffect(arbitrary, options))
      const check = Arbitrary.checkEffect(arbitrary, () => true, options)
      const sampled = yield* sample
      const checked = yield* check
      includePattern = false
      const sampledAgain = yield* sample
      const checkedAgain = yield* check
      if (Result.isFailure(sampled) && Result.isFailure(sampledAgain)) {
        assert.deepStrictEqual(sampled.failure.diagnostics, [diagnostic])
        assert.deepStrictEqual(sampledAgain.failure.diagnostics, [])
      } else {
        assert.fail("Expected sampling exhaustion")
      }
      if (checked._tag === "Exhausted" && checkedAgain._tag === "Exhausted") {
        assert.deepStrictEqual(checked.diagnostics, [diagnostic])
        assert.deepStrictEqual(checkedAgain.diagnostics, [])
      } else {
        assert.fail("Expected property exhaustion")
      }
    }))
})
