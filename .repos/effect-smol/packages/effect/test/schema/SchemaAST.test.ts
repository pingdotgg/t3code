import { Schema, SchemaAST, SchemaGetter, SchemaTransformation } from "effect"
import { runInNewContext } from "node:vm"
import { describe, it } from "vitest"
import { deepStrictEqual, doesNotThrow, strictEqual, throws } from "../utils/assert.ts"

describe("SchemaAST", () => {
  it("isJson", () => {
    strictEqual(SchemaAST.isJson(null), true)
    strictEqual(SchemaAST.isJson(undefined), false)
    strictEqual(SchemaAST.isJson(true), true)
    strictEqual(SchemaAST.isJson(false), true)
    strictEqual(SchemaAST.isJson("string"), true)
    strictEqual(SchemaAST.isJson(1), true)
    strictEqual(SchemaAST.isJson(1.5), true)
    strictEqual(SchemaAST.isJson(1n), false)
    strictEqual(SchemaAST.isJson(NaN), false)
    strictEqual(SchemaAST.isJson(Infinity), false)
    strictEqual(SchemaAST.isJson(-Infinity), false)
    strictEqual(SchemaAST.isJson(Symbol.for("symbol")), false)
    strictEqual(SchemaAST.isJson([]), true)
    strictEqual(SchemaAST.isJson([1]), true)
    strictEqual(SchemaAST.isJson(new Array(1)), false)
    strictEqual(SchemaAST.isJson([1, undefined]), false)
    strictEqual(SchemaAST.isJson([1, 1n]), false)
    let getterCalls = 0
    const arrayWithGetter = [0]
    Object.defineProperty(arrayWithGetter, "0", {
      enumerable: true,
      get() {
        getterCalls++
        return 1
      }
    })
    strictEqual(SchemaAST.isJson(arrayWithGetter), true)
    strictEqual(getterCalls, 1)
    strictEqual(SchemaAST.isJson({}), true)
    strictEqual(SchemaAST.isJson({ a: 1 }), true)
    strictEqual(SchemaAST.isJson({ a: undefined }), false)
    strictEqual(SchemaAST.isJson({ a: 1, b: 1n }), false)
    strictEqual(SchemaAST.isJson(new Map([["a", 1]])), false)
    strictEqual(SchemaAST.isJson(new Set([1])), false)
    strictEqual(SchemaAST.isJson(new Date(0)), false)
    strictEqual(SchemaAST.isJson(/a/), false)
    strictEqual(SchemaAST.isJson(new Uint8Array([1])), false)
    class A {
      readonly a = 1
    }
    strictEqual(SchemaAST.isJson(new A()), false)
    const nullPrototype: Record<string, unknown> = Object.create(null)
    nullPrototype.a = { b: [1, true, null] }
    strictEqual(SchemaAST.isJson(nullPrototype), true)
    const crossRealmRecord: unknown = runInNewContext("({ a: [1, true, null] })")
    strictEqual(SchemaAST.isJson(crossRealmRecord), true)
    const crossRealmClass: unknown = runInNewContext("new (class A { a = 1 })()")
    strictEqual(SchemaAST.isJson(crossRealmClass), false)
    // nested
    strictEqual(SchemaAST.isJson({ a: { b: 1 } }), true)
    strictEqual(SchemaAST.isJson({ a: [1, { b: "c" }] }), true)
    strictEqual(SchemaAST.isJson({ a: { b: 1n } }), false)
    // circular reference
    const circular: Record<string, unknown> = {}
    circular.self = circular
    strictEqual(SchemaAST.isJson(circular), false)
    // accepts DAGs
    const shared = { a: 1 }
    strictEqual(SchemaAST.isJson({ x: shared, y: shared }), true)
    strictEqual(SchemaAST.isJson([shared, { nested: shared }]), true)
    // Nested DAG
    const deeper = { parent: { left: shared, right: shared } }
    strictEqual(SchemaAST.isJson(deeper), true)
  })

  it("isJson is stack safe", () => {
    let valid: unknown = null
    let invalid: unknown = undefined
    for (let i = 0; i < 25_000; i++) {
      valid = [valid]
      invalid = [invalid]
    }
    strictEqual(SchemaAST.isJson(valid), true)
    strictEqual(SchemaAST.isJson(invalid), false)
  })

  it("Schema.toCodecJson rejects non-JSON objects", () => {
    const encode = Schema.encodeUnknownExit(Schema.toCodecJson(Schema.Unknown))
    strictEqual(encode(new Map([["a", 1]]))._tag, "Failure")
  })

  it("isStringTree", () => {
    strictEqual(SchemaAST.isStringTree(undefined), true)
    strictEqual(SchemaAST.isStringTree("string"), true)
    strictEqual(SchemaAST.isStringTree(null), false)
    strictEqual(SchemaAST.isStringTree(true), false)
    strictEqual(SchemaAST.isStringTree(false), false)
    strictEqual(SchemaAST.isStringTree(1), false)
    strictEqual(SchemaAST.isStringTree(1n), false)
    strictEqual(SchemaAST.isStringTree(Symbol.for("symbol")), false)
    strictEqual(SchemaAST.isStringTree([]), true)
    strictEqual(SchemaAST.isStringTree(["a"]), true)
    strictEqual(SchemaAST.isStringTree(["a", undefined]), true)
    strictEqual(SchemaAST.isStringTree(["a", 1]), false)
    strictEqual(SchemaAST.isStringTree(new Array(1)), true)
    const sparseWithInheritedValue = new Array(1)
    const arrayPrototype = Object.create(Array.prototype)
    arrayPrototype[0] = 1
    Object.setPrototypeOf(sparseWithInheritedValue, arrayPrototype)
    strictEqual(SchemaAST.isStringTree(sparseWithInheritedValue), false)
    strictEqual(SchemaAST.isStringTree({}), true)
    strictEqual(SchemaAST.isStringTree({ a: "b" }), true)
    strictEqual(SchemaAST.isStringTree({ a: undefined }), true)
    strictEqual(SchemaAST.isStringTree({ a: "b", c: 1 }), false)
    strictEqual(SchemaAST.isStringTree(new Map([["a", "b"]])), false)
    strictEqual(SchemaAST.isStringTree(new Date(0)), false)
    class A {
      readonly a = "a"
    }
    strictEqual(SchemaAST.isStringTree(new A()), false)
    // nested
    strictEqual(SchemaAST.isStringTree({ a: { b: "c" } }), true)
    strictEqual(SchemaAST.isStringTree({ a: ["b", { c: "d" }] }), true)
    strictEqual(SchemaAST.isStringTree({ a: { b: 1 } }), false)
    // DAG
    const shared = { value: "a" }
    strictEqual(SchemaAST.isStringTree({ left: shared, right: shared }), true)
    // circular reference
    const circular: Record<string, unknown> = {}
    circular.self = circular
    strictEqual(SchemaAST.isStringTree(circular), false)
  })

  it("isStringTree is stack safe", () => {
    let valid: unknown = "value"
    let invalid: unknown = 1
    for (let i = 0; i < 25_000; i++) {
      valid = { value: valid }
      invalid = { value: invalid }
    }
    strictEqual(SchemaAST.isStringTree(valid), true)
    strictEqual(SchemaAST.isStringTree(invalid), false)
  })

  describe("toType", () => {
    it("is idempotent for suspended schemas", () => {
      const schema = Schema.suspend(() => Schema.Struct({ a: Schema.NumberFromString }))
      const ast = SchemaAST.toType(schema.ast)

      strictEqual(SchemaAST.toType(ast), ast)
    })

    it("toEncoded is idempotent for suspended schemas", () => {
      const schema = Schema.suspend(() => Schema.Struct({ a: Schema.NumberFromString }))
      const ast = SchemaAST.toEncoded(schema.ast)

      strictEqual(SchemaAST.toEncoded(ast), ast)
    })

    it("promotes encodingChecks when contained type shape is preserved", () => {
      const schema = Schema.Struct({ a: Schema.String }).pipe(
        Schema.flip,
        Schema.check(Schema.makeFilter((o) => o.a.length > 1)),
        Schema.flip
      )

      const ast = SchemaAST.toType(schema.ast)

      strictEqual(SchemaAST.isObjects(ast), true)
      strictEqual(ast.checks?.length, 1)
      strictEqual(ast.encodingChecks, undefined)
    })

    it("drops encodingChecks when contained type shape changes", () => {
      const schema = Schema.Struct({ a: Schema.FiniteFromString }).pipe(
        Schema.flip,
        Schema.check(Schema.makeFilter((o) => o.a.length > 1)),
        Schema.flip
      )

      const ast = SchemaAST.toType(schema.ast)

      strictEqual(SchemaAST.isObjects(ast), true)
      strictEqual(ast.checks, undefined)
      strictEqual(ast.encodingChecks, undefined)
    })

    it("preserves structural checks when contained type shape changes", () => {
      const check = Schema.isMinProperties(1)
      const schema = Schema.Struct({ a: Schema.NumberFromString }).check(check)

      const ast = SchemaAST.toEncoded(schema.ast)

      strictEqual(SchemaAST.isObjects(ast), true)
      strictEqual(ast.checks?.[0], check)
    })

    it("preserves structural checks when contained element shape changes", () => {
      const check = Schema.isMinLength(1)
      const schema = Schema.Array(Schema.NumberFromString).check(check)

      const ast = SchemaAST.toEncoded(schema.ast)

      strictEqual(SchemaAST.isArrays(ast), true)
      strictEqual(ast.checks?.[0], check)
    })

    it("preserves structural checks when a declaration type parameter shape changes", () => {
      const check = Schema.isMinSize(1)
      const schema = Schema.ReadonlySet(Schema.NumberFromString).check(check)

      const ast = SchemaAST.toEncoded(schema.ast)

      strictEqual(SchemaAST.isDeclaration(ast), true)
      strictEqual(ast.checks?.[0], check)
    })

    it("preserves only the structural members of a mixed filter group", () => {
      const structural = Schema.isMinProperties(1)
      const group = structural.and(Schema.makeFilter<object>(() => true))
      const schema = Schema.Struct({ a: Schema.NumberFromString }).check(group)

      const ast = SchemaAST.toEncoded(schema.ast)

      strictEqual(SchemaAST.isObjects(ast), true)
      strictEqual(ast.checks?.length, 1)
      strictEqual(ast.checks?.[0], structural)
    })
  })

  describe("collectSentinels", () => {
    describe("Declaration", () => {
      it("~sentinels", () => {
        class A {
          readonly _tag = "A"
        }
        const schema = Schema.instanceOf(A, { "~sentinels": [{ key: "_tag", literal: "A" }] })
        const ast = schema.ast
        deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "_tag", literal: "A" }])
      })
    })

    describe("Struct", () => {
      it("required tag", () => {
        const schema = Schema.Struct({
          _tag: Schema.Literal("a"),
          a: Schema.String
        })
        const ast = schema.ast
        deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "_tag", literal: "a" }])
      })

      it("optional tag", () => {
        const schema = Schema.Struct({
          _tag: Schema.optionalKey(Schema.Literal("a")),
          a: Schema.String
        })
        const ast = schema.ast
        deepStrictEqual(SchemaAST.collectSentinels(ast), [])
      })
    })

    describe("Tuple", () => {
      it("required element", () => {
        const schema = Schema.Tuple([Schema.Literal("a"), Schema.Number])
        const ast = schema.ast
        deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: 0, literal: "a" }])
      })

      it("optional element", () => {
        const schema = Schema.Tuple([Schema.Number, Schema.optionalKey(Schema.Literal("a"))])
        const ast = schema.ast
        deepStrictEqual(SchemaAST.collectSentinels(ast), [])
      })
    })

    it("Declaration", () => {
      class A {
        readonly _tag = "A"
      }
      const schema = Schema.instanceOf(
        A,
        { "~sentinels": [{ key: "_tag", literal: "A" }] }
      )
      const ast = schema.ast
      deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "_tag", literal: "A" }])
    })

    it("Class", () => {
      class A extends Schema.Class<A>("A")({
        type: Schema.Literal("A"),
        a: Schema.String
      }) {}
      const ast = A.ast
      deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "type", literal: "A" }])
    })

    it("TaggedClass", () => {
      class A extends Schema.TaggedClass<A>()("A", {
        a: Schema.String
      }) {}
      const ast = A.ast
      deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "_tag", literal: "A" }])
    })

    it("Error", () => {
      class E extends Schema.Error<E>("E")({
        type: Schema.Literal("E"),
        e: Schema.String
      }) {}
      const ast = E.ast
      deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "type", literal: "E" }])
    })

    it("TaggedError", () => {
      class E extends Schema.TaggedError<E>()("E", {
        e: Schema.String
      }) {}
      const ast = E.ast
      deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "_tag", literal: "E" }])
    })

    it("Union: the sentinels common to every member", () => {
      const shared = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), variant: Schema.Literal("x") }),
        Schema.Struct({ kind: Schema.Literal("a"), variant: Schema.Literal("y") })
      ])
      deepStrictEqual(SchemaAST.collectSentinels(shared.ast), [{ key: "kind", literal: "a" }])

      const disjoint = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a") }),
        Schema.Struct({ kind: Schema.Literal("b") })
      ])
      deepStrictEqual(SchemaAST.collectSentinels(disjoint.ast), [])

      // A suspended member stays opaque, so the intersection is conservative.
      const withSuspend = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a") }),
        Schema.suspend(() => Schema.Struct({ kind: Schema.Literal("a") }))
      ])
      deepStrictEqual(SchemaAST.collectSentinels(withSuspend.ast), [])
    })
  })

  describe("getCandidates", () => {
    it("should exclude never", () => {
      const schema = Schema.Union([Schema.String, Schema.Never])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates("a", ast.types), [ast.types[0]])
    })

    it("should exclude by type", () => {
      const schema = Schema.NullishOr(Schema.String)
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates("a", ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates(null, ast.types), [ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates(undefined, ast.types), [ast.types[2]])
      deepStrictEqual(SchemaAST.getCandidates(1, ast.types), [])
    })

    it("should exclude by literals", () => {
      const schema = Schema.Union([
        Schema.UniqueSymbol(Symbol.for("a")),
        Schema.Literal("b"),
        Schema.String
      ])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates(Symbol.for("a"), ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates("b", ast.types), [ast.types[1], ast.types[2]])
      deepStrictEqual(SchemaAST.getCandidates("c", ast.types), [ast.types[2]])
      deepStrictEqual(SchemaAST.getCandidates(1, ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates(undefined, ast.types), [])
    })

    it("Literals", () => {
      const schema = Schema.Literals(["a", "b", "c"])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates("a", ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates("b", ast.types), [ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates("c", ast.types), [ast.types[2]])
      deepStrictEqual(SchemaAST.getCandidates("d", ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates(null, ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates(undefined, ast.types), [])
    })

    it("literal-only union with a unique symbol", () => {
      const symbol = Symbol.for("a")
      const schema = Schema.Union([Schema.UniqueSymbol(symbol), Schema.Literal("b")])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates(symbol, ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates(Symbol("a"), ast.types), [])
    })

    it("should preserve duplicate literal candidates in member order", () => {
      const schema = Schema.Union([
        Schema.Literal("a").transform("first"),
        Schema.Literal("a").transform("second"),
        Schema.Never
      ])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates("a", ast.types), [ast.types[0], ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates("b", ast.types), [])
    })

    it("String | Literals", () => {
      const schema = Schema.Union([Schema.String, Schema.Literals(["a", "b", "c"])])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates(undefined, ast.types), [])
    })

    it("should handle tagged structs", () => {
      const schema = Schema.Union([
        Schema.Struct({ _tag: Schema.tag("a"), a: Schema.String }),
        Schema.Struct({ _tag: Schema.tag("b"), b: Schema.Number }),
        Schema.String
      ])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates({}, ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates({ _tag: "a" }, ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates({ _tag: "b" }, ast.types), [ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates({ _tag: "c" }, ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates("", ast.types), [ast.types[2]])
      deepStrictEqual(SchemaAST.getCandidates(1, ast.types), [])
    })

    it("constructor mode should keep tagged candidates only when an object discriminator is missing", () => {
      const schema = Schema.Union([
        Schema.Struct({ _tag: Schema.tag("a"), a: Schema.String }),
        Schema.Struct({ _tag: Schema.tag("b"), b: Schema.Number })
      ])
      const ast = schema.ast

      deepStrictEqual(SchemaAST.getCandidates({}, ast.types, true), ast.types)
      deepStrictEqual(SchemaAST.getCandidates({ _tag: undefined }, ast.types, true), ast.types)
      deepStrictEqual(SchemaAST.getCandidates({ _tag: "a" }, ast.types, true), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates("a", ast.types, true), [])
    })

    it("should handle function-valued declarations with sentinels", () => {
      const a = Schema.declare(
        (input): input is () => void => typeof input === "function",
        { "~sentinels": [{ key: "kind", literal: "a" }] }
      )
      const b = Schema.declare(
        (input): input is () => void => typeof input === "function",
        { "~sentinels": [{ key: "kind", literal: "b" }] }
      )
      const schema = Schema.Union([a, b])
      const ast = schema.ast
      const input = Object.assign(() => {}, { kind: "a" })
      deepStrictEqual(SchemaAST.getCandidates(input, ast.types), [ast.types[0]])
    })

    it("should preserve duplicate candidates with a common discriminator", () => {
      const member = Schema.Struct({ kind: Schema.Literal("a"), value: Schema.String })
      const schema = Schema.Union([
        member,
        Schema.Struct({ kind: Schema.Literal("b"), value: Schema.Number }),
        member,
        Schema.Never
      ])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates({ kind: "a" }, ast.types), [ast.types[0], ast.types[2]])
      deepStrictEqual(SchemaAST.getCandidates({ kind: "b" }, ast.types), [ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates({ kind: "c" }, ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates({}, ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates("a", ast.types), [])
    })

    it("should protect cached common sentinel candidates from external mutation", () => {
      const schema = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a") }),
        Schema.Struct({ kind: Schema.Literal("b") })
      ])
      const ast = schema.ast
      const input = { kind: "a" }
      const candidates = SchemaAST.getCandidates(input, ast.types)
      Reflect.set(candidates, candidates.length, ast.types[1])
      deepStrictEqual(SchemaAST.getCandidates(input, ast.types), [ast.types[0]])
    })

    it("should handle candidates with different sentinel keys", () => {
      const schema = Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("a"),
          status: Schema.Literal("ready"),
          value: Schema.String
        }),
        Schema.Struct({ status: Schema.Literal("ready"), value: Schema.String })
      ])
      const ast = schema.ast
      deepStrictEqual(
        SchemaAST.getCandidates({ kind: "a", status: "ready", value: "value" }, ast.types),
        [ast.types[0], ast.types[1]]
      )
      deepStrictEqual(
        SchemaAST.getCandidates({ kind: "b", status: "ready", value: "value" }, ast.types),
        [ast.types[1]]
      )
      deepStrictEqual(
        SchemaAST.getCandidates({ kind: undefined, status: "ready", value: "value" }, ast.types),
        [ast.types[1]]
      )
    })

    it("should handle tagged tuples", () => {
      const schema = Schema.Union([
        Schema.Tuple([Schema.Literal("a"), Schema.String]),
        Schema.Tuple([Schema.Literal("b"), Schema.Number]),
        Schema.String
      ])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates([], ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates(["a"], ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates(["b"], ast.types), [ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates(["c"], ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates("", ast.types), [ast.types[2]])
      deepStrictEqual(SchemaAST.getCandidates(1, ast.types), [])
    })

    it("should handle tagged tuples with unique symbol sentinels", () => {
      const a = Symbol.for("a")
      const b = Symbol.for("b")
      const schema = Schema.Union([
        Schema.Tuple([Schema.UniqueSymbol(a), Schema.String]),
        Schema.Tuple([Schema.UniqueSymbol(b), Schema.Number])
      ])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates([a, "value"], ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates([b, 1], ast.types), [ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates([Symbol("a"), "value"], ast.types), [])
    })

    it(`should deduplicate repeated declaration sentinels in "oneOf" mode`, () => {
      const member = Schema.declare(
        (input): input is object => typeof input === "object" && input !== null,
        {
          "~sentinels": [
            { key: "kind", literal: "a" },
            { key: "kind", literal: "a" }
          ]
        }
      )
      const schema = Schema.Union([member], { mode: "oneOf" })
      const input = { kind: "a" }
      strictEqual(Schema.decodeUnknownSync(schema)(input), input)
    })

    it("should dispatch a nested union member by its common sentinel", () => {
      const hosted = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), variant: Schema.Literal("x") }),
        Schema.Struct({ kind: Schema.Literal("a"), variant: Schema.Literal("y") })
      ])
      const flat = Schema.Struct({ kind: Schema.Literal("b") })
      const ast = Schema.Union([hosted, flat]).ast
      deepStrictEqual(SchemaAST.getCandidates({ kind: "a" }, ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates({ kind: "b" }, ast.types), [ast.types[1]])
    })

    it("should exclude members whose sentinel the input contradicts", () => {
      const schema = Schema.Union([
        Schema.Struct({ kind: Schema.Literal("a"), variant: Schema.Literal("x"), value: Schema.String }),
        Schema.Struct({ kind: Schema.Literal("a"), variant: Schema.Literal("y"), value: Schema.Number })
      ])
      const ast = schema.ast
      deepStrictEqual(SchemaAST.getCandidates({ kind: "a", variant: "x" }, ast.types), [ast.types[0]])
      deepStrictEqual(SchemaAST.getCandidates({ kind: "a", variant: "z" }, ast.types), [])
      deepStrictEqual(SchemaAST.getCandidates({ kind: "a", variant: undefined }, ast.types), [])
      // A missing sentinel key does not exclude: the member still owes the error.
      deepStrictEqual(SchemaAST.getCandidates({ kind: "a" }, ast.types), [ast.types[0], ast.types[1]])
      deepStrictEqual(SchemaAST.getCandidates({ kind: "a", variant: undefined }, ast.types, true), ast.types)
    })
  })

  describe("getIndexSignatureKeys", () => {
    it("String", () => {
      const sym = Symbol.for("sym")
      const input: { readonly [x: PropertyKey]: number } = { a: 1, b: 2, [sym]: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.String.ast, SchemaAST.defaultParseOptions), [
        "a",
        "b"
      ])
    })

    it("String with checks", () => {
      const input = { a: 1, ab: 2, b: 3 }
      deepStrictEqual(
        SchemaAST.getIndexSignatureKeys(
          input,
          Schema.String.check(Schema.isPattern(/^a/)).ast,
          SchemaAST.defaultParseOptions
        ),
        ["a", "ab"]
      )
    })

    it("transformed String with decoded checks", () => {
      const schema = Schema.String.pipe(Schema.decode(SchemaTransformation.snakeToCamel())).check(
        Schema.isPattern(/^aB$/)
      )
      const input = { a_b: 1, x_y: 2 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, schema.ast, SchemaAST.defaultParseOptions), [
        "a_b",
        "x_y"
      ])
    })

    it("TemplateLiteral", () => {
      const schema = Schema.TemplateLiteral(["a"])
      const input = { a: 1, ab: 2, b: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, schema.ast, SchemaAST.defaultParseOptions), ["a"])
    })

    it("TemplateLiteral with checked parts", () => {
      const schema = Schema.TemplateLiteral(["a", Schema.NonEmptyString])
      const input = { a: 1, ab: 2, b: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, schema.ast, SchemaAST.defaultParseOptions), ["ab"])
    })

    it("Symbol", () => {
      const a = Symbol.for("a")
      const b = Symbol.for("b")
      const input: { readonly [x: PropertyKey]: number } = { c: 1, [a]: 2, [b]: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.Symbol.ast, SchemaAST.defaultParseOptions), [a, b])
    })

    it("Number", () => {
      const input = { "1": 1, "1.5": 2, "-2": 3, a: 4, NaN: 5, x1: 6, "1x": 7 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.Number.ast, SchemaAST.defaultParseOptions), [
        "1",
        "1.5",
        "-2",
        "NaN"
      ])
    })

    it("Number with checks", () => {
      const input = { "1": 1, "1.5": 2, "-2": 3, a: 4, NaN: 5 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.Int.ast, SchemaAST.defaultParseOptions), [
        "1",
        "-2"
      ])
    })

    it("Union", () => {
      const schema = Schema.Union([Schema.Symbol, Schema.Number])
      const sym = Symbol.for("sym")
      const input: { readonly [x: PropertyKey]: number } = { "1": 1, b: 2, [sym]: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, schema.ast, SchemaAST.defaultParseOptions), [sym, "1"])
    })
  })

  describe("record", () => {
    it("treats Never parameters as no keys", () => {
      const ast = SchemaAST.record(Schema.Never.ast, Schema.Number.ast)
      deepStrictEqual(ast.propertySignatures, [])
      deepStrictEqual(ast.indexSignatures, [])
    })

    it("ignores Never arms in union parameters", () => {
      const ast = SchemaAST.record(Schema.Union([Schema.String, Schema.Never]).ast, Schema.Number.ast)
      const indexSignature = ast.indexSignatures[0]!

      deepStrictEqual(ast.propertySignatures, [])
      strictEqual(ast.indexSignatures.length, 1)
      strictEqual(indexSignature.parameter, Schema.String.ast)
      strictEqual(indexSignature.type, Schema.Number.ast)
    })
  })

  describe("IndexSignature", () => {
    it("accepts valid parameters on both type and encoded side", () => {
      doesNotThrow(() => new SchemaAST.IndexSignature(Schema.String.ast, Schema.Number.ast))
      doesNotThrow(() => new SchemaAST.IndexSignature(Schema.NumberFromString.ast, Schema.Number.ast))
      doesNotThrow(() =>
        new SchemaAST.IndexSignature(
          Schema.Union([Schema.String, Schema.NumberFromString]).ast,
          Schema.Number.ast
        )
      )
    })

    it("rejects invalid type side parameters", () => {
      throws(
        () => new SchemaAST.IndexSignature(Schema.Literal("a").ast, Schema.Number.ast),
        new Error("Invalid index signature parameter Literal")
      )
    })

    it("rejects invalid encoded side parameters", () => {
      const StringFromBoolean = Schema.Boolean.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((b: boolean) => globalThis.String(b)),
          encode: SchemaGetter.transform((s: string) => s === "true")
        })
      )
      throws(
        () => new SchemaAST.IndexSignature(StringFromBoolean.ast, Schema.Number.ast),
        new Error("Invalid index signature parameter String")
      )
    })
  })
})
