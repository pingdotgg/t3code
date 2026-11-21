import { assert } from "@effect/vitest"
import { Exit, Option } from "effect"
import type * as Schema from "effect/Schema"
import type * as SchemaJITCompiler from "effect/schema/SchemaJITCompiler"
import { describe, expect, it, vi } from "vitest"

const SCHEMA_MODULE_PATH = "../../src/Schema.ts"

describe("HMR", () => {
  it("sanity check: reload produces distinct constructors", async () => {
    const PATH = "./fixtures/HMR-sanity-check.ts"
    const mod1: any = await vi.importActual(PATH)
    vi.resetModules()
    const mod2: any = await vi.importActual(PATH)

    const a = new mod1.A("a")
    expect(a instanceof mod1.A).toBe(true)

    expect(a instanceof mod2.A).toBe(false)
  })

  it("isAST", async () => {
    const SCHEMA_AST_MODULE_PATH = "../../src/SchemaAST.ts"
    const mod1: any = await vi.importActual(SCHEMA_AST_MODULE_PATH)
    vi.resetModules()
    const mod2: any = await vi.importActual(SCHEMA_AST_MODULE_PATH)

    const isAST = mod1.isAST

    const b = mod2.unknown

    expect(isAST(b)).toBe(true)
  })

  it("isSchema", async () => {
    const mod1: any = await vi.importActual(SCHEMA_MODULE_PATH)
    vi.resetModules()
    const mod2: any = await vi.importActual(SCHEMA_MODULE_PATH)

    const isSchema = mod1.isSchema

    const schema = mod2.Unknown

    expect(isSchema(schema)).toBe(true)
  })

  it("isSchemaError", async () => {
    const mod1: any = await vi.importActual(SCHEMA_MODULE_PATH)
    vi.resetModules()
    const mod2: any = await vi.importActual(SCHEMA_MODULE_PATH)

    const exit = mod1.decodeUnknownExit(mod1.String)(null)
    expect(Exit.isFailure(exit)).toBe(true)
    const o: any = Exit.findErrorOption(exit)
    expect(Option.isSome(o)).toBe(true)
    const schemaError = o.value
    expect(mod2.isSchemaError(schemaError)).toBe(true)
  })

  it("parses fields from another module copy", async () => {
    const mod1 = await vi.importActual<typeof Schema>(SCHEMA_MODULE_PATH)
    vi.resetModules()
    const mod2 = await vi.importActual<typeof Schema>(SCHEMA_MODULE_PATH)

    const encode = mod2.encodeSync(mod2.Struct({ a: mod1.optionalKey(mod1.String) }))
    expect(encode({ a: "" })).toStrictEqual({ a: "" })
    expect(encode({})).toStrictEqual({})
  })

  it.each(["interpreted", "compiled"])("preserves foreign parser outputs with %s consumers", async (mode) => {
    const mod1 = await vi.importActual<typeof Schema>(SCHEMA_MODULE_PATH)
    vi.resetModules()
    const mod2 = await vi.importActual<typeof Schema>(SCHEMA_MODULE_PATH)
    const compiler = mode === "compiled"
      ? await vi.importActual<typeof SchemaJITCompiler>("../../src/schema/SchemaJITCompiler.ts")
      : undefined
    const taggedData = { [Symbol.for("effect/schema/parser/missing")]: true }
    const cases: ReadonlyArray<{ readonly schema: Schema.Codec<unknown>; readonly input: unknown }> = [
      { schema: mod1.String, input: "" },
      { schema: mod1.Boolean, input: false },
      { schema: mod1.Number, input: -0 },
      { schema: mod1.Literal(0), input: -0 },
      { schema: mod1.Unknown, input: undefined },
      { schema: mod1.Unknown, input: null },
      { schema: mod1.Unknown, input: taggedData },
      { schema: mod2.Struct({ a: mod1.optionalKey(mod1.String) }), input: {} },
      { schema: mod2.Struct({ a: mod1.optionalKey(mod1.String) }), input: { a: "" } },
      { schema: mod2.Struct({ a: mod1.optionalKey(mod1.Unknown) }), input: { a: undefined } },
      { schema: mod2.Struct({ a: mod1.Unknown }), input: { a: taggedData } },
      { schema: mod2.Array(mod1.Number), input: [-0, 0, 1] }
    ]
    for (const { input, schema } of cases) {
      compiler?.enable(schema.ast)
      compiler?.enable(mod2.flip(schema).ast)
      assert.deepStrictEqual(mod2.decodeUnknownSync(schema)(input), input)
      assert.deepStrictEqual(mod2.encodeUnknownSync(schema)(input), input)
    }
  })

  it("Schema.Class", async () => {
    const PATH = "./fixtures/HMR-Class.ts"
    const mod1: any = await vi.importActual(PATH)
    vi.resetModules()
    const mod2: any = await vi.importActual(PATH)
    const schema: any = await vi.importActual(SCHEMA_MODULE_PATH)

    const a = new mod1.A({ a: "a" })
    expect(a instanceof mod1.A).toBe(true)

    const b = new mod2.A({ a: "a" })

    expect(b instanceof mod1.A).toBe(false)
    expect(String(schema.encodeUnknownExit(mod1.A)(b))).toBe(`Success({"a":"a"})`)
    expect(mod1.A.make(b)).toBe(b)

    const nested = schema.Struct({ rows: schema.Array(mod1.A) })
    expect(nested.make({ rows: [b] }).rows[0]).toBe(b)
  })
})
