import { extractJSDocsSync, parseJSDoc } from "@effect/jsdocs"
import { assert, describe, it } from "@effect/vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("jsdocs", () => {
  it("parses a raw JSDoc block", () => {
    const result = parseJSDoc(`/**
 * Creates a value.
 *
 * @category constructors
 * @since 1.0.0
 */`)
    assert.strictEqual(result._tag, "Success")
    if (result._tag === "Success") {
      assert.strictEqual(result.value.description.short, "Creates a value.")
    }
  })

  it("accepts practical When to use forms", () => {
    const result = parseJSDoc(`/**
 * Creates a value.
 *
 * **When to use**
 *
 * Use to create a value when construction should be explicit.
 *
 * @category constructors
 * @since 1.0.0
 */`)
    assert.strictEqual(result._tag, "Success")
    if (result._tag === "Success") {
      assert.strictEqual(
        result.value.description.whenToUse,
        "Use to create a value when construction should be explicit."
      )
    }
  })

  it("flags unsupported When to use forms", () => {
    const result = parseJSDoc(`/**
 * Creates a value.
 *
 * **When to use**
 *
 * - Creating a value when construction should be explicit.
 *
 * @category constructors
 * @since 1.0.0
 */`)
    assert.strictEqual(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.deepStrictEqual(
        result.error.diagnostics.map((diagnostic) => diagnostic.code),
        ["when-to-use-format"]
      )
    }
  })

  it("extracts docs with TypeScript", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * Creates a value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeValue = () => 1
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    assert.strictEqual(model.version, 2)
    assert.strictEqual(model.files.length, 1)
    assert.strictEqual(model.files[0]?.declarations[0]?.name, "makeValue")
    assert.strictEqual(model.apis[0]?.apiFqn, "@effect/sample/Foo.makeValue")
    assert.deepStrictEqual(model.apis[0]?.importGuidance, {
      style: "namespace-barrel",
      importDeclaration: "import { Foo } from \"@effect/sample\"",
      usage: "Foo.makeValue"
    })
  })

  it("stores valid top-of-file module JSDoc", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * The Foo module provides helpers for sample values. Use {@link makeValue} to
 * create the default value.
 *
 * **Example** (Using the module)
 *
 * \`\`\`ts
 * import { Foo } from "@effect/sample"
 *
 * Foo.makeValue()
 * \`\`\`
 *
 * @see {@link makeValue}
 * @since 1.0.0
 */
import type { Buffer } from "node:buffer"

/**
 * Creates a value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeValue = () => 1
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    assert.strictEqual(model.files[0]?.moduleJSDoc?.raw.includes("The Foo module provides helpers"), true)
    assert.deepStrictEqual(model.files[0]?.diagnostics, [])
  })

  it("does not treat the first exported declaration JSDoc as module JSDoc", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * Creates a value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeValue = () => 1
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    assert.strictEqual(model.files[0]?.moduleJSDoc, undefined)
    assert.deepStrictEqual(model.files[0]?.diagnostics, [])
  })

  it("flags inline links that TypeScript does not bind", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(path.join(cwd, "src/Schema.ts"), `export {}\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * Creates a value with the {@link Schema} module.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeValue = () => 1
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    assert.deepStrictEqual(
      model.files[0]?.diagnostics.map((diagnostic) => diagnostic.code),
      ["unresolved-link"]
    )
    assert.deepStrictEqual(
      model.files[0]?.diagnostics.map((diagnostic) => diagnostic.message),
      ["Unresolved JSDoc inline link: {@link Schema}"]
    )
  })

  it("flags module JSDoc tag, example, and public @see diagnostics", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * The Foo module provides helpers.
 *
 * \`\`\`ts
 * const value = 1
 * \`\`\`
 *
 * @see {@link Hidden}
 */
import type { Buffer } from "node:buffer"

class Hidden {}

/**
 * Creates a value.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeValue = () => 1
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    assert.deepStrictEqual(
      model.files[0]?.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      ["loose-ts-fence", "missing-tag", "public-see-target"].sort()
    )
    assert.strictEqual(model.files[0]?.moduleJSDoc?.raw.includes("The Foo module provides helpers"), true)
  })

  it("flags @see links to targets without public JSDoc", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * A documented container.
 *
 * @category models
 * @since 1.0.0
 */
export interface Box {
  documented: string
  hidden: string
}

/**
 * Uses the hidden member.
 *
 * @see {@link Box.hidden}
 * @category constructors
 * @since 1.0.0
 */
export const useHidden = () => undefined
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    assert.deepStrictEqual(
      model.files[0]?.diagnostics.map((diagnostic) => diagnostic.code),
      ["undocumented-see-target"]
    )
    assert.deepStrictEqual(model.files[0]?.imports?.barrel, {
      type: "namespace",
      module: "@effect/sample",
      name: "Foo"
    })
  })

  it("resolves @see links through TypeScript symbols before local-name lookup", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(
      path.join(cwd, "src/index.ts"),
      `export * as Eq from "./Eq.ts"\nexport * as Ordering from "./Ordering.ts"\nexport * as Reducer from "./Reducer.ts"\n`
    )
    fs.writeFileSync(
      path.join(cwd, "src/Reducer.ts"),
      `/**
 * A reusable reducer.
 *
 * @category models
 * @since 1.0.0
 */
export interface Reducer {
  /**
   * Combines two values.
   */
  combine: string
}
`
    )
    fs.writeFileSync(
      path.join(cwd, "src/Ordering.ts"),
      `/**
 * Ordering reducer value.
 *
 * @category constants
 * @since 1.0.0
 */
export const Reducer = "ordering"
`
    )
    fs.writeFileSync(
      path.join(cwd, "src/Eq.ts"),
      `import * as Reducer from "./Reducer.ts"

/**
 * Creates an equivalence reducer.
 *
 * @see {@link Reducer}
 * @category constructors
 * @since 1.0.0
 */
export const makeReducer = () => Reducer
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    const makeReducer = model.apis.find((api) => api.apiFqn === "@effect/sample/Eq.makeReducer")
    const link = makeReducer?.see[0]?.links[0]
    assert.deepStrictEqual(model.files.flatMap((file) => file.diagnostics), [])
    assert.deepStrictEqual(link?.resolution, {
      _tag: "Resolved",
      apiId: "root-declaration:type:@effect/sample/Reducer.Reducer",
      apiFqn: "@effect/sample/Reducer.Reducer"
    })
  })

  it("flags @see links to targets outside the public JSDoc API model", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * Private helper.
 *
 * @category models
 * @since 1.0.0
 */
class Hidden {}

/**
 * Uses a hidden helper.
 *
 * @see {@link Hidden}
 * @category constructors
 * @since 1.0.0
 */
export const useHidden = () => Hidden
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    assert.deepStrictEqual(
      model.files[0]?.diagnostics.map((diagnostic) => diagnostic.code),
      ["public-see-target"]
    )
    assert.deepStrictEqual(
      model.files[0]?.diagnostics.map((diagnostic) => diagnostic.message),
      [
        "@see link {@link Hidden} does not resolve to a public JSDoc API. Check that the target is exported and has valid public JSDoc."
      ]
    )
  })

  it("keeps valid APIs from files with diagnostics for @see resolution", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(
      path.join(cwd, "src/index.ts"),
      `export * as Bar from "./Bar.ts"\nexport * as Foo from "./Foo.ts"\n`
    )
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * Target value.
 *
 * @category constants
 * @since 1.0.0
 */
export const Target = "target"

/**
 * Broken value.
 *
 * **Example**
 *
 * \`\`\`ts
 * const value = "broken"
 * \`\`\`
 *
 * @category constants
 * @since 1.0.0
 */
export const Broken = "broken"
`
    )
    fs.writeFileSync(
      path.join(cwd, "src/Bar.ts"),
      `import * as Foo from "./Foo.ts"

/**
 * Uses the target value.
 *
 * @see {@link Foo.Target} for the target value
 * @category constants
 * @since 1.0.0
 */
export const useTarget = () => Foo.Target
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    const foo = model.files.find((file) => file.file === "src/Foo.ts")
    const bar = model.files.find((file) => file.file === "src/Bar.ts")
    assert.deepStrictEqual(
      foo?.diagnostics.map((diagnostic) => diagnostic.code),
      ["malformed-example"]
    )
    assert.deepStrictEqual(bar?.diagnostics, [])
    assert.strictEqual(
      model.apis.some((api) => api.apiFqn === "@effect/sample/Foo.Target"),
      true
    )
  })

  it("resolves @see links to aliased export specifiers", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-"))
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"]
      })
    )
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "@effect/sample",
        type: "module",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      })
    )
    fs.writeFileSync(path.join(cwd, "src/index.ts"), `export * as Foo from "./Foo.ts"\n`)
    fs.writeFileSync(
      path.join(cwd, "src/Foo.ts"),
      `/**
 * @since 1.0.0
 */
const Array_ = "array"

export {
  /**
   * Public array helper.
   *
   * @category constructors
   * @since 1.0.0
   */
  Array_ as Array
}

/**
 * Public tuple helper.
 *
 * @see {@link Array_}
 * @see {@link Array}
 * @category constructors
 * @since 1.0.0
 */
export const Tuple = Array
`
    )
    const model = extractJSDocsSync({
      cwd,
      tsconfig: "tsconfig.json",
      include: ["src/**/*.ts"],
      output: ".data/jsdocs.json"
    })
    const tuple = model.apis.find((api) => api.apiFqn === "@effect/sample/Foo.Tuple")
    const links = tuple?.see.flatMap((tag) => tag.links) ?? []
    assert.deepStrictEqual(model.files.flatMap((file) => file.diagnostics), [])
    assert.deepStrictEqual(links.map((link) => link.resolution), [{
      _tag: "Resolved",
      apiId: "root-declaration:value:@effect/sample/Foo.Array",
      apiFqn: "@effect/sample/Foo.Array"
    }, {
      _tag: "Resolved",
      apiId: "root-declaration:value:@effect/sample/Foo.Array",
      apiFqn: "@effect/sample/Foo.Array"
    }])
  })
})
