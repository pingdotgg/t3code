import rule from "@effect/oxc/oxlint/rules/jsdocs"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { createTestContext } from "./utils.ts"

function hash(source: string): string {
  return crypto.createHash("sha256").update(source).digest("hex")
}

function run(source: string, cwd: string, filename: string, model = ".data/jsdocs.json") {
  const { context, errors } = createTestContext({ sourceCode: source, cwd, filename, ruleOptions: [{ model }] })
  const visitors = rule.create(context as never)
  visitors.Program?.({ type: "Program", range: [0, source.length] } as never)
  return errors
}

describe("jsdocs", () => {
  it("skips when the model is missing", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-rule-"))
    const errors = run("export const a = 1\n", cwd, path.join(cwd, "src/Foo.ts"))
    expect(errors).toEqual([])
  })

  it("reports invalid model files", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-rule-"))
    fs.mkdirSync(path.join(cwd, ".data"), { recursive: true })
    fs.writeFileSync(path.join(cwd, ".data/jsdocs.json"), "{")
    const errors = run("export const a = 1\n", cwd, path.join(cwd, "src/Foo.ts"))
    expect(errors.map((error) => error.message)).toEqual([expect.stringContaining("Invalid jsdocs model")])
  })

  it("reports stale model files", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-rule-"))
    fs.mkdirSync(path.join(cwd, ".data"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, ".data/jsdocs.json"),
      JSON.stringify({
        version: 2,
        generatedBy: "@effect/jsdocs",
        generatedAt: "now",
        files: [{ file: "src/Foo.ts", hash: "old", diagnostics: [], declarations: [], namespaces: [] }],
        apis: []
      })
    )
    const errors = run("export const a = 1\n", cwd, path.join(cwd, "src/Foo.ts"))
    expect(errors.map((error) => error.message)).toEqual(["JSDoc model is stale for this file; run `pnpm jsdocs`"])
  })

  it("reports model diagnostics", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jsdocs-rule-"))
    const source = "export const a = 1\n"
    fs.mkdirSync(path.join(cwd, ".data"), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, ".data/jsdocs.json"),
      JSON.stringify({
        version: 2,
        generatedBy: "@effect/jsdocs",
        generatedAt: "now",
        apis: [],
        files: [{
          file: "src/Foo.ts",
          hash: hash(source),
          diagnostics: [{ code: "missing-jsdoc", message: "Public JSDoc is required", range: [0, 6] }],
          declarations: [],
          namespaces: []
        }]
      })
    )
    const errors = run(source, cwd, path.join(cwd, "src/Foo.ts"))
    expect(errors.map((error) => error.message)).toEqual(["Public JSDoc is required"])
  })
})
