import { Schema, SchemaAST } from "effect"
import { describe, it } from "vitest"
import { deepStrictEqual, strictEqual } from "../utils/assert.ts"

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
    strictEqual(SchemaAST.isJson([1, undefined]), false)
    strictEqual(SchemaAST.isJson([1, 1n]), false)
    strictEqual(SchemaAST.isJson({}), true)
    strictEqual(SchemaAST.isJson({ a: 1 }), true)
    strictEqual(SchemaAST.isJson({ a: undefined }), false)
    strictEqual(SchemaAST.isJson({ a: 1, b: 1n }), false)
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
    strictEqual(SchemaAST.isStringTree({}), true)
    strictEqual(SchemaAST.isStringTree({ a: "b" }), true)
    strictEqual(SchemaAST.isStringTree({ a: undefined }), true)
    strictEqual(SchemaAST.isStringTree({ a: "b", c: 1 }), false)
    // nested
    strictEqual(SchemaAST.isStringTree({ a: { b: "c" } }), true)
    strictEqual(SchemaAST.isStringTree({ a: ["b", { c: "d" }] }), true)
    strictEqual(SchemaAST.isStringTree({ a: { b: 1 } }), false)
    // circular reference
    const circular: Record<string, unknown> = {}
    circular.self = circular
    strictEqual(SchemaAST.isStringTree(circular), false)
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

    it("ErrorClass", () => {
      class E extends Schema.ErrorClass<E>("E")({
        type: Schema.Literal("E"),
        e: Schema.String
      }) {}
      const ast = E.ast
      deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "type", literal: "E" }])
    })

    it("TaggedErrorClass", () => {
      class E extends Schema.TaggedErrorClass<E>()("E", {
        e: Schema.String
      }) {}
      const ast = E.ast
      deepStrictEqual(SchemaAST.collectSentinels(ast), [{ key: "_tag", literal: "E" }])
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
  })

  describe("getIndexSignatureKeys", () => {
    it("String", () => {
      const sym = Symbol.for("sym")
      const input: { readonly [x: PropertyKey]: number } = { a: 1, b: 2, [sym]: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.String.ast), ["a", "b"])
    })

    it("TemplateLiteral", () => {
      const schema = Schema.TemplateLiteral(["a"])
      const input = { a: 1, ab: 2, b: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, schema.ast), ["a"])
    })

    it("Symbol", () => {
      const a = Symbol.for("a")
      const b = Symbol.for("b")
      const input: { readonly [x: PropertyKey]: number } = { c: 1, [a]: 2, [b]: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.Symbol.ast), [a, b])
    })

    it("Number", () => {
      const input = { "1": 1, "1.5": 2, "-2": 3, a: 4, NaN: 5 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.Number.ast), ["1", "1.5", "-2", "NaN"])
    })

    it("Union", () => {
      const schema = Schema.Union([Schema.Symbol, Schema.Number])
      const sym = Symbol.for("sym")
      const input: { readonly [x: PropertyKey]: number } = { "1": 1, b: 2, [sym]: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, schema.ast), [sym, "1"])
    })

    it("default", () => {
      const sym = Symbol.for("sym")
      const input: { readonly [x: PropertyKey]: number } = { a: 1, b: 2, [sym]: 3 }
      deepStrictEqual(SchemaAST.getIndexSignatureKeys(input, Schema.ObjectKeyword.ast), [])
    })
  })
})
