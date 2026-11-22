import { assert, describe, it } from "@effect/vitest"
import { code, importNamespace, Module } from "effect/Codegen"
import { parse } from "effect/internal/schema/codeExpression"

describe("code generation expressions", () => {
  it("rewrites namespace references inside arguments without rewriting members, keys or text", () => {
    const module = new Module()
    module.declare("Tools")
    const references = new Map([
      ["Tools", importNamespace("tools", "Tools")],
      ["Other", importNamespace("other", "Other")]
    ])
    const source =
      "Tools.api({ Tools: \"Tools.api\", nested: Other.value(), Tools }, /* Tools.api */ new globalThis.Date(0)).Tools()"
    const output = module.finalize([parse(source, references, "runtime")])
    assert.deepStrictEqual(output.roots, [
      "Tools1.api({ Tools: \"Tools.api\", nested: Other.value(), Tools: Tools1 }, /* Tools.api */ new globalThis.Date(0)).Tools()"
    ])
    assert.deepStrictEqual(output.imports, ["import * as Tools1 from \"tools\"", "import * as Other from \"other\""])
  })

  it("inserts supplied fragments without parsing or renaming their contents", () => {
    const module = new Module()
    const Option = module.declare("Option")
    const imported = importNamespace("effect/Option", "Option")
    const references = new Map([
      ["Option", imported],
      ["ARG", code`readonly [${Option}, \`value-\${string}\`]`]
    ])
    const output = module.finalize([parse("Option.Option<ARG>", references, "Type")])
    assert.deepStrictEqual(output.roots, ["Option1.Option<readonly [Option, `value-${string}`]>"])
  })

  it("preserves escaped strings, numeric literals and comments when renaming references", () => {
    const module = new Module()
    module.declare("Tools")
    const references = new Map([["Tools", importNamespace("tools", "Tools")]])
    const source = String.raw`Tools.api("\x54ools", 'a\'b', 0xffn, .5e+2) /* Tools */`
    assert.deepStrictEqual(module.finalize([parse(source, references, "runtime")]).roots, [
      String.raw`Tools1.api("\x54ools", 'a\'b', 0xffn, .5e+2) /* Tools */`
    ])
  })

  it("supports nested calls, literal arguments and the generated type forms", () => {
    const module = new Module()
    const references = new Map()
    const runtime = "Schema.makeFilter(() => true).annotate({ ...metadata, example: [-1, 2n, true, null] })"
    const Type = "{ readonly value?: globalThis.ReadonlyArray<string | number> } & { readonly [key: string]: unknown }"
    assert.deepStrictEqual(
      module.finalize([parse(runtime, references, "runtime"), parse(Type, references, "Type")]).roots,
      [runtime, Type]
    )
  })

  it("rejects unsupported syntax instead of guessing about local bindings", () => {
    for (
      const runtime of [
        "((Tools) => Tools.api())(value)",
        "function () {}",
        "Tools.api(`text`)",
        "Tools.api(); other()",
        String.raw`Tools.api({ \u0054ools })`,
        "Tools.api(/* unterminated"
      ]
    ) {
      assert.throws(() => parse(runtime, new Map(), "runtime"), "Unsupported runtime syntax")
    }
    assert.throws(() => parse("T extends U ? A : B", new Map(), "Type"), "Unsupported Type syntax")
  })
})
