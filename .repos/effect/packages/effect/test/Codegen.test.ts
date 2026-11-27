import { afterAll, assert, describe, it } from "@effect/vitest"
import {
  code,
  deferred,
  docComment,
  importDefault,
  importNamed,
  importNamespace,
  indent,
  join,
  literal,
  Module,
  propertyKey
} from "effect/Codegen"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaRepresentation from "effect/SchemaRepresentation"
import { checkGeneratedModules, withGeneratedModule } from "./utils/generatedModule.ts"

describe("schema code generation", () => {
  const sources = new Map<string, string>()
  afterAll(() => checkGeneratedModules(sources), 60_000)

  it("shares names, imports and symbol identities with the rest of the module", async () => {
    const key = Symbol("key")
    const schema = Schema.Struct({
      [key]: Schema.Option(Schema.String),
      n: Schema.Int,
      state: Schema.Enum({ Red: 1, Blue: 2 })
    }).annotate({ identifier: "Root" })
    const document = SchemaRepresentation.toRepresentations([schema.ast, Schema.Number.ast, Schema.String.ast])
    const input = {
      Root: document.representations[0],
      "1": document.representations[1],
      "user-id": document.representations[2]
    }
    const module = new Module()
    const helper = module.declare("Root")
    module.define(helper, [code`export const ${helper} = 0`])
    const same = SchemaRepresentation.toRepresentation(Schema.UniqueSymbol(key).ast)
    module.addSchemas({ SymbolType: same.representation }, { references: same.references, typeOnly: true })
    const schemas = module.addSchemas(input, { references: document.references })
    const root = schemas.get("Root")!
    assert.strictEqual(root.name, "Root1")
    const consumer = module.declare("Consumer")
    module.define(consumer, [code`export const ${consumer} = ${root}`], [root])
    module.addSchemas({ Same: same.representation }, { references: same.references })
    for (const name of ["Schema", "Option"]) {
      const local = module.declare(name)
      module.define(local, [code`export const ${local} = 0`])
    }
    const source = module.print()
    sources.set("schemas", source)
    await withGeneratedModule<Record<string, any>>(source, (generated) => {
      const rootSchema = generated[root.name]
      assert.strictEqual(generated.Consumer, rootSchema)
      assert.strictEqual(generated.Schema, 0)
      assert.strictEqual(generated.Option, 0)
      const keys = Object.getOwnPropertySymbols(rootSchema.fields)
      assert.lengthOf(keys, 1)
      assert.isTrue(Schema.is(generated.Same)(keys[0]))
      const value = { [keys[0]]: Option.some("ok"), n: 1, state: 1 }
      assert.deepStrictEqual(Schema.decodeUnknownSync(rootSchema)(value), value)
      assert.isFalse(Schema.is(rootSchema)({ ...value, n: 1.5 }))
      const number = generated[schemas.get("1")!.name]
      const string = generated[schemas.get("user-id")!.name]
      assert.isTrue(Schema.is(number)(42))
      assert.isFalse(Schema.is(number)("42"))
      assert.isTrue(Schema.is(string)("ok"))
      assert.isFalse(Schema.is(string)(42))
    })

    const types = new Module()
    types.addSchemas(input, { references: document.references, typeOnly: true })
    const typeSource = types.print()
    assert.notInclude(typeSource, "Schema.Struct")
    assert.include(typeSource, "declare enum")
    assert.include(typeSource, "declare const")
    sources.set("types", typeSource)
  })

  it("preserves recursive schemas and initializes their eager consumers", async () => {
    interface Tree {
      readonly children: ReadonlyArray<Tree>
    }
    const tree: Schema.Codec<Tree> = Schema.Struct({
      children: Schema.Array(Schema.suspend(() => tree))
    }).annotate({ identifier: "Tree" })
    const document = SchemaRepresentation.toRepresentations([Schema.Array(tree).ast, tree.ast])
    const module = new Module()
    const schemas = module.addSchemas({
      Forest: document.representations[0],
      Tree: document.representations[1]
    }, { references: document.references })
    const source = module.print()
    sources.set("recursive", source)
    await withGeneratedModule<Record<string, Schema.Codec<unknown>>>(source, (generated) => {
      const value = { children: [{ children: [] }] }
      assert.deepStrictEqual(Schema.decodeUnknownSync(generated[schemas.get("Forest")!.name])([value]), [value])
      assert.isFalse(Schema.is(generated[schemas.get("Tree")!.name])({ children: [null] }))
    })
  })
})

describe("module code generation", () => {
  it("keeps independently created modules isolated", () => {
    const first = new Module()
    const second = new Module()
    const a = first.declare("A")
    const b = second.declare("A")
    assert.strictEqual(first.define(a, [code`const ${a} = 1`]), first)
    second.define(b, [code`const ${b} = 2`])

    assert.strictEqual(first.print(), "const A = 1\n")
    assert.strictEqual(second.print(), "const A = 2\n")
    assert.throws(() => second.define(a, ["1"]), "Expected a declaration binding owned by this module")
    assert.throws(() => second.declare("x", { scope: first.scope() }), "Scope belongs to another module")
  })

  it("can keep accumulating after finalization without changing previous output", () => {
    const module = new Module()
    const tools = importNamespace("tools", "Tools")
    module.add(code`use(${tools}.value)`)
    const first = module.finalize()

    const local = module.declare("Tools")
    module.define(local, [code`const ${local} = 1`])
    const second = module.finalize()

    assert.deepStrictEqual(first.imports, ["import * as Tools from \"tools\""])
    assert.deepStrictEqual(first.body, ["use(Tools.value)"])
    assert.deepStrictEqual(first.declarations, [])
    assert.isFalse(first.names.has(local))
    assert.strictEqual(first.names.get(tools), "Tools")
    assert.deepStrictEqual(second.imports, ["import * as Tools1 from \"tools\""])
    assert.deepStrictEqual(second.body, ["use(Tools1.value)"])
    assert.deepStrictEqual(second.declarations.map((declaration) => declaration.fragments), [["const Tools = 1"]])
    assert.strictEqual(second.names.get(tools), "Tools1")
  })

  it("resolves bindings and dependency order without changing literal text", () => {
    const module = new Module()
    const child = module.declare("Option")
    const parent = module.declare("await")
    assert.throws(() => String(child), "Code fragments must be rendered by their module")
    const imported = module.addImport({
      module: "effect/Option",
      kind: "Namespace",
      imported: "*",
      local: "Option",
      typeOnly: false,
      attributes: ""
    })
    module.define(parent, [code`const ${parent} = ${imported}.some(${child})`], [child, imported])
    module.define(child, [code`const ${child} = { Option: "Option" }`])
    const output = module.finalize([parent])
    assert.deepStrictEqual(output.declarations.map((declaration) => declaration.fragments), [
      ["const Option = { Option: \"Option\" }"],
      ["const await1 = Option1.some(Option)"]
    ])
    assert.deepStrictEqual(output.roots, ["await1"])
  })

  it("renders shared fragments once per finalization", () => {
    const module = new Module()
    let calls = 0
    const shared = deferred(() => {
      calls++
      return "value"
    })
    let fragment = shared
    for (let i = 0; i < 12; i++) fragment = code`${fragment}${fragment}`
    assert.strictEqual(module.finalize([fragment]).roots[0], "value".repeat(4096))
    assert.strictEqual(calls, 1)
    assert.strictEqual(module.finalize([fragment]).roots[0], "value".repeat(4096))
    assert.strictEqual(calls, 2)
  })

  it("rejects eager cycles and distinguishes imports requesting the same name", () => {
    const module = new Module()
    const a = module.declare("A")
    const b = module.declare("B")
    module.define(a, [b], [b])
    module.define(b, [a], [a])
    assert.throws(() => module.finalize([]), "Cyclic initialization dependency")

    const input = {
      module: "one",
      kind: "Namespace" as const,
      imported: "*",
      local: "Value",
      typeOnly: false,
      attributes: ""
    }
    const imports = new Module()
    const first = imports.addImport(input)
    assert.strictEqual(first, imports.addImport(input))
    const second = imports.addImport({ ...input, module: "two" })
    const output = imports.finalize([code`${first}.value + ${second}.value`])
    assert.deepStrictEqual(output.roots, ["Value.value + Value1.value"])
    assert.deepStrictEqual(output.imports, ["import * as Value from \"one\"", "import * as Value1 from \"two\""])
  })

  it("shares import symbols across modules and prints without mutating names", () => {
    const Effect = importNamespace("effect/Effect", "Effect")
    assert.throws(() => String(Effect), "Code fragments must be rendered by their module")
    for (const collision of [true, false]) {
      const module = new Module()
      if (collision) module.declare("Effect", { exact: true })
      module.add(code`export const one = ${Effect}.succeed(1)`)
      const name = collision ? "Effect1" : "Effect"
      const expected = `import * as ${name} from "effect/Effect"\n\nexport const one = ${name}.succeed(1)\n`
      assert.strictEqual(module.print(), expected)
      assert.strictEqual(module.print(), expected)
    }
    const first = new Module()
    const local = first.declare("Local")
    assert.throws(() => new Module().finalize([local]), "Binding belongs to another module")
  })

  it("emits only used imports, groups named imports, and promotes type imports", () => {
    const module = new Module()
    assert.strictEqual(module.addSideEffect("./setup.ts").addSideEffect("./setup.ts"), module)
    module.addImport({
      module: "unused",
      kind: "Namespace",
      imported: "*",
      local: "Unused",
      typeOnly: false,
      attributes: ""
    })
    const type = importNamed("effect/Option", "Option", { typeOnly: true })
    const some = importNamed("effect/Option", "some")
    const EffectType = importNamespace("effect/Effect", "Effect", { typeOnly: true })
    const EffectValue = importNamespace("effect/Effect", "OtherName")
    const defaultType = importDefault("example", "Example", { typeOnly: true })
    const output = module.finalize([code`${type} ${some} ${EffectType} ${EffectValue} ${defaultType}`])
    assert.deepStrictEqual(output.imports, [
      "import \"./setup.ts\"",
      "import { type Option, some } from \"effect/Option\"",
      "import * as Effect from \"effect/Effect\"",
      "import type Example from \"example\""
    ])
    assert.deepStrictEqual(output.roots, ["Option some Effect Effect Example"])
  })

  it("keeps exact names and prevents shadowing along nested scopes", () => {
    const module = new Module(["Client"])
    const outer = module.scope()
    const inner = module.scope(outer)
    const sibling = module.scope()
    const bindings = [
      module.declare("x", { scope: inner }),
      module.declare("x", { scope: outer }),
      module.declare("x"),
      module.declare("x", { scope: sibling }),
      module.declare("user-id"),
      module.declare("globalThis")
    ]
    assert.deepStrictEqual(module.finalize(bindings).roots, ["x", "x1", "x2", "x", "user_id", "globalThis1"])
    for (const name of ["Client", "x", "default", "invalid-name"]) {
      assert.throws(() => module.declare(name, { exact: true }), "Cannot declare exact name")
    }
    const name = module.declare("invalid_name", { exact: true })
    assert.strictEqual(name.name, "invalid_name")
    assert.deepStrictEqual(module.finalize([name]).roots, ["invalid_name"])
  })

  it("formats literals, keys, documentation, and indented fragments", () => {
    assert.deepStrictEqual(["a\"b", -0, NaN, Infinity, -Infinity, -12n, true, null, undefined].map(literal), [
      "\"a\\\"b\"",
      "-0",
      "globalThis.NaN",
      "globalThis.Infinity",
      "-globalThis.Infinity",
      "-12n",
      "true",
      "null",
      "undefined"
    ])
    assert.deepStrictEqual(["default", "$é", "user-id", "__proto__"].map(propertyKey), [
      "default",
      "$é",
      "\"user-id\"",
      "[\"__proto__\"]"
    ])
    assert.strictEqual(docComment("one */"), "/** one *\\/ */\n")
    assert.strictEqual(docComment(" \n"), "")
    const module = new Module()
    assert.deepStrictEqual(module.finalize([code`values ${[1, null, undefined, false, ["ok"]]}`]).roots, [
      "values 1ok"
    ])
    const fields = join([code`${docComment(["A user.", "", "Has an id."])}id: string`, "age: number"], "\n")
    assert.strictEqual(module.add(code`interface User {${indent(code`\n${fields}`)}\n}`), module)
    assert.strictEqual(
      module.print(),
      "interface User {\n  /**\n   * A user.\n   *\n   * Has an id.\n   */\n  id: string\n  age: number\n}\n"
    )
    assert.throws(() => String(fields), "Code fragments must be rendered by their module")
  })
})
